// Contract tests for the physical three-laptop production profile. No writes and
// no network access.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { renderLaptopFleet, validateLaptopTopology } from "./render-laptop-fleet.mjs";

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1, `invalid environment line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const nodePeerService = (clusterName) =>
  `fiducia-node-peer-${clusterName}.fiducia.svc.cluster.local:9090`;
const brainPeerService = (clusterName) =>
  `fiducia-brain-peer-${clusterName}.fiducia.svc.cluster.local:9095`;

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
    const values = parseEnv(env);
    const peers = topology.cluster.filter((candidate) => candidate.name !== cluster.name);

    assert.equal(values.FIDUCIA_CLUSTER, cluster.name);
    assert.equal(values.FIDUCIA_REPLICATION_FACTOR, "3");
    assert.equal(values.FIDUCIA_TARGET_NODES, "3");
    assert.equal(values.FIDUCIA_RAFT_CHECK_QUORUM, "on");
    assert.equal(values.FIDUCIA_SYNTHETIC_PROVIDER, cluster.synthetic_provider);
    assert.deepEqual(
      values.FIDUCIA_PEERS.split(",").sort(),
      peers.map((peer) => nodePeerService(peer.name)).sort(),
    );
    assert.deepEqual(
      values.FIDUCIA_BRAIN_PEERS.split(",").sort(),
      peers.map((peer) => brainPeerService(peer.name)).sort(),
    );
    assert.equal(values.FIDUCIA_PEERS.includes(nodePeerService(cluster.name)), false);
    assert.equal(values.FIDUCIA_BRAIN_PEERS.includes(brainPeerService(cluster.name)), false);
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
