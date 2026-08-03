import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  NATS_CLUSTER_NAME,
  NATS_ROUTE_PORT,
  natsRouteServiceDns,
  natsServerName,
  renderLaptopMessaging,
  validateMessagingTopology,
} from "./render-laptop-messaging.mjs";
import { renderClusterTailnetBundle, renderTailnetPolicy } from "./render-laptop-tailnet.mjs";
import { loadEvidence, validateJetStreamEvidence } from "./validate-laptop-jetstream-evidence.mjs";

const fixedNow = new Date("2026-08-03T18:05:00Z");
const exampleUrl = new URL("../laptop/messaging/jetstream-evidence.example.json", import.meta.url);
const exampleEvidence = () => structuredClone(loadEvidence(exampleUrl.pathname));
const tailnetInputs = { operator: "operator@example.com", tailnetDomain: "example.ts.net" };

test("renderer creates exactly three unique explicit-route mTLS JetStream members", () => {
  const { topology, files } = renderLaptopMessaging();
  assert.equal(topology.cluster.length, 3);
  assert.equal(topology.replication_factor, 3);

  for (const cluster of topology.cluster) {
    const relativePath = `laptop/clusters/${cluster.name}/nats.conf`;
    const config = files[relativePath];
    const expectedPeers = topology.cluster.filter((candidate) => candidate.name !== cluster.name);

    assert.match(config, new RegExp(`server_name: ${natsServerName(cluster.name)}`));
    assert.match(config, new RegExp(`name: ${NATS_CLUSTER_NAME}`));
    assert.match(config, new RegExp(`listen: "0\\.0\\.0\\.0:${NATS_ROUTE_PORT}"`));
    assert.match(config, /no_advertise: true/);
    assert.match(config, /pool_size: 1/);
    assert.match(config, /cert_file: "\/etc\/nats\/route-tls\/tls\.crt"/);
    assert.match(config, /key_file: "\/etc\/nats\/route-tls\/tls\.key"/);
    assert.match(config, /ca_file: "\/etc\/nats\/route-tls\/ca\.crt"/);
    assert.match(config, /verify: true/);
    assert.match(config, /include \.\/auth\/auth\.conf/);
    assert.doesNotMatch(config, /advertise:/);
    assert.doesNotMatch(config, /password|token|credential/i);

    const routeLines = config.split("\n").filter((line) => line.trim().startsWith("nats://"));
    assert.equal(routeLines.length, 2);
    assert.doesNotMatch(config, new RegExp(natsRouteServiceDns(cluster.name).replaceAll(".", "\\.")));
    for (const peer of expectedPeers) {
      assert.ok(config.includes(`nats://${natsRouteServiceDns(peer.name)}:${NATS_ROUTE_PORT}`));
    }
  }
});

test("checked-in NATS configurations match a fresh render byte-for-byte", () => {
  const { files } = renderLaptopMessaging();
  for (const [relativePath, content] of Object.entries(files)) {
    const onDisk = fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    assert.equal(onDisk, content, `${relativePath} is stale — run: node tools/render-laptop-messaging.mjs`);
  }
});

test("messaging topology rejects identity, replication, platform, and storage drift", () => {
  const { topology } = renderLaptopMessaging();

  const weakReplication = structuredClone(topology);
  weakReplication.replication_factor = 1;
  assert.throws(() => validateMessagingTopology(weakReplication), /replication_factor=3/);

  const duplicate = structuredClone(topology);
  duplicate.cluster[1].name = duplicate.cluster[0].name;
  assert.throws(() => validateMessagingTopology(duplicate), /names must be unique/);

  const cloudPlatform = structuredClone(topology);
  cloudPlatform.cluster[0].platform = "hetzner";
  assert.throws(() => validateMessagingTopology(cloudPlatform), /platform=local-laptop/);

  const wrongStorage = structuredClone(topology);
  wrongStorage.cluster[0].storage_class = "longhorn";
  assert.throws(() => validateMessagingTopology(wrongStorage), /local-path storage/);
});

test("every laptop overlay replaces the single-node config and mounts the route TLS component", () => {
  const { topology } = renderLaptopMessaging();
  for (const cluster of topology.cluster) {
    const overlay = fs.readFileSync(new URL(`../laptop/clusters/${cluster.name}/kustomization.yaml`, import.meta.url), "utf8");
    assert.match(overlay, /\.\.\/\.\.\/components\/messaging-ha/);
    assert.match(overlay, /name: fiducia-nats-config[\s\S]*behavior: replace[\s\S]*nats\.conf=nats\.conf/);
  }

  const component = fs.readFileSync(new URL("../laptop/components/messaging-ha/kustomization.yaml", import.meta.url), "utf8");
  assert.match(component, /containerPort: 6222[\s\S]*name: route/);
  assert.match(component, /secretName: fiducia-nats-route-tls[\s\S]*optional: false/);
  assert.match(component, /mountPath: \/etc\/nats\/route-tls/);

  const policy = fs.readFileSync(new URL("../laptop/components/messaging-ha/networkpolicy.yaml", import.meta.url), "utf8");
  assert.match(policy, /kubernetes\.io\/metadata\.name: tailscale/);
  assert.equal((policy.match(/port: 6222/g) ?? []).length, 2);
  assert.doesNotMatch(policy, /port: 4222|port: 8222|port: 7777/);
});

test("tailnet exposes only the NATS route plane and denies client-plane escalation", () => {
  const policy = renderTailnetPolicy(tailnetInputs);
  assert.deepEqual(policy.tagOwners["tag:fiducia-nats-route"], ["tag:k8s-operator"]);
  const routeGrant = policy.grants.find((grant) => grant.dst.includes("tag:fiducia-nats-route"));
  assert.deepEqual(routeGrant, {
    src: ["tag:fiducia-peer-egress"],
    dst: ["tag:fiducia-nats-route"],
    ip: ["tcp:6222"],
  });
  const egressTest = policy.tests.find((entry) => entry.src === "tag:fiducia-peer-egress");
  assert.ok(egressTest.accept.includes("tag:fiducia-nats-route:6222"));
  assert.ok(egressTest.deny.includes("tag:fiducia-nats-route:4222"));

  const bundle = renderClusterTailnetBundle({ clusterName: "laptop-aws-sim", ...tailnetInputs });
  assert.match(bundle.manifest, /name: fiducia-nats-route-tailnet[\s\S]*tailscale\.com\/hostname: fiducia-nats-route-laptop-aws-sim[\s\S]*port: 6222/);
  assert.equal((bundle.manifest.match(/name: fiducia-nats-route-laptop-(?:gcp|azure)-sim-tailnet/g) ?? []).length, 2);
  assert.equal((bundle.manifest.match(/type: ExternalName/g) ?? []).length, 6);
  assert.doesNotMatch(bundle.manifest, /fiducia-nats-route[^\n]*[\s\S]{0,300}port: 4222/);
});

test("route TLS materialization validates trust, SANs, lifetime, key matching, and context", () => {
  const script = fs.readFileSync(new URL("../scripts/apply-laptop-nats-route-tls.sh", import.meta.url), "utf8");
  assert.match(script, /openssl verify -CAfile/);
  assert.match(script, /-checkend 604800/);
  assert.match(script, /certificate and private key do not match/);
  assert.match(script, /DNS:fiducia-nats-route-\$cluster\.\$tailnet_domain/);
  assert.match(script, /DNS:fiducia-nats-route-\$cluster-tailnet\.fiducia\.svc\.cluster\.local/);
  assert.match(script, /fiducia\.cloud\/cluster=\$cluster,fiducia\.cloud\/substrate=laptop-k3s/);
  assert.match(script, /--from-file="tls\.key=\$key_file"/);
  assert.match(script, /Secret must contain exactly three keys/);
  assert.doesNotMatch(script, /--from-literal|set -x|set -o xtrace/);
});

test("example JetStream evidence is explicit and validates a healthy RF3 stream", () => {
  assert.throws(() => validateJetStreamEvidence(exampleEvidence(), { now: fixedNow }), /requires --allow-example/);
  const report = validateJetStreamEvidence(exampleEvidence(), { allowExample: true, now: fixedNow });
  assert.equal(report.status, "passed");
  assert.equal(report.serverCount, 3);
  assert.equal(report.quorum, 2);
  assert.equal(report.stream.replicas, 3);
  assert.equal(report.stream.followersCurrent, 2);
  assert.equal(report.stream.maximumFollowerLag, 0);
  assert.equal(report.stream.lostMessages, 0);
  assert.equal(report.failureTolerance.anyOneServerLossLeavesQuorum, true);
  assert.equal(report.failureTolerance.twoServerLossesStopAuthoritativeWrites, true);
  assert.match(report.evidenceFingerprint, /^[a-f0-9]{64}$/);
});

test("live evidence fails closed on stale observations, route loss, lag, RF drift, or missing safety gates", () => {
  const live = exampleEvidence();
  live.evidenceMode = "live";
  live.observedAt = "2026-08-03T18:04:00Z";
  for (const key of Object.keys(live.proof)) live.proof[key] = live.proof[key].replace(/^example:/, "evidence:");
  assert.doesNotThrow(() => validateJetStreamEvidence(live, { now: fixedNow }));

  const stale = structuredClone(live);
  stale.observedAt = "2026-08-03T17:00:00Z";
  assert.throws(() => validateJetStreamEvidence(stale, { now: fixedNow }), /older than ten minutes/);

  const lostRoute = structuredClone(live);
  lostRoute.servers[0].routeCount = 1;
  assert.throws(() => validateJetStreamEvidence(lostRoute, { now: fixedNow }), /routeCount must equal 2/);

  const lagging = structuredClone(live);
  lagging.stream.replicaState[0].lag = 1;
  assert.throws(() => validateJetStreamEvidence(lagging, { now: fixedNow }), /lag must equal 0/);

  const rfOne = structuredClone(live);
  rfOne.stream.replicas = 1;
  assert.throws(() => validateJetStreamEvidence(rfOne, { now: fixedNow }), /replicas must equal 3/);

  const noFencing = structuredClone(live);
  noFencing.gates.fiduciaFencing = false;
  assert.throws(() => validateJetStreamEvidence(noFencing, { now: fixedNow }), /fiduciaFencing must be true/);

  const exampleProof = structuredClone(live);
  exampleProof.proof.streamReport = "example:jetstream:stream";
  assert.throws(() => validateJetStreamEvidence(exampleProof, { now: fixedNow }), /cannot use example evidence/);
});

test("server, route, stream, and proof identities must be exact and unique", () => {
  const duplicateServer = exampleEvidence();
  duplicateServer.servers[1].name = duplicateServer.servers[0].name;
  assert.throws(() => validateJetStreamEvidence(duplicateServer, { allowExample: true, now: fixedNow }), /server names contains duplicates/);

  const selfRoute = exampleEvidence();
  selfRoute.servers[0].routePeers[0] = selfRoute.servers[0].name;
  assert.throws(() => validateJetStreamEvidence(selfRoute, { allowExample: true, now: fixedNow }), /routePeers must exactly equal/);

  const duplicateCert = exampleEvidence();
  duplicateCert.servers[1].leafCertificateFingerprint = duplicateCert.servers[0].leafCertificateFingerprint;
  assert.throws(() => validateJetStreamEvidence(duplicateCert, { allowExample: true, now: fixedNow }), /distinct route certificate/);

  const duplicateProof = exampleEvidence();
  duplicateProof.proof.serverReport = duplicateProof.proof.routeReport;
  assert.throws(() => validateJetStreamEvidence(duplicateProof, { allowExample: true, now: fixedNow }), /proof identifiers must be distinct/);
});
