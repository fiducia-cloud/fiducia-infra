import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadTopology } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));
const clusters = ["laptop-aws-sim", "laptop-gcp-sim", "laptop-azure-sim"];

function occurrences(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function routeHosts(config) {
  return [...config.matchAll(/(?:nats|tls):\/\/[^@\s"']*@?([^:\/\s"']+):6222/g)].map((match) => match[1]);
}

test("three laptop clusters form one explicit JetStream route group", () => {
  const topology = loadTopology(path.join(root, "laptop", "topology.toml"));
  assert.deepEqual(topology.cluster.map((cluster) => cluster.name).sort(), [...clusters].sort());
  assert.equal(topology.replication_factor, 3);
  assert.equal(topology.auth_required, true);

  for (const cluster of clusters) {
    const configPath = `laptop/clusters/${cluster}/nats.conf`;
    assert.equal(exists(configPath), true, `${configPath} must be generated and committed`);
    const config = read(configPath);

    assert.match(config, /jetstream\s*\{/);
    assert.match(config, /store_dir\s*:\s*["']?\/data\/jetstream/);
    assert.match(config, /cluster\s*\{/);
    assert.match(config, /name\s*:\s*["']?fiducia-laptop-production/);
    assert.match(config, /listen\s*:\s*["']?0\.0\.0\.0:6222/);
    assert.match(config, /no_advertise\s*:\s*true/);
    assert.match(config, /pool_size\s*:\s*1/);

    assert.match(config, /tls\s*\{/);
    assert.match(config, /verify\s*:\s*true/);
    assert.match(config, /ca_file\s*:\s*["']?\/etc\/nats-route-tls\/ca\.crt/);
    assert.match(config, /cert_file\s*:\s*["']?\/etc\/nats-route-tls\/tls\.crt/);
    assert.match(config, /key_file\s*:\s*["']?\/etc\/nats-route-tls\/tls\.key/);

    const peers = clusters.filter((candidate) => candidate !== cluster);
    const hosts = routeHosts(config);
    assert.equal(hosts.length, 2, `${cluster} must declare exactly two remote route peers`);
    assert.equal(new Set(hosts).size, 2, `${cluster} route peers must be unique`);
    assert.equal(hosts.some((host) => host.includes(cluster)), false, `${cluster} must not route to itself`);
    for (const peer of peers) {
      assert.equal(
        hosts.some((host) => host.includes(peer)),
        true,
        `${cluster} must route explicitly to ${peer}`,
      );
    }
  }
});

test("base NATS workload is digest pinned, persistent, route-TLS mounted, and drainable", () => {
  const statefulSet = read("base/messaging/nats.statefulset.yaml");
  assert.match(statefulSet, /image:\s*nats:2\.12\.4-alpine@sha256:[0-9a-f]{64}/);
  assert.match(statefulSet, /name:\s*fiducia-nats-route-tls/);
  assert.match(statefulSet, /mountPath:\s*\/etc\/nats-route-tls/);
  assert.match(statefulSet, /readOnly:\s*true/);
  assert.match(statefulSet, /mountPath:\s*\/data/);
  assert.match(statefulSet, /volumeClaimTemplates:/);
  assert.match(statefulSet, /terminationGracePeriodSeconds:/);
  assert.match(statefulSet, /preStop:/);
  assert.match(statefulSet, /drain|SIGTERM|TERM/i);
  assert.match(statefulSet, /routez/);
  assert.doesNotMatch(statefulSet, /image:\s*nats:(?:latest|main|dev)(?:\s|$)/);

  const service = read("base/messaging/nats.service.yaml");
  assert.match(service, /name:\s*client[\s\S]*port:\s*4222/);
  assert.match(service, /name:\s*cluster[\s\S]*port:\s*6222/);

  const configMap = read("base/messaging/nats.configmap.yaml");
  assert.match(configMap, /nats\.conf:/);
  assert.match(configMap, /include.*auth/i);
});

test("cross-cluster exposure is limited to route TLS on port 6222", () => {
  const component = read("laptop/components/messaging-ha/kustomization.yaml");
  assert.match(component, /networkpolicy\.yaml/);
  assert.match(component, /nats-route-sentinel\.yaml/);

  const policy = read("laptop/components/messaging-ha/networkpolicy.yaml");
  assert.match(policy, /kind:\s*NetworkPolicy/);
  assert.match(policy, /port:\s*6222/);
  assert.doesNotMatch(policy, /port:\s*4222/);

  const sentinel = read("laptop/components/messaging-ha/nats-route-sentinel.yaml");
  assert.match(sentinel, /routez/);
  assert.match(sentinel, /2|two/i);
  assert.match(sentinel, /peer|route/i);

  for (const cluster of clusters) {
    const overlay = read(`laptop/clusters/${cluster}/kustomization.yaml`);
    assert.match(overlay, /components\/messaging-ha/);
    assert.match(overlay, /nats\.conf/);
  }
});

test("route credential installer validates private keys, SANs, EKU, and cluster context", () => {
  const script = read("scripts/apply-laptop-nats-route-tls.sh");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /openssl/);
  assert.match(script, /extendedKeyUsage|serverAuth|clientAuth/);
  assert.match(script, /subjectAltName|SAN/i);
  assert.match(script, /pubkey|public key/i);
  assert.match(script, /fiducia\.cloud\/cluster/);
  assert.match(script, /fiducia\.cloud\/substrate=laptop-k3s/);
  assert.match(script, /create secret generic fiducia-nats-route-tls/);
  assert.match(script, /--dry-run=client/);
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b/);
});

test("provisioning and evidence paths fail closed and keep secrets out of Git", () => {
  const provision = read("scripts/provision-laptop-jetstream.sh");
  const replay = read("scripts/rehearse-laptop-jetstream-replay.sh");
  const validator = read("tools/validate-laptop-jetstream-evidence.mjs");
  const deliveryPolicy = read("laptop/messaging/delivery-policy.toml");

  assert.match(provision, /set -euo pipefail/);
  assert.match(provision, /replicas?[^\n]*3|--replicas[^\n]*3/i);
  assert.match(provision, /stream|consumer/i);
  assert.match(provision, /fencing|idempot/i);
  assert.match(replay, /set -euo pipefail/);
  assert.match(replay, /replay|redeliver|consumer/i);
  assert.match(validator, /evidenceMode/);
  assert.match(validator, /example/);
  assert.match(validator, /observedAt|timestamp/);
  assert.match(validator, /lag|replica/i);
  assert.match(deliveryPolicy, /replicas?\s*=\s*3/i);
  assert.match(deliveryPolicy, /outbox|inbox|idempot|fenc/i);

  const trackedFiles = [
    "laptop/messaging/delivery-policy.toml",
    "docs/laptop-jetstream-ha.md",
    "scripts/apply-laptop-nats-route-tls.sh",
    "scripts/provision-laptop-jetstream.sh",
    "scripts/rehearse-laptop-jetstream-replay.sh",
  ].map(read).join("\n");
  assert.doesNotMatch(trackedFiles, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.doesNotMatch(trackedFiles, /ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|tskey-(?:auth|client)-[A-Za-z0-9_-]+/);
});

test("documentation distinguishes software contracts from live production evidence", () => {
  const docs = read("docs/laptop-jetstream-ha.md");
  assert.match(docs, /DEN-945/);
  assert.match(docs, /three|3/i);
  assert.match(docs, /mTLS|mutual TLS/i);
  assert.match(docs, /one-member-at-a-time|one member at a time/i);
  assert.match(docs, /leader.*last|follower.*first/i);
  assert.match(docs, /outbox|inbox/i);
  assert.match(docs, /fencing/i);
  assert.match(docs, /live|physical|not.*evidence/i);
});
