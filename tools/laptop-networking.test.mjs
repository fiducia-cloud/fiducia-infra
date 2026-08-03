import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { renderLaptopFleet } from "./render-laptop-fleet.mjs";
import {
  laptopClusterNames,
  renderClusterTailnetBundle,
  renderTailnetBundle,
  renderTailnetPolicy,
  validateTailnetInputs,
} from "./render-laptop-tailnet.mjs";
import { verifySnapshotEvidence } from "./verify-etcd-snapshot-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const inputs = { operator: "operator@example.com", tailnetDomain: "example.ts.net" };
const fixedNow = new Date("2026-08-03T16:05:00Z");

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

function snapshotList(overrides = {}) {
  return {
    apiVersion: "v1",
    kind: "List",
    items: [
      snapshotItem({ ...overrides, storage: "local" }),
      snapshotItem({ ...overrides, storage: "s3" }),
    ],
  };
}

function clusterSuffix(cluster) {
  return cluster.replace(/^laptop-/, "");
}

test("cloudflared is digest-pinned, secret-backed, unprivileged, and independently healthy", () => {
  const manifest = read("laptop/components/runtime/cloudflared.yaml");
  assert.match(manifest, /image: cloudflare\/cloudflared@sha256:[0-9a-f]{64}/);
  assert.doesNotMatch(manifest, /cloudflare\/cloudflared:(?:latest|main|dev|2026\.7\.3)\b/);
  assert.match(manifest, /name: TUNNEL_TOKEN[\s\S]*name: cloudflare-tunnel-token[\s\S]*key: token[\s\S]*optional: false/);
  assert.match(manifest, /--no-autoupdate/);
  assert.match(manifest, /--edge-ip-version[\s\S]*- "4"[\s\S]*- run/);
  assert.match(manifest, /--metrics[\s\S]*0\.0\.0\.0:2000/);
  assert.match(manifest, /startupProbe:[\s\S]*path: \/ready/);
  assert.match(manifest, /readinessProbe:[\s\S]*path: \/ready/);
  assert.match(manifest, /livenessProbe:[\s\S]*path: \/ready/);
  assert.match(manifest, /automountServiceAccountToken: false/);
  assert.match(manifest, /runAsNonRoot: true/);
  assert.match(manifest, /allowPrivilegeEscalation: false/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
  assert.match(manifest, /drop: \["ALL"\]/);
  assert.match(manifest, /seccompProfile:[\s\S]*RuntimeDefault/);
  assert.match(manifest, /kind: PodDisruptionBudget[\s\S]*maxUnavailable: 0/);
});

test("cloudflared network policy permits only local origin and published IPv4 tunnel endpoints", () => {
  const manifest = read("laptop/components/runtime/cloudflared.yaml");
  const policy = manifest.slice(manifest.indexOf("kind: NetworkPolicy"));
  assert.match(policy, /app: fiducia-load-balance[\s\S]*port: 8088/);
  assert.match(policy, /protocol: TCP, port: 7844/);
  assert.match(policy, /protocol: UDP, port: 7844/);
  const edgeCidrs = [...policy.matchAll(/cidr:\s*(198\.41\.(?:192|200)\.[0-9]+\/32)/g)].map((match) => match[1]);
  assert.equal(edgeCidrs.length, 20);
  assert.equal(new Set(edgeCidrs).size, 20);
  assert.doesNotMatch(policy, /0\.0\.0\.0\/0/);
  assert.doesNotMatch(policy, /port: 22\b|port: 6443\b|port: 8090\b|port: 8095\b|port: 9090\b|port: 9095\b/);
  assert.doesNotMatch(policy, /port: 443\b/);
});

test("every laptop overlay includes the runtime component while public ingress remains ClusterIP", () => {
  for (const cluster of laptopClusterNames()) {
    const overlay = read(`laptop/clusters/${cluster}/kustomization.yaml`);
    assert.match(overlay, /\.\.\/\.\.\/components\/runtime/);
  }
  const substrate = read("laptop/components/substrate/kustomization.yaml");
  assert.match(substrate, /name: fiducia-load-balance/);
  assert.match(substrate, /value: ClusterIP/);
  assert.doesNotMatch(substrate, /NodePort/);
});

test("K3s uses only the rotatable S3 configuration Secret and never embeds credentials", () => {
  const { topology, files } = renderLaptopFleet();
  const forbidden = /etcd-s3-(?:access-key|secret-key|session-token|endpoint|bucket|region|folder|proxy):/;
  for (const cluster of topology.cluster) {
    const config = files[`laptop/hosts/${cluster.name}/k3s-config.yaml`];
    assert.match(config, /^etcd-s3: true$/m);
    assert.match(config, /^etcd-s3-config-secret: k3s-etcd-snapshot-s3-config$/m);
    assert.match(config, /^etcd-snapshot-schedule-cron: "0 \*\/6 \* \* \*"$/m);
    assert.match(config, /^etcd-snapshot-retention: 14$/m);
    assert.doesNotMatch(config, forbidden);
  }
});

test("tailnet policy isolates every cluster egress identity from itself and unrelated control ports", () => {
  const policy = renderTailnetPolicy(inputs);
  assert.equal(policy.grants.length, 11);
  assert.deepEqual(policy.tagOwners["tag:k8s"], ["tag:k8s-operator"]);
  assert.ok(policy.grants.every((grant) => !grant.src.includes("*") && !grant.dst.includes("*")));
  assert.deepEqual(policy.grants[0].ip, ["tcp:22", "tcp:6443"]);
  assert.deepEqual(policy.grants[1].ip, ["tcp:443"]);

  for (const suffix of ["aws-sim", "gcp-sim", "azure-sim"]) {
    const src = `tag:fiducia-peer-egress-${suffix}`;
    const grants = policy.grants.filter((grant) => grant.src.length === 1 && grant.src[0] === src);
    assert.equal(grants.length, 3);
    assert.deepEqual(grants.map((grant) => grant.ip[0]).sort(), ["tcp:6222", "tcp:9090", "tcp:9095"]);
    assert.ok(grants.every((grant) => grant.dst.length === 2));
    assert.ok(grants.every((grant) => grant.dst.every((dst) => !dst.endsWith(suffix))));

    const policyTest = policy.tests.find((entry) => entry.src === src);
    assert.ok(policyTest, `missing policy test for ${src}`);
    assert.equal(policyTest.accept.length, 6);
    assert.ok(policyTest.deny.includes(`tag:fiducia-node-peer-${suffix}:9090`));
    assert.ok(policyTest.deny.includes(`tag:fiducia-brain-peer-${suffix}:9095`));
    assert.ok(policyTest.deny.includes(`tag:fiducia-nats-route-${suffix}:6222`));
    assert.ok(policyTest.deny.includes("tag:fiducia-laptop-host:22"));
    assert.ok(policyTest.deny.includes("tag:k8s-operator:443"));
    assert.ok(policyTest.deny.some((destination) => destination.endsWith(":4222")));
    assert.ok(policyTest.deny.some((destination) => destination.endsWith(":8222")));
  }
});

test("tailnet materialization keeps ProxyGroup cluster-scoped and mirrors exactly two remote peers per plane", () => {
  const all = renderTailnetBundle(inputs);
  assert.equal(all.nonSecret, true);
  assert.deepEqual(Object.keys(all.clusters).sort(), laptopClusterNames().sort());

  for (const cluster of laptopClusterNames()) {
    const suffix = clusterSuffix(cluster);
    const bundle = renderClusterTailnetBundle({ clusterName: cluster, ...inputs });
    assert.doesNotMatch(bundle.manifest, /__[A-Z0-9_]+__/);
    assert.doesNotMatch(bundle.manifest, /kind: Secret/);
    const proxyGroup = bundle.manifest.split(/^---$/m)[0];
    assert.match(proxyGroup, /kind: ProxyGroup[\s\S]*type: egress[\s\S]*replicas: 2/);
    assert.match(proxyGroup, new RegExp(`tag:fiducia-peer-egress-${suffix}`));
    assert.doesNotMatch(proxyGroup, /namespace:/);
    assert.match(bundle.manifest, new RegExp(`tag:fiducia-node-peer-${suffix}`));
    assert.match(bundle.manifest, new RegExp(`tag:fiducia-brain-peer-${suffix}`));
    assert.match(bundle.manifest, new RegExp(`tag:fiducia-nats-route-${suffix}`));
    assert.match(bundle.manifest, /name: fiducia-node-tailnet[\s\S]*loadBalancerClass: tailscale[\s\S]*port: 9090/);
    assert.match(bundle.manifest, /name: fiducia-brain-tailnet[\s\S]*loadBalancerClass: tailscale[\s\S]*port: 9095/);
    assert.match(bundle.manifest, /name: fiducia-nats-route-tailnet[\s\S]*loadBalancerClass: tailscale[\s\S]*port: 6222/);
    assert.equal((bundle.manifest.match(/type: ExternalName/g) ?? []).length, 6);
    assert.equal((bundle.manifest.match(/tailscale\.com\/tailnet-fqdn:/g) ?? []).length, 6);
    assert.equal((bundle.manifest.match(/name: fiducia-nats-route-laptop-(?:aws|gcp|azure)-sim-tailnet/g) ?? []).length, 2);
    assert.doesNotMatch(bundle.peerEnv, new RegExp(`-${cluster}-tailnet`));
    assert.equal(bundle.peerEnv.split("\n").filter(Boolean).length, 2);
    assert.match(bundle.peerEnv, /\.fiducia\.svc\.cluster\.local:9090/);
    assert.match(bundle.peerEnv, /\.fiducia\.svc\.cluster\.local:9095/);
  }
});

test("tailnet renderer rejects placeholders, unknown clusters, and malformed identities", () => {
  for (const invalid of [
    { operator: "", tailnetDomain: "example.ts.net" },
    { operator: "operator", tailnetDomain: "example.ts.net" },
    { operator: "operator@example.com", tailnetDomain: "CHANGE-ME.ts.net" },
    { operator: "operator@example.com", tailnetDomain: "example.com" },
  ]) {
    assert.throws(() => validateTailnetInputs(invalid));
  }
  assert.throws(
    () => renderClusterTailnetBundle({ clusterName: "laptop-random-sim", ...inputs }),
    /unknown laptop cluster/,
  );
});

test("runtime secret bootstrap validates tunnel shape, TLS, cluster folder, and private files", () => {
  const script = read("scripts/apply-laptop-runtime-secrets.sh");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /umask 077/);
  assert.match(script, /Cloudflare token does not match the expected remotely managed tunnel token shape/);
  assert.match(script, /etcd-s3-folder must end with the exact cluster identity/);
  assert.match(script, /etcd-s3-skip-ssl-verify etcd-s3-insecure/);
  assert.match(script, /must remain false/);
  assert.match(script, /cannot use plaintext http:\/\//);
  assert.match(script, /--from-file="token=\$cloudflare_token_file"/);
  assert.match(script, /--type=etcd\.k3s\.cattle\.io\/s3-config-secret/);
  assert.match(script, /--dry-run=client -o yaml/);
  assert.match(script, /apply --server-side/);
  assert.doesNotMatch(script, /--from-literal/);
  assert.doesNotMatch(script, /set -x|set -o xtrace/);
});

test("ETCDSnapshotFile evidence requires a recent matched local and S3 pair", () => {
  const summary = verifySnapshotEvidence(snapshotList(), "laptop-aws-sim", { now: fixedNow });
  assert.equal(summary.readyLocal, true);
  assert.equal(summary.readyS3, true);
  assert.equal(summary.tlsVerification, true);
  assert.equal(summary.tokenHashMatched, true);
  assert.equal("tokenHash" in summary, false);

  assert.throws(
    () => verifySnapshotEvidence({ items: [snapshotItem()] }, "laptop-aws-sim", { now: fixedNow }),
    /no ready local\/S3 snapshot pair/,
  );
  const sizeMismatch = snapshotList();
  sizeMismatch.items[1].status.size += 1;
  assert.throws(() => verifySnapshotEvidence(sizeMismatch, "laptop-aws-sim", { now: fixedNow }), /no ready local\/S3/);
  const tokenMismatch = snapshotList();
  tokenMismatch.items[1].metadata.annotations["etcd.k3s.cattle.io/snapshot-token-hash"] = "differenthash";
  assert.throws(() => verifySnapshotEvidence(tokenMismatch, "laptop-aws-sim", { now: fixedNow }), /no ready local\/S3/);
  const insecure = snapshotList();
  insecure.items[1].spec.s3.skipSSLVerify = true;
  assert.throws(() => verifySnapshotEvidence(insecure, "laptop-aws-sim", { now: fixedNow }), /no ready local\/S3/);
  const stale = snapshotList({ creationTime: "2026-08-02T00:00:00Z" });
  assert.throws(() => verifySnapshotEvidence(stale, "laptop-aws-sim", { now: fixedNow }), /older than 8 hours/);
});

test("snapshot evidence capture is context-bound, redacted, and mode 0600", () => {
  const script = read("scripts/capture-laptop-etcd-snapshot-evidence.sh");
  assert.match(script, /fiducia\.cloud\/cluster=\$cluster,fiducia\.cloud\/substrate=laptop-k3s/);
  assert.match(script, /get etcdsnapshotfile -o json/);
  assert.match(script, /verify-etcd-snapshot-evidence\.mjs/);
  assert.match(script, /install -m 600/);
  assert.doesNotMatch(script, /set -x|\bcurl\b|\bwget\b/);
});

test("restore is checksum-gated, token-file based, local-only, and requires three acknowledgements", () => {
  const script = read("scripts/restore-laptop-k3s-snapshot.sh");
  assert.match(script, /sha256sum/);
  assert.match(script, /--token-file="\$token_file"/);
  assert.match(script, /--etcd-s3=false/);
  assert.match(script, /--ack-stop-k3s/);
  assert.match(script, /--ack-cluster-reset/);
  assert.match(script, /--ack-replace-cluster-state/);
  assert.match(script, /systemctl stop k3s[\s\S]*k3s server[\s\S]*systemctl start k3s/);
  assert.doesNotMatch(script, /--etcd-s3-access-key|--etcd-s3-secret-key/);
});

test("laptop implementation inputs contain no pasted provider or GitHub credentials", () => {
  const files = [
    "laptop/tailnet-policy.template.json",
    "laptop/tailnet-cluster.template.yaml",
    "laptop/components/runtime/cloudflared.yaml",
    "laptop/components/messaging-ha/kustomization.yaml",
    "laptop/components/messaging-ha/networkpolicy.yaml",
    "laptop/hosts/laptop-aws-sim/k3s-config.yaml",
    "laptop/hosts/laptop-gcp-sim/k3s-config.yaml",
    "laptop/hosts/laptop-azure-sim/k3s-config.yaml",
    "laptop/messaging/jetstream-evidence.example.json",
    "scripts/apply-laptop-runtime-secrets.sh",
    "scripts/apply-laptop-nats-route-tls.sh",
    "scripts/capture-laptop-etcd-snapshot-evidence.sh",
    "scripts/restore-laptop-k3s-snapshot.sh",
    "scripts/test-laptop-nats-configs.sh",
    "tools/render-laptop-tailnet.mjs",
    "tools/render-laptop-messaging.mjs",
    "tools/verify-etcd-snapshot-evidence.mjs",
    "tools/validate-laptop-jetstream-evidence.mjs",
    "docs/laptop-private-mesh-ingress-snapshots.md",
    "docs/laptop-jetstream-ha.md",
  ];
  const patterns = [
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /tskey-(?:auth|client)-[A-Za-z0-9_-]{16,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  for (const relativePath of files) {
    const content = read(relativePath);
    for (const pattern of patterns) {
      assert.doesNotMatch(content, pattern, `${relativePath} contains a credential-like value`);
    }
  }
});
