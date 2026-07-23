// Render-level contract tests for the overlays.
//
// The assertions here exist because a kustomize overlay can be silently WRONG
// while every file still parses: a patch keyed on the wrong field renders an
// empty list, a strategic-merge on volumeClaimTemplates drops the whole PVC
// spec, and a JSON6902 patch pinned to /env/4 rewrites whichever variable
// happens to sit at index 4. Everything below is asserted on the rendered
// output, by NAME, so an insertion into base/ can never quietly relocate it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { podSpecsOf, renderOverlay } from "./manifests.mjs";

const KIND_MULTICLUSTER = ["hetzner-fsn1", "hetzner-nbg1", "hetzner-hel1"]
  .map((cluster) => `kind/multicluster/${cluster}`);
const K3S = ["hetzner-fsn1", "hetzner-nbg1", "hetzner-hel1"]
  .map((cluster) => `k3s/hetzner-e2e/clusters/${cluster}`);
const VCLUSTER = ["hetzner-fsn1", "hetzner-nbg1", "hetzner-hel1"]
  .map((cluster) => `vcluster/hetzner-e2e/clusters/${cluster}`);
// One node per cluster; a shard's three replicas are spread one-per-cluster.
const SINGLE_NODE_OVERLAYS = [
  "clusters/hetzner",
  "clusters/vultr",
  "clusters/civo",
  ...KIND_MULTICLUSTER,
  ...K3S,
  ...VCLUSTER,
];

function workloadsByName(overlay) {
  return Object.fromEntries(renderOverlay(overlay)
    .filter((document) => ["Deployment", "StatefulSet", "DaemonSet"].includes(document.kind))
    .map((document) => [document.metadata.name, document]));
}

function containerNamed(workload, name) {
  const container = workload.spec.template.spec.containers.find((entry) => entry.name === name);
  assert.ok(container, `container ${name} is missing`);
  return container;
}

const envNames = (container) => (container.env ?? []).map((entry) => entry.name);
const envNamed = (container, name) => (container.env ?? []).find((entry) => entry.name === name);

test("the kind emulation rewrites exactly the identity variables it means to", () => {
  for (const overlay of KIND_MULTICLUSTER) {
    const workloads = workloadsByName(overlay);
    const selfAddr = { configMapKeyRef: { key: "FIDUCIA_SELF_ADDR", name: "fiducia-cluster" } };

    // Cross-cluster-routable node identity. An env entry may not carry both
    // `value` and `valueFrom`, so the base's literal must be gone, not shadowed.
    for (const [container, variables] of [
      ["node", ["FIDUCIA_NODE_ID"]],
      ["sidecar", ["FIDUCIA_NODE_ID", "FIDUCIA_NODE_ADDRESS"]],
    ]) {
      for (const variable of variables) {
        const entry = envNamed(containerNamed(workloads["fiducia-node"], container), variable);
        assert.deepEqual(entry, { name: variable, valueFrom: selfAddr }, `${overlay}: ${container}.${variable}`);
      }
    }

    // The brain's member id must interpolate HOST_IP, and Kubernetes only
    // expands $(VAR) from env entries declared EARLIER in the list.
    const brain = containerNamed(workloads["fiducia-brain"], "brain");
    const names = envNames(brain);
    assert.ok(names.indexOf("HOST_IP") >= 0, `${overlay}: brain HOST_IP`);
    assert.ok(
      names.indexOf("HOST_IP") < names.indexOf("FIDUCIA_BRAIN_ID"),
      `${overlay}: HOST_IP must precede FIDUCIA_BRAIN_ID for $(VAR) expansion`,
    );
    assert.equal(envNamed(brain, "FIDUCIA_BRAIN_ID").value, "http://$(HOST_IP):30095");

    // Nothing else may have been displaced: the variables the emulation does
    // NOT patch must all still be present.
    for (const variable of ["POD_NAME", "POD_NAMESPACE", "NODE_NAME", "FIDUCIA_CLUSTER", "PORT", "FIDUCIA_PEER_PORT", "FIDUCIA_DATA_DIR", "FIDUCIA_INTERNAL_SECRET"]) {
      assert.ok(
        envNames(containerNamed(workloads["fiducia-node"], "node")).includes(variable),
        `${overlay}: node env lost ${variable}`,
      );
    }
  }
});

test("plaintext LB overlays drop TLS without dropping the writable /tmp mount", () => {
  // `volumeMounts` strategic-merges on `mountPath`, not `name` — a delete keyed
  // on `name` matches nothing and renders `volumeMounts: []`, silently removing
  // the /tmp emptyDir the read-only rootfs needs.
  for (const overlay of [...KIND_MULTICLUSTER, ...K3S, ...VCLUSTER]) {
    const lb = containerNamed(workloadsByName(overlay)["fiducia-load-balance"], "lb");
    assert.deepEqual(
      envNames(lb).filter((name) => name.startsWith("FIDUCIA_TLS_")),
      [],
      `${overlay}: plaintext LB must not keep TLS paths`,
    );
    assert.deepEqual(
      (lb.volumeMounts ?? []).map((mount) => mount.mountPath).sort(),
      ["/tmp"],
      `${overlay}: LB must keep exactly the writable /tmp mount`,
    );
  }
});

test("every single-node overlay forbids voluntary eviction of its Raft member", () => {
  for (const overlay of SINGLE_NODE_OVERLAYS) {
    const documents = renderOverlay(overlay);
    const node = documents.find((document) => document.kind === "StatefulSet"
      && document.metadata.name === "fiducia-node");
    assert.equal(node.spec.replicas, 1, `${overlay}: expected the one-node-per-cluster shape`);
    const pdb = documents.find((document) => document.kind === "PodDisruptionBudget"
      && document.metadata.name === "fiducia-node");
    assert.ok(pdb, `${overlay}: fiducia-node PodDisruptionBudget is missing`);
    assert.equal(
      pdb.spec.maxUnavailable,
      0,
      `${overlay}: maxUnavailable: 1 on a 1-replica set permits evicting 100% of this cluster's Raft member`,
    );
  }
});

test("the kind overlay renders a complete, applyable PVC template", () => {
  // volumeClaimTemplates has NO strategic-merge key: a patch carrying only
  // storageClassName replaces the whole list and the API server rejects the
  // StatefulSet ("at least 1 access mode is required").
  for (const overlay of ["kind/overlay", ...SINGLE_NODE_OVERLAYS]) {
    const node = renderOverlay(overlay).find((document) => document.kind === "StatefulSet"
      && document.metadata.name === "fiducia-node");
    const claim = node.spec.volumeClaimTemplates.find((template) => template.metadata.name === "data");
    assert.ok(claim, `${overlay}: node PVC template`);
    assert.deepEqual(claim.spec.accessModes, ["ReadWriteOnce"], `${overlay}: PVC accessModes`);
    assert.match(claim.spec.resources.requests.storage, /^\d+[KMGT]i$/, `${overlay}: PVC storage request`);
    assert.ok(claim.spec.storageClassName, `${overlay}: PVC storage class`);
  }
});

test("private-registry overlays wire the ghcr pull secret onto every pod", () => {
  // scripts/hetzner-e2e-secrets.sh creates fiducia-ghcr-pull in all three
  // clusters; all four core images are private, so a pod spec without the
  // reference ImagePullBackOffs. Asserted for the k3s tier exactly as
  // vcluster-hetzner-e2e.test.mjs asserts it for the vCluster tier.
  for (const overlay of [...K3S, ...VCLUSTER]) {
    const podSpecs = podSpecsOf(renderOverlay(overlay), overlay);
    assert.equal(podSpecs.length, 4, `${overlay}: node + brain + LB + nats`);
    for (const { where, spec } of podSpecs) {
      const images = [...(spec.containers ?? []), ...(spec.initContainers ?? [])]
        .map((container) => container.image ?? "");
      if (images.every((image) => !image.startsWith("ghcr.io/"))) {
        // Public-registry workloads (the digest-pinned NATS broker + exporter)
        // must NOT reference the ghcr credential they cannot use.
        assert.equal(
          spec.imagePullSecrets,
          undefined,
          `${where}: public-registry pod must not carry the ghcr pull secret`,
        );
        continue;
      }
      assert.deepEqual(
        spec.imagePullSecrets,
        [{ name: "fiducia-ghcr-pull" }],
        `${where}: private ghcr.io images need the pull secret`,
      );
    }
  }
});
