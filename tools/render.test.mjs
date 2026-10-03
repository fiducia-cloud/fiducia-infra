// Self-tests for the topology renderer. No writes, no network.
//   node --test tools/*.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
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

test("validateTopology rejects a path-traversal / non-DNS cluster name", () => {
  const t = loadTopology();
  for (const bad of ["../../etc/x", "Hetzner", "a_b", "-lead", "trail-", "a".repeat(64), 123]) {
    const bent = { ...t, cluster: t.cluster.map((c, i) => (i === 0 ? { ...c, name: bad } : c)) };
    assert.throws(() => validateTopology(bent), /DNS-1123/, `name ${JSON.stringify(bad)} must be rejected`);
  }
});

test("render itself refuses a traversal name (defense in depth for direct callers)", () => {
  const t = loadTopology();
  const bent = { ...t, cluster: t.cluster.map((c, i) => (i === 0 ? { ...c, name: "../../pwn" } : c)) };
  assert.throws(() => render(bent), /unsafe cluster name/);
});

test("validateTopology rejects string/negative numerics (no coercion past the quorum guards)", () => {
  const t = loadTopology();
  assert.throws(() => validateTopology({ ...t, replication_factor: "3" }), /replication_factor must be a positive integer/);
  assert.throws(() => validateTopology({ ...t, shard_count: 0 }), /shard_count must be a positive integer/);
  const badReplicas = { ...t, cluster: t.cluster.map((c, i) => (i === 0 ? { ...c, node_replicas: "5" } : c)) };
  assert.throws(() => validateTopology(badReplicas), /node_replicas must be a positive integer/);
});

test("validateTopology rejects out-of-bounds numerics (typo rails)", () => {
  const t = loadTopology();
  assert.throws(() => validateTopology({ ...t, shard_count: 65537 }), /shard_count must be a positive integer <= 65536/);
  assert.throws(() => validateTopology({ ...t, replication_factor: 9 }), /replication_factor must be a positive integer <= 7/);
  const bent = { ...t, cluster: t.cluster.map((c, i) => (i === 0 ? { ...c, node_replicas: 1001 } : c)) };
  assert.throws(() => validateTopology(bent), /node_replicas must be a positive integer <= 1000/);
});

test("validateTopology rejects malformed endpoints", () => {
  const t = loadTopology();
  const badPeer = { ...t, cluster: t.cluster.map((c, i) => (i === 0 ? { ...c, node_peer_endpoint: "no-port" } : c)) };
  assert.throws(() => validateTopology(badPeer), /node_peer_endpoint must be host:port/);
  const badLb = { ...t, cluster: t.cluster.map((c, i) => (i === 0 ? { ...c, lb_endpoint: "ftp://x" } : c)) };
  assert.throws(() => validateTopology(badLb), /lb_endpoint must be an http\(s\) URL/);
});

test("validateTopology rejects out-of-range endpoint ports", () => {
  const t = loadTopology();
  for (const bad of ["node.x.example:0", "node.x.example:65536", "node.x.example:99999"]) {
    const bent = { ...t, cluster: t.cluster.map((c, i) => (i === 0 ? { ...c, brain_endpoint: bad } : c)) };
    assert.throws(() => validateTopology(bent), /port must be in 1\.\.65535/, `endpoint ${bad} must be rejected`);
  }
});

test("parseToml rejects prototype-pollution keys", () => {
  assert.throws(() => parseToml("[__proto__]\nx = 1"), /forbidden key name/);
  assert.throws(() => parseToml("[[__proto__]]\nname = \"a\""), /forbidden key name/);
  assert.throws(() => parseToml("constructor = 1"), /forbidden key name/);
  // and it did not actually pollute Object.prototype
  assert.equal({}.x, undefined);
});

test("render computes cross-cluster peers (each excludes itself)", () => {
  const files = render(loadTopology());
  const hetzner = files["clusters/hetzner/topology.env"];
  assert.match(hetzner, /FIDUCIA_CLUSTER=hetzner/);
  // hetzner's peer list must NOT contain its own endpoint, but must contain the others.
  assert.doesNotMatch(hetzner, /FIDUCIA_PEERS=[^\n]*node\.hetzner\./);
  assert.match(hetzner, /FIDUCIA_PEERS=[^\n]*node\.vultr\./);
  // A brain member lists its OTHER brain peers, never itself.
  assert.match(hetzner, /FIDUCIA_BRAIN_PEERS=[^\n]*brain\.vultr\./);
  assert.doesNotMatch(hetzner, /FIDUCIA_BRAIN_PEERS=[^\n]*brain\.hetzner\./);
});

test("target nodes is the sum across clusters", () => {
  const t = loadTopology();
  const files = render(t);
  const sum = t.cluster.reduce((n, c) => n + c.node_replicas, 0);
  assert.match(files["clusters/hetzner/topology.env"], new RegExp(`FIDUCIA_TARGET_NODES=${sum}`));
});

test("edge region list mirrors lb endpoints", () => {
  const files = render(loadTopology());
  const regions = JSON.parse(files["generated/edge-regions.json"]);
  assert.deepEqual(regions.map((r) => r.name), ["hetzner", "vultr", "civo"]);
  assert.ok(regions.every((r) => r.url.startsWith("https://")));
});

test("checked-in generated files match a fresh render byte-for-byte", () => {
  const files = render(loadTopology());
  for (const [rel, content] of Object.entries(files)) {
    const onDisk = fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.equal(onDisk, content, `${rel} is stale — run: node tools/render.mjs`);
  }
});

// A node-only cluster (brain = false) — the documented way to add a 4th failure
// domain without disturbing the odd 3-member brain group. The production
// topology.toml keeps all clusters as brain members, so exercise this with a
// fixture: the three real brains + one spare node-only cluster.
function withNodeOnlySpare() {
  const t = loadTopology();
  const spare = {
    name: "spare",
    platform: "digitalocean",
    region: "fra1",
    storage_class: "do-block-storage",
    node_replicas: 5,
    brain: false,
    brain_endpoint: "brain.spare.fiducia.cloud:9095",
    node_peer_endpoint: "node.spare.fiducia.cloud:9090",
    lb_endpoint: "https://spare.lb.fiducia.cloud",
  };
  // Re-validate: 3 brain members (odd) + a node-only spare is a legal topology.
  return validateTopology({ ...t, cluster: [...t.cluster, spare] });
}

test("node-only cluster (brain=false) is excluded from the brain group", () => {
  const files = render(withNodeOnlySpare());
  // No brain cluster lists the spare as a brain peer, and the spare's overlay
  // carries no brain StatefulSet patch (it omits the brain Component).
  for (const c of ["hetzner", "vultr", "civo"]) {
    assert.doesNotMatch(files[`clusters/${c}/topology.env`], /FIDUCIA_BRAIN_PEERS=[^\n]*brain\.spare\./);
  }
  assert.doesNotMatch(files["clusters/spare/patches.yaml"], /name: fiducia-brain/);
  // A node-only cluster still reaches all three brains (its sidecar contacts them).
  const spare = files["clusters/spare/topology.env"];
  for (const b of ["hetzner", "vultr", "civo"]) {
    assert.match(spare, new RegExp(`FIDUCIA_BRAIN_PEERS=[^\\n]*brain\\.${b}\\.`));
  }
});

test("validateTopology rejects an even-sized brain group", () => {
  const t = loadTopology();
  // Add a 4th brain member → 4 members (even) → must be rejected.
  const fourthBrain = {
    name: "extra",
    platform: "scaleway",
    region: "fr-par",
    storage_class: "scw-bssd",
    node_replicas: 5,
    brain: true,
    brain_endpoint: "brain.extra.fiducia.cloud:9095",
    node_peer_endpoint: "node.extra.fiducia.cloud:9090",
    lb_endpoint: "https://extra.lb.fiducia.cloud",
  };
  const evenBrain = { ...t, cluster: [...t.cluster, fourthBrain] };
  assert.throws(() => validateTopology(evenBrain), /ODD number of members/);
});
