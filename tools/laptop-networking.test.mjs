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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const inputs = { operator: "operator@example.com", tailnetDomain: "example.ts.net" };

test("cloudflared is exact-versioned, secret-backed, unprivileged, and independently healthy", () => {
  const manifest = read("laptop/components/runtime/cloudflared.yaml");
  assert.match(manifest, /image: cloudflare\/cloudflared:2026\.7\.3\b/);
  assert.doesNotMatch(manifest, /cloudflare\/cloudflared:latest\b/);
  assert.match(manifest, /name: TUNNEL_TOKEN[\s\S]*name: cloudflare-tunnel-token[\s\S]*key: token[\s\S]*optional: false/);
  assert.match(manifest, /--no-autoupdate/);
  assert.match(manifest, /--metrics[\s\S]*0\.0\.0\.0:2000[\s\S]*- run/);
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

test("cloudflared network policy permits only the local origin and required tunnel transports", () => {
  const manifest = read("laptop/components/runtime/cloudflared.yaml");
  const policy = manifest.slice(manifest.indexOf("kind: NetworkPolicy"));
  assert.match(policy, /app: fiducia-load-balance[\s\S]*port: 8088/);
  assert.match(policy, /protocol: TCP, port: 7844/);
  assert.match(policy, /protocol: UDP, port: 7844/);
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

test("tailnet policy is deny-by-default and separates operator, host, egress, node, and brain identities", () => {
  const policy = renderTailnetPolicy(inputs);
  assert.equal(policy.grants.length, 4);
  assert.ok(policy.grants.every((grant) => !grant.src.includes("*") && !grant.dst.includes("*")));
  assert.deepEqual(policy.grants[0].ip, ["tcp:22", "tcp:6443"]);
  assert.deepEqual(policy.grants[1].ip, ["tcp:443"]);
  assert.deepEqual(policy.grants[2].ip, ["tcp:9090"]);
  assert.deepEqual(policy.grants[3].ip, ["tcp:9095"]);
  const egressTest = policy.tests.find((entry) => entry.src === "tag:fiducia-peer-egress");
  assert.ok(egressTest);
  assert.ok(egressTest.accept.includes("tag:fiducia-node-peer:9090"));
  assert.ok(egressTest.accept.includes("tag:fiducia-brain-peer:9095"));
  assert.ok(egressTest.deny.includes("tag:fiducia-laptop-host:22"));
  assert.ok(egressTest.deny.includes("tag:fiducia-node-peer:8090"));
  assert.ok(egressTest.deny.includes("tag:fiducia-brain-peer:8095"));
});

test("tailnet materialization creates one ingress per local peer plane and mirrors exactly two remote peers", () => {
  const all = renderTailnetBundle(inputs);
  assert.equal(all.nonSecret, true);
  assert.deepEqual(Object.keys(all.clusters).sort(), laptopClusterNames().sort());

  for (const cluster of laptopClusterNames()) {
    const bundle = renderClusterTailnetBundle({ clusterName: cluster, ...inputs });
    assert.doesNotMatch(bundle.manifest, /__[A-Z0-9_]+__/);
    assert.doesNotMatch(bundle.manifest, /kind: Secret/);
    assert.match(bundle.manifest, /kind: ProxyGroup[\s\S]*type: egress[\s\S]*replicas: 2/);
    assert.match(bundle.manifest, /name: fiducia-node-tailnet[\s\S]*loadBalancerClass: tailscale[\s\S]*port: 9090/);
    assert.match(bundle.manifest, /name: fiducia-brain-tailnet[\s\S]*loadBalancerClass: tailscale[\s\S]*port: 9095/);
    assert.equal((bundle.manifest.match(/type: ExternalName/g) ?? []).length, 4);
    assert.equal((bundle.manifest.match(/tailscale\.com\/tailnet-fqdn:/g) ?? []).length, 4);
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

test("runtime secret bootstrap consumes private files and never passes literal credentials", () => {
  const script = read("scripts/apply-laptop-runtime-secrets.sh");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /umask 077/);
  assert.match(script, /--from-file="token=\$cloudflare_token_file"/);
  assert.match(script, /--type=etcd\.k3s\.cattle\.io\/s3-config-secret/);
  assert.match(script, /--dry-run=client -o yaml/);
  assert.match(script, /apply --server-side/);
  assert.doesNotMatch(script, /--from-literal/);
  assert.doesNotMatch(script, /set -x|set -o xtrace/);
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

test("laptop implementation files contain no pasted provider or GitHub credential patterns", () => {
  const roots = ["laptop", "scripts", "tools", "docs"];
  const patterns = [
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /tskey-(?:auth|client)-[A-Za-z0-9_-]{16,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];

  function visit(relativePath) {
    const absolute = path.join(root, relativePath);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relativePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        const content = fs.readFileSync(path.join(root, child), "utf8");
        for (const pattern of patterns) assert.doesNotMatch(content, pattern, `${child} contains a credential-like value`);
      }
    }
  }
  for (const relativePath of roots) visit(relativePath);
});
