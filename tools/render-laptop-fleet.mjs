#!/usr/bin/env node
// Render and validate the dedicated three-laptop production profile without
// changing the canonical cloud topology in topology.toml.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadTopology, render } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const topologyPath = path.join(root, "laptop", "topology.toml");
const expectedProviders = ["aws", "azure", "gcp"];

function cidrRange(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be an IPv4 CIDR`);
  const [address, prefixText, extra] = value.split("/");
  const prefix = Number(prefixText);
  if (extra !== undefined || net.isIP(address) !== 4 || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
    throw new Error(`${field} must be an IPv4 CIDR with prefix 8..30, got ${JSON.stringify(value)}`);
  }
  const octets = address.split(".").map(Number);
  const numeric = octets.reduce((acc, octet) => ((acc << 8) | octet) >>> 0, 0);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const start = (numeric & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  return { value, start, end: start + size - 1 };
}

function rangesOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

function peerTag(cluster) {
  return `tag:fiducia-peer-${cluster.name.replace(/^laptop-/, "")}`;
}

function peerServiceName(kind, clusterName) {
  return `fiducia-${kind}-peer-${clusterName}`;
}

export function validateLaptopTopology(topology) {
  if (topology.cluster_id !== "fiducia-prod") {
    throw new Error("laptop profile must retain cluster_id=fiducia-prod for rolling migration");
  }
  if (topology.connectivity !== "wireguard") {
    throw new Error("laptop profile connectivity must be wireguard (Tailscale initially, plain WireGuard fallback)");
  }
  if (topology.auth_required !== true) throw new Error("laptop profile must require authentication");
  if (topology.replication_factor !== 3 || topology.cluster.length !== 3) {
    throw new Error("laptop profile requires exactly three clusters and replication_factor=3");
  }

  const providers = new Set();
  const sites = new Set();
  const apiHosts = new Set();
  const peerTags = new Set();
  const cidrs = [];

  for (const cluster of topology.cluster) {
    if (cluster.platform !== "local-laptop") throw new Error(`${cluster.name} platform must be local-laptop`);
    if (cluster.storage_class !== "local-path") throw new Error(`${cluster.name} storage_class must be local-path`);
    if (cluster.node_replicas !== 1) throw new Error(`${cluster.name} must have exactly one node replica`);
    if (cluster.brain !== true) throw new Error(`${cluster.name} must host one brain voter`);
    if (!expectedProviders.includes(cluster.synthetic_provider)) {
      throw new Error(`${cluster.name} synthetic_provider must be aws|gcp|azure`);
    }
    if (!cluster.site || sites.has(cluster.site)) throw new Error(`${cluster.name} must have a unique physical site`);
    if (!cluster.kubernetes_api_hostname || apiHosts.has(cluster.kubernetes_api_hostname)) {
      throw new Error(`${cluster.name} must have a unique kubernetes_api_hostname`);
    }
    if (!cluster.kubernetes_api_hostname.endsWith(".fiducia.internal")) {
      throw new Error(`${cluster.name} kubernetes_api_hostname must stay on private DNS`);
    }
    for (const endpoint of [cluster.brain_endpoint, cluster.node_peer_endpoint, cluster.node_api_endpoint]) {
      if (!String(endpoint).includes(".fiducia.internal:")) {
        throw new Error(`${cluster.name} internal endpoints must use private fiducia.internal DNS`);
      }
    }
    if (!cluster.lb_endpoint.startsWith("https://") || !cluster.lb_endpoint.endsWith(".laptop.fiducia.cloud")) {
      throw new Error(`${cluster.name} public endpoint must be an HTTPS laptop.fiducia.cloud hostname`);
    }
    const tag = peerTag(cluster);
    if (!/^tag:fiducia-peer-(aws|gcp|azure)-sim$/.test(tag) || peerTags.has(tag)) {
      throw new Error(`${cluster.name} must derive a unique least-privilege Tailscale peer tag`);
    }

    providers.add(cluster.synthetic_provider);
    sites.add(cluster.site);
    apiHosts.add(cluster.kubernetes_api_hostname);
    peerTags.add(tag);
    cidrs.push({ cluster: cluster.name, kind: "pod", ...cidrRange(cluster.pod_cidr, `${cluster.name}.pod_cidr`) });
    cidrs.push({ cluster: cluster.name, kind: "service", ...cidrRange(cluster.service_cidr, `${cluster.name}.service_cidr`) });
  }

  if (providers.size !== expectedProviders.length || expectedProviders.some((provider) => !providers.has(provider))) {
    throw new Error("laptop profile must model exactly aws, gcp, and azure once each");
  }
  for (let i = 0; i < cidrs.length; i++) {
    for (let j = i + 1; j < cidrs.length; j++) {
      if (rangesOverlap(cidrs[i], cidrs[j])) {
        throw new Error(`CIDR overlap: ${cidrs[i].cluster}/${cidrs[i].kind} ${cidrs[i].value} and ${cidrs[j].cluster}/${cidrs[j].kind} ${cidrs[j].value}`);
      }
    }
  }
  return topology;
}

function hostConfig(cluster) {
  return `# GENERATED by tools/render-laptop-fleet.mjs from laptop/topology.toml — do not edit.\n` +
    `# Install as /etc/rancher/k3s/config.yaml on ${cluster.name}.\n` +
    `node-name: ${cluster.name}\n` +
    `cluster-init: true\n` +
    `write-kubeconfig-mode: "0600"\n` +
    `cluster-cidr: ${cluster.pod_cidr}\n` +
    `service-cidr: ${cluster.service_cidr}\n` +
    `secrets-encryption: true\n` +
    `disable:\n` +
    `  - traefik\n` +
    `  - servicelb\n` +
    `tls-san:\n` +
    `  - ${cluster.kubernetes_api_hostname}\n` +
    `node-label:\n` +
    `  - fiducia.cloud/cluster=${cluster.name}\n` +
    `  - fiducia.cloud/substrate=laptop-k3s\n` +
    `  - fiducia.cloud/synthetic-provider=${cluster.synthetic_provider}\n` +
    `  - fiducia.cloud/site=${cluster.site}\n` +
    `etcd-snapshot-schedule-cron: "0 */6 * * *"\n` +
    `etcd-snapshot-retention: 14\n` +
    `etcd-snapshot-compress: true\n` +
    `etcd-s3: true\n` +
    `etcd-s3-config-secret: k3s-etcd-snapshot-s3-config\n`;
}

function tailnetIngress(cluster) {
  const tag = peerTag(cluster);
  return `# GENERATED by tools/render-laptop-fleet.mjs from laptop/topology.toml — do not edit.
# These are private Tailscale L3 ingress Services, not public cloud load balancers.
apiVersion: v1
kind: Service
metadata:
  name: fiducia-node-peer-tailnet
  namespace: fiducia
  annotations:
    tailscale.com/hostname: node-${cluster.name}
    tailscale.com/tags: "${tag}"
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  selector:
    app: fiducia-node
  ports:
    - { name: peer, port: 9090, targetPort: 9090, protocol: TCP }
---
apiVersion: v1
kind: Service
metadata:
  name: fiducia-brain-peer-tailnet
  namespace: fiducia
  annotations:
    tailscale.com/hostname: brain-${cluster.name}
    tailscale.com/tags: "${tag}"
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  selector:
    app: fiducia-brain
  ports:
    - { name: peer, port: 9095, targetPort: 9095, protocol: TCP }
`;
}

function egressProxyGroup(cluster) {
  const tag = peerTag(cluster);
  return `# GENERATED by tools/render-laptop-fleet.mjs from laptop/topology.toml — do not edit.
# ProxyGroup is cluster-scoped and is applied by the operator bootstrap script,
# outside the namespaced Fiducia Kustomize overlay.
apiVersion: tailscale.com/v1alpha1
kind: ProxyGroup
metadata:
  name: fiducia-egress-proxies
spec:
  type: egress
  replicas: 2
  tags:
    - "${tag}"
`;
}

export function renderLaptopFleet() {
  const topology = validateLaptopTopology(loadTopology(topologyPath));
  const files = render(topology, {
    clusterRoot: "laptop/clusters",
    edgeOutput: "laptop/generated/edge-regions.json",
    sourceName: "laptop/topology.toml",
  });

  for (const cluster of topology.cluster) {
    const envPath = `laptop/clusters/${cluster.name}/topology.properties`;
    const peers = topology.cluster.filter((candidate) => candidate.name !== cluster.name);
    const nodePeers = peers
      .map((peer) => `${peerServiceName("node", peer.name)}.fiducia.svc.cluster.local:9090`)
      .join(",");
    const brainPeers = peers
      .map((peer) => `${peerServiceName("brain", peer.name)}.fiducia.svc.cluster.local:9095`)
      .join(",");

    files[envPath] = files[envPath]
      .replace(
        `FIDUCIA_CLUSTER=${cluster.name}\n`,
        `FIDUCIA_CLUSTER=${cluster.name}\n` +
          `FIDUCIA_SUBSTRATE=laptop-k3s\n` +
          `FIDUCIA_SYNTHETIC_PROVIDER=${cluster.synthetic_provider}\n` +
          `FIDUCIA_PHYSICAL_SITE=${cluster.site}\n` +
          `FIDUCIA_TAILSCALE_PEER_TAG=${peerTag(cluster)}\n`,
      )
      .replace(/^FIDUCIA_PEERS=.*$/m, `FIDUCIA_PEERS=${nodePeers}`)
      .replace(/^FIDUCIA_BRAIN_PEERS=.*$/m, `FIDUCIA_BRAIN_PEERS=${brainPeers}`);

    files[`laptop/clusters/${cluster.name}/tailnet-ingress.yaml`] = tailnetIngress(cluster);
    files[`laptop/hosts/${cluster.name}/tailscale-egress-proxygroup.yaml`] = egressProxyGroup(cluster);
    files[`laptop/hosts/${cluster.name}/k3s-config.yaml`] = hostConfig(cluster);
  }
  return { topology, files };
}

export function syncLaptopFleet({ check = false } = {}) {
  const { files } = renderLaptopFleet();
  let drift = 0;
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    if (check) {
      const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : null;
      if (current !== content) {
        console.error(`drift: ${relativePath}`);
        drift++;
      }
      continue;
    }
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
    console.log(`wrote ${relativePath}`);
  }
  if (check && drift) throw new Error(`${drift} laptop profile file(s) stale — run: node tools/render-laptop-fleet.mjs`);
  if (check) console.log("laptop topology in sync");
}

function main() {
  try {
    syncLaptopFleet({
      check: process.argv.includes("--check") || /^(1|true|yes|on)$/i.test(process.env.FIDUCIA_RENDER_CHECK ?? ""),
    });
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
