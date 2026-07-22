// Contract tests for the workload security baseline, applied to EVERY container
// in EVERY workload — both the hand-authored sources under base/ AND the fully
// rendered output of every overlay, so an overlay cannot patch the baseline away.
//
// These assertions parse structured manifests (tools/manifests.mjs) rather than
// regex-matching YAML text: the previous regex form accepted `resources: {}` for
// "resource bounds required" and a container carrying only ONE probe for
// "probe-covered", and it never looked past base/.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  podSpecsOf,
  readManifests,
  renderOverlay,
  root,
  workloadFiles,
} from "./manifests.mjs";

// Every overlay CI builds (.github/workflows/ci.yml) plus the local kind tiers.
const OVERLAYS = [
  "clusters/hetzner",
  "clusters/vultr",
  "clusters/civo",
  "kind/overlay",
  "kind/multicluster/hetzner-fsn1",
  "k3s/hetzner-e2e/clusters/hetzner-fsn1",
  "vcluster/hetzner-e2e/clusters/hetzner-fsn1",
];

/** A CPU/memory quantity must be present and non-empty. */
function assertQuantity(value, where) {
  assert.equal(typeof value, "string", `${where} must be set`);
  assert.match(value, /^\d+(\.\d+)?[a-zA-Z]*$/, `${where} must be a Kubernetes quantity`);
}

function assertHardenedPodSpec({ where, spec }) {
  const podSecurity = spec.securityContext ?? {};
  const containers = [...(spec.containers ?? []), ...(spec.initContainers ?? [])];
  assert.ok(containers.length > 0, `${where}: has at least one container`);

  // Pod-level runAsNonRoot must be declared — OR the workload runs as root under
  // the fleet's documented-exception pattern (the otel-agent reading root-owned
  // /var/log/pods), whose inline justification is asserted separately below.
  const runsAsRoot = podSecurity.runAsUser === 0
    || containers.some((container) => container.securityContext?.runAsUser === 0);
  if (!runsAsRoot) {
    assert.equal(podSecurity.runAsNonRoot, true, `${where}: runAsNonRoot missing`);
  }

  for (const container of containers) {
    const at = `${where} container '${container.name}'`;
    const security = container.securityContext ?? {};
    assert.equal(security.readOnlyRootFilesystem, true, `${at}: rootfs must be read-only`);
    assert.deepEqual(security.capabilities?.drop, ["ALL"], `${at}: capabilities must drop ALL`);
    assert.equal(security.allowPrivilegeEscalation, false, `${at}: privilege escalation must be off`);

    // BOTH probes: readiness alone leaves a wedged process running forever;
    // liveness alone routes traffic at a process that is up but not ready.
    assert.ok(container.readinessProbe, `${at}: readinessProbe required`);
    assert.ok(container.livenessProbe, `${at}: livenessProbe required`);

    // Limits, not merely a `resources:` key — an unbounded container can starve
    // the Raft member sharing its machine.
    const resources = container.resources ?? {};
    assertQuantity(resources.limits?.cpu, `${at}: resources.limits.cpu`);
    assertQuantity(resources.limits?.memory, `${at}: resources.limits.memory`);
    assertQuantity(resources.requests?.cpu, `${at}: resources.requests.cpu`);
    assertQuantity(resources.requests?.memory, `${at}: resources.requests.memory`);
  }
}

test("every base workload container is non-root, read-only, probed and bounded", () => {
  const files = workloadFiles("base");
  assert.ok(files.length >= 3, `expected node/LB/otel/brain workloads, found ${files.length}`);
  for (const file of files) {
    for (const podSpec of podSpecsOf(readManifests(file), file)) assertHardenedPodSpec(podSpec);
  }
});

test("every rendered overlay keeps the hardening baseline it inherits", () => {
  for (const overlay of OVERLAYS) {
    const podSpecs = podSpecsOf(renderOverlay(overlay), overlay);
    assert.ok(podSpecs.length >= 3, `${overlay}: expected node + brain + LB workloads`);
    for (const podSpec of podSpecs) assertHardenedPodSpec(podSpec);
  }
});

test("a root workload keeps its reviewable inline justification", () => {
  for (const file of workloadFiles("base")) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    if (!/runAsUser:\s*0(\s|$)/m.test(source)) continue;
    assert.match(
      source,
      /#.*root only/i,
      `${file}: runs as root without a documented "root only" justification`,
    );
  }
});

test("no base workload consumes a mutable image tag", () => {
  for (const file of workloadFiles("base")) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(/image:\s*(\S+)/g)) {
      const image = match[1].replace(/["']/g, "");
      assert.ok(
        !/(:latest|:main|:edge)$/.test(image),
        `${file}: mutable tag on ${image}`,
      );
      assert.match(
        image,
        /(:v[0-9][\w.-]*|@sha256:[0-9a-f]{64})$/,
        `${file}: ${image} must be version- or digest-pinned`,
      );
    }
  }
});

test("fiducia-node consumes only the provider-neutral KV protection Secret", () => {
  const source = fs.readFileSync(path.join(root, "base/node/statefulset.yaml"), "utf8");

  assert.match(
    source,
    /envFrom:\s*[\s\S]*secretRef:\s*\n\s+name:\s*fiducia-kv-protection\s*\n\s+optional:\s*true/,
    "node must accept an out-of-band fiducia-kv-protection Secret",
  );
  assert.doesNotMatch(
    source,
    /FIDUCIA_KV_(?:ENCRYPTION_KEY|ENCRYPTION_KEYS|VAULT_TOKEN):\s*\S+/,
    "KV encryption material must never be embedded in the workload manifest",
  );
});
