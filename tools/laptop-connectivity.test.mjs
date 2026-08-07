import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { renderLaptopFleet } from "./render-laptop-fleet.mjs";
import {
  renderTailnetEgress,
  validateTailnetObservations,
} from "./render-laptop-tailnet-egress.mjs";
import { validateK3sS3Secret } from "./validate-k3s-s3-secret.mjs";
import { verifySnapshotEvidence } from "./verify-etcd-snapshot-evidence.mjs";
import { validateCloudflaredTokenSecret } from "./validate-cloudflared-token-secret.mjs";

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
const fixedNow = new Date("2026-08-03T16:05:00Z");
const peerTags = [
  "tag:fiducia-peer-aws-sim",
  "tag:fiducia-peer-gcp-sim",
  "tag:fiducia-peer-azure-sim",
];

function goodTailnetObservations() {
  return JSON.parse(read("laptop/network/tailnet-observations.example.json"));
}

function goodK3sS3Secret(cluster = "laptop-aws-sim") {
  return `apiVersion: v1
kind: Secret
metadata:
  name: k3s-etcd-snapshot-s3-config
  namespace: kube-system
type: etcd.k3s.cattle.io/s3-config-secret
stringData:
  etcd-s3-endpoint: "https://s3.example.net"
  etcd-s3-access-key: "AKIAVALIDEXAMPLE123"
  etcd-s3-secret-key: "not-a-real-secret-but-long-enough"
  etcd-s3-bucket: "fiducia-k3s-backups"
  etcd-s3-folder: "clusters/${cluster}"
  etcd-s3-region: "us-east-1"
  etcd-s3-skip-ssl-verify: "false"
  etcd-s3-insecure: "false"
  etcd-s3-timeout: "5m"
`;
}

function snapshotItem({
  cluster = "laptop-aws-sim",
  storage = "local",
  snapshotName = "etcd-snapshot-laptop-aws-sim-1785772800",
  size = 1048576,
  creationTime = "2026-08-03T16:00:00Z",
  tokenHash = "0123456789ab",
  skipSSLVerify = false,
} = {}) {
  const isS3 = storage === "s3";
  return {
    apiVersion: "k3s.cattle.io/v1",
    kind: "ETCDSnapshotFile",
    metadata: {
      name: `${isS3 ? "s3" : "local"}-${snapshotName}`,
      labels: {
        "etcd.k3s.cattle.io/snapshot-storage-node": isS3 ? "s3" : cluster,
      },
      annotations: {
        "etcd.k3s.cattle.io/snapshot-token-hash": tokenHash,
      },
    },
    spec: {
      snapshotName,
      nodeName: isS3 ? "s3" : cluster,
      location: isS3
        ? `s3://fiducia-k3s-backups/clusters/${cluster}/${snapshotName}`
        : `file:///var/lib/rancher/k3s/server/db/snapshots/${snapshotName}`,
      ...(isS3 ? { s3: { bucket: "fiducia-k3s-backups", region: "us-east-1", skipSSLVerify } } : {}),
    },
    status: {
      creationTime,
      readyToUse: true,
      size,
    },
  };
}

function goodSnapshotList(overrides = {}) {
  const local = snapshotItem({ ...overrides, storage: "local" });
  const s3 = snapshotItem({ ...overrides, storage: "s3" });
  return { apiVersion: "v1", kind: "List", items: [local, s3] };
}

test("tailnet policy grants only intended administration and peer ports", () => {
  const policy = JSON.parse(read("laptop/network/tailnet-policy.hujson"));
  const grants = policy.grants;
  assert.ok(Array.isArray(grants) && grants.length === 5);

  for (const grant of grants) {
    assert.equal(grant.src.includes("*"), false);
    assert.equal(grant.dst.includes("*"), false);
    assert.ok(grant.ip.every((entry) => /^tcp:\d+$/.test(entry)));
  }

  for (const tag of peerTags) {
    assert.deepEqual(policy.tagOwners[tag], ["tag:k8s-operator"]);
    const peerGrant = grants.find((grant) => grant.src.length === 1 && grant.src[0] === tag);
    assert.ok(peerGrant, `missing grant for ${tag}`);
    assert.deepEqual(peerGrant.ip.sort(), ["tcp:9090", "tcp:9095"]);
    assert.equal(peerGrant.dst.includes(tag), false);
    assert.equal(peerGrant.dst.length, 2);

    const policyTest = policy.tests.find((entry) => entry.src === tag);
    assert.ok(policyTest, `missing policy test for ${tag}`);
    assert.ok(policyTest.accept.length >= 2);
    assert.ok(policyTest.deny.length >= 2);
  }

  const adminGrant = grants.find((grant) => grant.src.includes("tag:fiducia-admin") && grant.ip.includes("tcp:22"));
  assert.ok(adminGrant);
  assert.deepEqual(adminGrant.ip.sort(), ["tcp:22", "tcp:6443"]);
});

test("cloudflared is digest-pinned, non-root, token-only, and outbound-only", () => {
  const deployment = read("laptop/components/connectivity/cloudflared.yaml");
  const policy = read("laptop/components/connectivity/networkpolicy.yaml");

  assert.match(deployment, /image: cloudflare\/cloudflared@sha256:[0-9a-f]{64}/);
  assert.doesNotMatch(deployment, /cloudflare\/cloudflared:(latest|main|dev)\b/);
  assert.match(deployment, /name: TUNNEL_TOKEN[\s\S]*secretKeyRef:[\s\S]*name: cloudflared-tunnel-token[\s\S]*key: token/);
  assert.doesNotMatch(deployment, /\bvalue:\s*eyJ/);
  assert.doesNotMatch(deployment, /hostNetwork: true|hostPort:|type: NodePort/);
  assert.match(deployment, /automountServiceAccountToken: false/);
  assert.match(deployment, /readOnlyRootFilesystem: true/);
  assert.match(deployment, /allowPrivilegeEscalation: false/);
  assert.match(deployment, /runAsNonRoot: true/);
  assert.match(deployment, /capabilities:\n\s+drop: \["ALL"\]/);
  assert.match(deployment, /path: \/ready/);
  assert.match(deployment, /resources:[\s\S]*requests:[\s\S]*limits:/);

  const edgePolicy = policy.split(/^---$/m)[0];
  const cidrs = [...edgePolicy.matchAll(/cidr:\s*([0-9.]+\/32)/g)].map((match) => match[1]);
  assert.equal(cidrs.length, 20);
  assert.equal(new Set(cidrs).size, 20);
  assert.doesNotMatch(edgePolicy, /0\.0\.0\.0\/0/);
  assert.match(edgePolicy, /protocol: TCP, port: 7844/);
  assert.match(edgePolicy, /protocol: UDP, port: 7844/);
});

test("laptop connectivity component narrows Raft peers to the Tailscale namespace", () => {
  const component = read("laptop/components/connectivity/kustomization.yaml");
  for (const name of [
    "fiducia-node-ingress",
    "fiducia-node-peer-egress",
    "fiducia-brain-ingress",
    "fiducia-brain-peer-egress",
  ]) {
    assert.match(component, new RegExp(`name: ${name}`));
  }
  assert.equal((component.match(/kubernetes\.io\/metadata\.name: tailscale/g) ?? []).length, 4);
  assert.doesNotMatch(component, /ipBlock:\s*\{\s*cidr:\s*0\.0\.0\.0\/0/);
});

test("generated peer topology uses stable in-cluster egress Service names", () => {
  const { topology, files } = renderLaptopFleet();
  for (const cluster of topology.cluster) {
    const env = files[`laptop/clusters/${cluster.name}/topology.env`];
    const peerLine = env.match(/^FIDUCIA_PEERS=(.*)$/m)?.[1];
    const brainLine = env.match(/^FIDUCIA_BRAIN_PEERS=(.*)$/m)?.[1];
    assert.ok(peerLine && brainLine);
    assert.equal(peerLine.split(",").length, 2);
    assert.equal(brainLine.split(",").length, 2);
    assert.match(peerLine, /^fiducia-node-peer-laptop-.*\.fiducia\.svc\.cluster\.local:9090,/);
    assert.match(brainLine, /^fiducia-brain-peer-laptop-.*\.fiducia\.svc\.cluster\.local:9095,/);
    assert.doesNotMatch(`${peerLine}\n${brainLine}`, /fiducia\.internal/);
    assert.doesNotMatch(peerLine, new RegExp(`fiducia-node-peer-${cluster.name}\\.`));
    assert.doesNotMatch(brainLine, new RegExp(`fiducia-brain-peer-${cluster.name}\\.`));
  }
});

test("every laptop overlay includes private ingress, HA egress, and connectivity policy", () => {
  const { topology, files } = renderLaptopFleet();
  for (const cluster of topology.cluster) {
    const overlay = read(`laptop/clusters/${cluster.name}/kustomization.yaml`);
    assert.match(overlay, /- tailnet-ingress\.yaml/);
    assert.match(overlay, /- \.\.\/\.\.\/components\/connectivity/);

    const ingress = files[`laptop/clusters/${cluster.name}/tailnet-ingress.yaml`];
    assert.doesNotMatch(ingress, /kind: ProxyGroup/);
    assert.equal((ingress.match(/loadBalancerClass: tailscale/g) ?? []).length, 2);
    assert.match(ingress, /name: fiducia-node-peer-tailnet[\s\S]*port: 9090/);
    assert.match(ingress, /name: fiducia-brain-peer-tailnet[\s\S]*port: 9095/);

    const proxyGroup = files[`laptop/hosts/${cluster.name}/tailscale-egress-proxygroup.yaml`];
    assert.match(proxyGroup, /kind: ProxyGroup/);
    assert.match(proxyGroup, /name: fiducia-egress-proxies/);
    assert.match(proxyGroup, /type: egress/);
    assert.match(proxyGroup, /replicas: 2/);
    assert.match(proxyGroup, new RegExp(`tag:fiducia-peer-${cluster.synthetic_provider}-sim`));
    assert.doesNotMatch(proxyGroup, /namespace:/);
  }
});

test("tailnet egress rendering is exact, HA-backed, and rejects stale/example live evidence", () => {
  const observations = goodTailnetObservations();
  assert.throws(() => validateTailnetObservations(observations), /require --allow-example/);

  const manifest = renderTailnetEgress("laptop-aws-sim", observations, { allowExample: true });
  assert.equal((manifest.match(/kind: Service/g) ?? []).length, 4);
  assert.equal((manifest.match(/tailscale\.com\/proxy-group: fiducia-egress-proxies/g) ?? []).length, 4);
  assert.equal((manifest.match(/type: ExternalName/g) ?? []).length, 4);
  assert.match(manifest, /fiducia-node-peer-laptop-gcp-sim/);
  assert.match(manifest, /fiducia-brain-peer-laptop-azure-sim/);
  assert.doesNotMatch(manifest, /fiducia-(node|brain)-peer-laptop-aws-sim/);
  assert.doesNotMatch(manifest, /kind: Secret/);

  const stale = structuredClone(observations);
  stale.evidenceMode = "live";
  stale.observedAt = "2026-08-03T15:00:00Z";
  for (const entry of Object.values(stale.clusters)) {
    entry.nodeFqdn = entry.nodeFqdn.replace("fiducia-example", "fiducia-live");
    entry.brainFqdn = entry.brainFqdn.replace("fiducia-example", "fiducia-live");
  }
  assert.throws(() => validateTailnetObservations(stale, { now: fixedNow }), /older than ten minutes/);

  const exampleDomain = structuredClone(stale);
  exampleDomain.observedAt = "2026-08-03T16:00:00Z";
  exampleDomain.clusters["laptop-aws-sim"].nodeFqdn = "node-laptop-aws-sim.example.ts.net";
  assert.throws(() => validateTailnetObservations(exampleDomain, { now: fixedNow }), /example domain/);

  const wrongClusterIdentity = structuredClone(observations);
  wrongClusterIdentity.clusters["laptop-gcp-sim"].nodeFqdn = observations.clusters["laptop-aws-sim"].nodeFqdn;
  assert.throws(() => validateTailnetObservations(wrongClusterIdentity, { allowExample: true }), /must start with node-laptop-gcp-sim/);
});

test("K3s config enables only Secret-backed compressed S3 snapshots", () => {
  const { topology, files } = renderLaptopFleet();
  for (const cluster of topology.cluster) {
    const config = files[`laptop/hosts/${cluster.name}/k3s-config.yaml`];
    assert.match(config, /etcd-snapshot-compress: true/);
    assert.match(config, /etcd-s3: true/);
    assert.match(config, /etcd-s3-config-secret: k3s-etcd-snapshot-s3-config/);
    for (const forbidden of [
      "etcd-s3-endpoint:",
      "etcd-s3-access-key:",
      "etcd-s3-secret-key:",
      "etcd-s3-bucket:",
      "etcd-s3-folder:",
      "etcd-s3-insecure:",
      "etcd-s3-skip-ssl-verify:",
    ]) {
      assert.equal(config.includes(forbidden), false, `${cluster.name} leaked ${forbidden} into host config`);
    }
  }
});

test("external K3s S3 Secret validation fails closed on placeholders and weak transport", () => {
  const summary = validateK3sS3Secret(goodK3sS3Secret(), "laptop-aws-sim");
  assert.equal(summary.tlsVerification, true);
  assert.equal(summary.plaintextTransport, false);
  assert.equal(summary.folderEndsWithCluster, true);

  assert.throws(
    () => validateK3sS3Secret(goodK3sS3Secret().replace("AKIAVALIDEXAMPLE123", "EXTERNAL_ACCESS_KEY"), "laptop-aws-sim"),
    /placeholder/,
  );
  assert.throws(
    () => validateK3sS3Secret(goodK3sS3Secret().replace('etcd-s3-skip-ssl-verify: "false"', 'etcd-s3-skip-ssl-verify: "true"'), "laptop-aws-sim"),
    /TLS verification/,
  );
  assert.throws(
    () => validateK3sS3Secret(goodK3sS3Secret().replace('etcd-s3-insecure: "false"', 'etcd-s3-insecure: "true"'), "laptop-aws-sim"),
    /plaintext S3 transport/,
  );
  assert.throws(
    () => validateK3sS3Secret(goodK3sS3Secret().replace("clusters/laptop-aws-sim", "clusters/other"), "laptop-aws-sim"),
    /exact cluster identity/,
  );
});

test("ETCDSnapshotFile evidence requires a recent matched local and S3 pair", () => {
  const summary = verifySnapshotEvidence(goodSnapshotList(), "laptop-aws-sim", { now: fixedNow });
  assert.equal(summary.readyLocal, true);
  assert.equal(summary.readyS3, true);
  assert.equal(summary.tlsVerification, true);
  assert.equal(summary.tokenHashMatched, true);
  assert.equal("tokenHash" in summary, false);

  assert.throws(
    () => verifySnapshotEvidence({ items: [snapshotItem()] }, "laptop-aws-sim", { now: fixedNow }),
    /no ready local\/S3 snapshot pair/,
  );

  const sizeMismatch = goodSnapshotList();
  sizeMismatch.items[1].status.size += 1;
  assert.throws(() => verifySnapshotEvidence(sizeMismatch, "laptop-aws-sim", { now: fixedNow }), /no ready local\/S3/);

  const tokenMismatch = goodSnapshotList();
  tokenMismatch.items[1].metadata.annotations["etcd.k3s.cattle.io/snapshot-token-hash"] = "differenthash";
  assert.throws(() => verifySnapshotEvidence(tokenMismatch, "laptop-aws-sim", { now: fixedNow }), /no ready local\/S3/);

  const insecure = goodSnapshotList();
  insecure.items[1].spec.s3.skipSSLVerify = true;
  assert.throws(() => verifySnapshotEvidence(insecure, "laptop-aws-sim", { now: fixedNow }), /no ready local\/S3/);

  const stale = goodSnapshotList({ creationTime: "2026-08-02T00:00:00Z" });
  assert.throws(() => verifySnapshotEvidence(stale, "laptop-aws-sim", { now: fixedNow }), /older than 8 hours/);
});

test("Cloudflare token validator exposes only redacted metadata", () => {
  const token = `eyJ${"a".repeat(180)}`;
  const secret = `apiVersion: v1
kind: Secret
metadata:
  name: cloudflared-tunnel-token
  namespace: fiducia
type: Opaque
stringData:
  token: "${token}"
`;
  const summary = validateCloudflaredTokenSecret(secret);
  assert.deepEqual(Object.keys(summary).sort(), ["name", "namespace", "tokenConfigured", "tokenLengthClass"]);
  assert.equal(JSON.stringify(summary).includes(token), false);
  assert.throws(() => validateCloudflaredTokenSecret(secret.replace(token, "REPLACE_ME")), /placeholder/);
});

test("bootstrap scripts never download or print credentials and validate the intended context", () => {
  for (const scriptPath of [
    "scripts/bootstrap-laptop-tailscale-operator.sh",
    "scripts/apply-laptop-tailnet-egress.sh",
    "scripts/capture-laptop-tailnet-observations.sh",
    "scripts/apply-k3s-etcd-s3-secret.sh",
    "scripts/capture-laptop-etcd-snapshot-evidence.sh",
    "scripts/apply-cloudflared-tunnel-secret.sh",
  ]) {
    const script = read(scriptPath);
    assert.match(script, /set -euo pipefail/);
    assert.doesNotMatch(script, /set -x|\bcurl\b|\bwget\b/);
  }

  for (const scriptPath of [
    "scripts/bootstrap-laptop-tailscale-operator.sh",
    "scripts/apply-laptop-tailnet-egress.sh",
    "scripts/apply-k3s-etcd-s3-secret.sh",
    "scripts/apply-cloudflared-tunnel-secret.sh",
  ]) {
    const script = read(scriptPath);
    assert.match(script, /fiducia\.cloud\/cluster=\$cluster,fiducia\.cloud\/substrate=laptop-k3s/);
    assert.match(script, /--dry-run=server/);
  }

  const operatorBootstrap = read("scripts/bootstrap-laptop-tailscale-operator.sh");
  assert.match(operatorBootstrap, /chart checksum mismatch/);
  assert.match(operatorBootstrap, /apiServerProxyConfig\.mode=true/);
  assert.match(operatorBootstrap, /apiServerProxyConfig\.allowImpersonation=true/);
  assert.match(operatorBootstrap, /proxygroup\/fiducia-egress-proxies/);
  assert.match(read("scripts/apply-k3s-etcd-s3-secret.sh"), /must not be group\/world accessible/);
  assert.match(read("scripts/apply-cloudflared-tunnel-secret.sh"), /must not be group\/world accessible/);
  assert.match(read("scripts/capture-laptop-etcd-snapshot-evidence.sh"), /get etcdsnapshotfile -o json/);
});
