// Self-tests for the topology renderer. No writes, no network.
//   node --test tools/*.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseToml, loadTopology, render, validateTopology } from "./render.mjs";

test("parseToml handles scalars + array-of-tables", () => {
  const t = parseToml(`
# comment
cluster_id = "x"
shard_count = 16
flag = true

[[cluster]]
name = "a"
node_replicas = 2

[[cluster]]
name = "b"
node_replicas = 5
`);
  assert.equal(t.cluster_id, "x");
  assert.equal(t.shard_count, 16);
  assert.equal(t.flag, true);
  assert.equal(t.cluster.length, 2);
  assert.deepEqual(t.cluster.map((c) => c.name), ["a", "b"]);
  assert.equal(t.cluster[1].node_replicas, 5);
});

test("real topology loads + validates", () => {
  const t = loadTopology();
  assert.ok(t.cluster.length >= t.replication_factor, "need >= RF clusters");
});

test("validateTopology rejects duplicate cluster names", () => {
  const t = loadTopology();
  const duplicate = {
    ...t,
    cluster: [t.cluster[0], { ...t.cluster[1], name: t.cluster[0].name }, t.cluster[2]],
  };

  assert.throws(() => validateTopology(duplicate), /duplicate cluster name/);
});

test("validateTopology rejects topologies that cannot form quorum", () => {
  const t = loadTopology();
  const tooSmall = {
    ...t,
    replication_factor: t.cluster.length + 1,
  };

  assert.throws(() => validateTopology(tooSmall), /need at least replication_factor/);
});

test("validateTopology rejects unsupported connectivity modes", () => {
  const t = loadTopology();

  assert.throws(
    () => validateTopology({ ...t, connectivity: "plain-http" }),
    /connectivity must be/,
  );
});

test("render computes cross-cluster peers (each excludes itself)", () => {
  const files = render(loadTopology());
  const gcp = files["clusters/gcp/topology.env"];
  assert.match(gcp, /FIDUCIA_CLUSTER=gcp/);
  // gcp's peer list must NOT contain its own endpoint, but must contain the others.
  assert.doesNotMatch(gcp, /FIDUCIA_PEERS=[^\n]*node\.gcp\./);
  assert.match(gcp, /FIDUCIA_PEERS=[^\n]*node\.aws\./);
  assert.match(gcp, /FIDUCIA_BRAIN_PEERS=[^\n]*brain\.hetzner\./);
});

test("target nodes is the sum across clusters", () => {
  const t = loadTopology();
  const files = render(t);
  const sum = t.cluster.reduce((n, c) => n + c.node_replicas, 0);
  assert.match(files["clusters/gcp/topology.env"], new RegExp(`FIDUCIA_TARGET_NODES=${sum}`));
});

test("edge region list mirrors lb endpoints", () => {
  const files = render(loadTopology());
  const regions = JSON.parse(files["generated/edge-regions.json"]);
  assert.deepEqual(regions.map((r) => r.name), ["gcp", "aws", "hetzner", "azure"]);
  assert.ok(regions.every((r) => r.url.startsWith("https://")));
});

test("node-only cluster (brain=false) is excluded from the brain group", () => {
  const files = render(loadTopology());
  // No brain cluster lists azure as a brain peer, and azure's overlay carries no
  // brain StatefulSet patch (it doesn't include the brain Component).
  for (const c of ["gcp", "aws", "hetzner"]) {
    assert.doesNotMatch(files[`clusters/${c}/topology.env`], /FIDUCIA_BRAIN_PEERS=[^\n]*brain\.azure\./);
  }
  assert.doesNotMatch(files["clusters/azure/patches.yaml"], /name: fiducia-brain/);
  // A node-only cluster still reaches all three brains (its sidecar contacts them).
  const azure = files["clusters/azure/topology.env"];
  for (const b of ["gcp", "aws", "hetzner"]) {
    assert.match(azure, new RegExp(`FIDUCIA_BRAIN_PEERS=[^\\n]*brain\\.${b}\\.`));
  }
});

test("validateTopology rejects an even-sized brain group", () => {
  const t = loadTopology();
  // Flip azure back to a brain member → 4 members (even) → must be rejected.
  const evenBrain = {
    ...t,
    cluster: t.cluster.map((c) => (c.name === "azure" ? { ...c, brain: true } : c)),
  };
  assert.throws(() => validateTopology(evenBrain), /ODD number of members/);
});
