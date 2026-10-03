// Contract tests for the physical three-laptop production profile. No writes and
// no network access.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { renderLaptopFleet, validateLaptopTopology } from "./render-laptop-fleet.mjs";

test("laptop topology models exactly three synthetic providers at three sites", () => {
  const { topology } = renderLaptopFleet();
  assert.deepEqual(topology.cluster.map((cluster) => cluster.synthetic_provider).sort(), ["aws", "azure", "gcp"]);
  assert.equal(new Set(topology.cluster.map((cluster) => cluster.site)).size, 3);
  assert.ok(topology.cluster.every((cluster) => cluster.platform === "local-laptop"));
  assert.ok(topology.cluster.every((cluster) => cluster.node_replicas === 1 && cluster.brain === true));
  assert.ok(topology.cluster.every((cluster) => cluster.storage_class === "local-path"));
});

test("laptop topology rejects correlated site declarations and overlapping CIDRs", () => {
  const { topology } = renderLaptopFleet();
  const sameSite = {
    ...topology,
    cluster: topology.cluster.map((cluster, index) => index === 1 ? { ...cluster, site: topology.cluster[0].site } : { ...cluster }),
  };
  assert.throws(() => validateLaptopTopology(sameSite), /unique physical site/);

  const overlap = {
    ...topology,
    cluster: topology.cluster.map((cluster, index) => index === 1 ? { ...cluster, pod_cidr: topology.cluster[0].pod_cidr } : { ...cluster }),
  };
  assert.throws(() => validateLaptopTopology(overlap), /CIDR overlap/);
});

test("rendered laptop membership excludes self and retains 2-of-3 quorum settings", () => {
  const { topology, files } = renderLaptopFleet();
  for (const cluster of topology.cluster) {
    const env = files[`laptop/clusters/${cluster.name}/topology.env`];
    assert.match(env, new RegExp(`FIDUCIA_CLUSTER=${cluster.name}`));
    assert.match(env, /FIDUCIA_REPLICATION_FACTOR=3/);
    assert.match(env, /FIDUCIA_TARGET_NODES=3/);
    assert.match(env, /FIDUCIA_RAFT_CHECK_QUORUM=on/);
    assert.match(env, new RegExp(`FIDUCIA_SYNTHETIC_PROVIDER=${cluster.synthetic_provider}`));
    assert.doesNotMatch(env, new RegExp(`FIDUCIA_PEERS=[^\\n]*${cluster.node_peer_endpoint.replaceAll(".", "\\.")}`));
    for (const peer of topology.cluster.filter((candidate) => candidate.name !== cluster.name)) {
      assert.ok(env.includes(peer.node_peer_endpoint), `${cluster.name} must include ${peer.name} node peer`);
      assert.ok(env.includes(peer.brain_endpoint), `${cluster.name} must include ${peer.name} brain peer`);
    }
  }
});

test("laptop overlays force local storage, zero voluntary node eviction, and private ingress service", () => {
  const { topology, files } = renderLaptopFleet();
  const component = fs.readFileSync(new URL("../laptop/components/substrate/kustomization.yaml", import.meta.url), "utf8");
  assert.match(component, /name: fiducia-load-balance/);
  assert.match(component, /value: ClusterIP/);

  for (const cluster of topology.cluster) {
    const patches = files[`laptop/clusters/${cluster.name}/patches.yaml`];
    assert.match(patches, /storageClassName: local-path/);
    assert.match(patches, /name: fiducia-node[\s\S]*maxUnavailable: 0/);
    assert.match(patches, /name: fiducia-brain/);

    const overlay = fs.readFileSync(new URL(`../laptop/clusters/${cluster.name}/kustomization.yaml`, import.meta.url), "utf8");
    assert.match(overlay, /\.\.\/\.\.\/\.\.\/base/);
    assert.match(overlay, /\.\.\/\.\.\/components\/substrate/);
    assert.match(overlay, new RegExp(`fiducia.cloud/synthetic-provider: ${cluster.synthetic_provider}`));
  }
});

test("generated K3s host configs are unique, encrypted, and disable public bundled ingress", () => {
  const { topology, files } = renderLaptopFleet();
  for (const cluster of topology.cluster) {
    const config = files[`laptop/hosts/${cluster.name}/k3s-config.yaml`];
    assert.match(config, /cluster-init: true/);
    assert.match(config, /secrets-encryption: true/);
    assert.match(config, /  - traefik/);
    assert.match(config, /  - servicelb/);
    assert.ok(config.includes(`cluster-cidr: ${cluster.pod_cidr}`));
    assert.ok(config.includes(`service-cidr: ${cluster.service_cidr}`));
    assert.ok(config.includes(cluster.kubernetes_api_hostname));
  }
});

test("checked-in laptop generated files match a fresh render byte-for-byte", () => {
  const { files } = renderLaptopFleet();
  for (const [relativePath, content] of Object.entries(files)) {
    const onDisk = fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    assert.equal(onDisk, content, `${relativePath} is stale — run: node tools/render-laptop-fleet.mjs`);
  }
});
