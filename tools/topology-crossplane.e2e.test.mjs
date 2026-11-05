// Contract-integration tests from production topology source through generated
// node/brain peer settings and the GitOps overlays which actually consume them.
// This does not replace a deployed multi-cluster test: it prevents an internally
// inconsistent service-to-service route graph from ever being shipped.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTopology, render, validateTopology } from "./render.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const csv = (value) => value ? value.split(",").filter(Boolean) : [];
const props = (text) => Object.fromEntries(
  text.split(/\r?\n/).filter((line) => line.startsWith("FIDUCIA_"))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

test("topology -> Raft peer graph -> GitOps wiring is complete in every failure domain", () => {
  const topology = loadTopology();
  const files = render(topology);
  const brains = topology.cluster.filter((cluster) => cluster.brain);
  const targetNodeCount = topology.cluster.reduce(
    (sum, cluster) => sum + cluster.node_replicas, 0,
  );

  for (const cluster of topology.cluster) {
    const path = `clusters/${cluster.name}/`;
    const p = props(files[path + "topology.properties"]);
    const overlay = read(path + "kustomization.yaml");
    const patch = files[path + "patches.yaml"];

    assert.equal(p.FIDUCIA_CLUSTER, cluster.name);
    assert.equal(p.FIDUCIA_CLUSTER_ID, topology.cluster_id);
    assert.equal(Number(p.FIDUCIA_SHARD_COUNT), topology.shard_count);
    assert.equal(Number(p.FIDUCIA_REPLICATION_FACTOR), topology.replication_factor);
    assert.equal(Number(p.FIDUCIA_TARGET_NODES), targetNodeCount);
    assert.equal(p.FIDUCIA_RAFT_CHECK_QUORUM, "on");

    assert.deepEqual(
      csv(p.FIDUCIA_PEERS),
      topology.cluster.filter((peer) => peer.name !== cluster.name)
        .map((peer) => peer.node_peer_endpoint),
      `${cluster.name}: node -> node graph must include each other domain once`,
    );
    assert.deepEqual(
      csv(p.FIDUCIA_BRAIN_PEERS),
      brains.filter((peer) => !cluster.brain || peer.name !== cluster.name)
        .map((peer) => peer.brain_endpoint),
      `${cluster.name}: brain membership and sidecar discovery must agree`,
    );
    assert.match(overlay, /- topology\.properties/);
    assert.match(overlay, /- path: patches\.yaml/);
    assert.match(overlay, /name: fiducia-cluster/);
    assert.match(patch, new RegExp(`replicas: ${cluster.node_replicas}`));

    if (cluster.brain) {
      assert.match(overlay, /base\/components\/brain/);
      assert.ok(
        patch.includes(`value: "http://${cluster.brain_endpoint}"`),
        `${cluster.name}: Raft leader ID must be the dialable, advertised brain URL`,
      );
    } else {
      assert.doesNotMatch(overlay, /base\/components\/brain/);
      assert.doesNotMatch(patch, /name: fiducia-brain/);
    }
  }

  const regions = JSON.parse(files["generated/edge-regions.json"]);
  assert.deepEqual(regions, topology.cluster.map((cluster) => ({
    name: cluster.name, url: cluster.lb_endpoint,
  })));
  for (const region of regions) {
    const url = new URL(region.url);
    assert.equal(url.protocol, "https:", `${region.name} edge region must be TLS-only`);
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.pathname, "/");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
  }
});

test("distinct regions cannot share one node, brain, or LB endpoint identity", () => {
  const baseline = loadTopology();
  for (const endpoint of ["node_peer_endpoint", "brain_endpoint", "lb_endpoint"]) {
    const mutated = structuredClone(baseline);
    mutated.cluster[1][endpoint] = mutated.cluster[0][endpoint];
    assert.throws(
      () => validateTopology(mutated),
      new RegExp(`duplicate ${endpoint}`),
      `reused ${endpoint} must not silently collapse two failure domains`,
    );
  }
});

test("quorum-ineligible brain promotion cannot ship into the rendered routing graph", () => {
  const baseline = loadTopology();
  const mutated = structuredClone(baseline);
  mutated.cluster.push({
    name: "unreviewed",
    storage_class: "durable",
    node_replicas: 1,
    brain: true,
    brain_endpoint: "brain.unreviewed.example:9095",
    node_peer_endpoint: "node.unreviewed.example:9090",
    lb_endpoint: "https://lb.unreviewed.example",
  });
  assert.throws(
    () => validateTopology(mutated),
    /ODD number of members/,
    "four members are not an approved three-member brain Raft membership",
  );
});
