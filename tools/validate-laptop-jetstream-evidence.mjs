#!/usr/bin/env node
// Validate a bounded snapshot of live NATS/JetStream state for the three-laptop
// production profile. The validator consumes independently captured evidence;
// it does not connect to NATS or claim that example data is production proof.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NATS_CLUSTER_NAME,
  NATS_SERVER_VERSION,
  natsServerName,
} from "./render-laptop-messaging.mjs";
import { loadTopology } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const topologyPath = path.join(root, "laptop", "topology.toml");
const MAX_LIVE_AGE_MS = 10 * 60 * 1000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROOF_RE = /^[a-z0-9][a-z0-9._:/-]{7,255}$/;
const REQUIRED_GATES = [
  "clientAuth",
  "routeMtls",
  "outboxAuthoritative",
  "inboxDeduplication",
  "fiduciaFencing",
  "protectedMutationIdempotency",
  "dlqReplay",
  "backupSnapshot",
  "externalObjectStorage",
  "oneMemberFailureTest",
];
const REQUIRED_PROOFS = [
  "routeReport",
  "serverReport",
  "streamReport",
  "outboxReplay",
  "fencingAndIdempotency",
  "backupAndRestore",
  "oneMemberFailure",
];
const CREDENTIAL_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /tskey-(?:auth|client)-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional, label) {
  assert(isObject(value), `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) assert(Object.hasOwn(value, key), `${label}.${key} is required`);
  for (const key of Object.keys(value)) assert(allowed.has(key), `${label}.${key} is not allowed`);
}

function exactSet(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(new Set(actual).size === actual.length, `${label} contains duplicates`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(JSON.stringify(left) === JSON.stringify(right), `${label} must exactly equal [${right.join(", ")}]`);
}

function nonNegativeInteger(value, label) {
  assert(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer`);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function scanCredentials(value, location = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanCredentials(entry, `${location}[${index}]`));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assert(!/(password|secret|token|credential|privatekey|authkey|accesskey)/i.test(key.replace(/[^a-z0-9]/gi, "")), `${location}.${key} is a forbidden credential-bearing key`);
      scanCredentials(child, `${location}.${key}`);
    }
  } else if (typeof value === "string") {
    for (const pattern of CREDENTIAL_PATTERNS) assert(!pattern.test(value), `${location} contains a credential-like value`);
  }
}

function expectedServerRecords() {
  const topology = loadTopology(topologyPath);
  assert(topology.cluster.length === 3 && topology.replication_factor === 3, "laptop topology must remain three members with RF=3");
  return Object.fromEntries(
    topology.cluster.map((cluster) => [
      natsServerName(cluster.name),
      {
        clusterName: cluster.name,
        tags: [
          `site:${cluster.site}`,
          `cluster:${cluster.name}`,
          "substrate:laptop-k3s",
        ],
      },
    ]),
  );
}

export function validateJetStreamEvidence(evidence, { allowExample = false, now = new Date() } = {}) {
  scanCredentials(evidence);
  exactKeys(
    evidence,
    ["schemaVersion", "evidenceMode", "observedAt", "clusterName", "serverVersion", "metaLeader", "routeCaFingerprint", "servers", "stream", "gates", "proof"],
    [],
    "evidence",
  );
  assert(evidence.schemaVersion === 1, "schemaVersion must equal 1");
  assert(["example", "live"].includes(evidence.evidenceMode), "evidenceMode must be example or live");
  if (evidence.evidenceMode === "example" && !allowExample) fail("example JetStream evidence requires --allow-example");

  const observedAt = new Date(evidence.observedAt);
  assert(!Number.isNaN(observedAt.getTime()), "observedAt must be an ISO timestamp");
  assert(observedAt <= now, "observedAt cannot be in the future");
  if (evidence.evidenceMode === "live") {
    assert(now - observedAt <= MAX_LIVE_AGE_MS, "live JetStream evidence is older than ten minutes");
  }

  assert(evidence.clusterName === NATS_CLUSTER_NAME, `clusterName must equal ${NATS_CLUSTER_NAME}`);
  assert(evidence.serverVersion === NATS_SERVER_VERSION, `serverVersion must equal pinned version ${NATS_SERVER_VERSION}`);
  assert(typeof evidence.routeCaFingerprint === "string" && SHA256_RE.test(evidence.routeCaFingerprint), "routeCaFingerprint must be lowercase SHA-256");

  const records = expectedServerRecords();
  const expected = Object.keys(records);
  exactSet(evidence.servers.map((server) => server.name), expected, "server names");
  assert(expected.includes(evidence.metaLeader), "metaLeader must be a current server");

  const leafFingerprints = new Set();
  for (const [index, server] of evidence.servers.entries()) {
    const label = `servers[${index}]`;
    exactKeys(server, ["name", "serverTags", "routeTls", "routeCount", "routePeers", "leafCertificateFingerprint", "jetstreamEnabled", "storeDirectory", "fileStoreUsedBytes", "fileStoreLimitBytes", "diskFreePercent"], [], label);
    assert(expected.includes(server.name), `${label}.name is unknown`);
    exactSet(server.serverTags, records[server.name].tags, `${label}.serverTags`);
    assert(server.routeTls === true, `${label}.routeTls must be true`);
    assert(server.routeCount === 2, `${label}.routeCount must equal 2`);
    exactSet(server.routePeers, expected.filter((name) => name !== server.name), `${label}.routePeers`);
    assert(typeof server.leafCertificateFingerprint === "string" && SHA256_RE.test(server.leafCertificateFingerprint), `${label}.leafCertificateFingerprint must be lowercase SHA-256`);
    leafFingerprints.add(server.leafCertificateFingerprint);
    assert(server.jetstreamEnabled === true, `${label}.jetstreamEnabled must be true`);
    assert(server.storeDirectory === "/data/jetstream", `${label}.storeDirectory must be /data/jetstream`);
    nonNegativeInteger(server.fileStoreUsedBytes, `${label}.fileStoreUsedBytes`);
    assert(Number.isInteger(server.fileStoreLimitBytes) && server.fileStoreLimitBytes >= 8589934592, `${label}.fileStoreLimitBytes must be at least 8GiB`);
    assert(server.fileStoreUsedBytes < server.fileStoreLimitBytes, `${label} file store is exhausted`);
    assert(typeof server.diskFreePercent === "number" && server.diskFreePercent >= 20 && server.diskFreePercent <= 100, `${label}.diskFreePercent must be in 20..100`);
  }
  assert(leafFingerprints.size === 3, "every server must use a distinct route certificate");

  exactKeys(evidence.stream, ["name", "subjects", "storage", "replicas", "duplicateWindowSeconds", "messages", "bytes", "lostMessages", "leader", "replicaState"], [], "stream");
  assert(evidence.stream.name === "FIDUCIA_MESSAGES", "stream.name must equal FIDUCIA_MESSAGES");
  exactSet(evidence.stream.subjects, ["fiducia.>"], "stream.subjects");
  assert(evidence.stream.storage === "file", "stream.storage must be file");
  assert(evidence.stream.replicas === 3, "stream.replicas must equal 3");
  assert(Number.isInteger(evidence.stream.duplicateWindowSeconds) && evidence.stream.duplicateWindowSeconds >= 600, "stream.duplicateWindowSeconds must be at least 600");
  nonNegativeInteger(evidence.stream.messages, "stream.messages");
  nonNegativeInteger(evidence.stream.bytes, "stream.bytes");
  assert(evidence.stream.lostMessages === 0, "stream.lostMessages must equal 0");
  assert(expected.includes(evidence.stream.leader), "stream.leader must be a current server");
  assert(Array.isArray(evidence.stream.replicaState) && evidence.stream.replicaState.length === 2, "stream.replicaState must contain exactly two followers");
  exactSet(evidence.stream.replicaState.map((replica) => replica.name), expected.filter((name) => name !== evidence.stream.leader), "stream replica names");
  for (const [index, replica] of evidence.stream.replicaState.entries()) {
    const label = `stream.replicaState[${index}]`;
    exactKeys(replica, ["name", "current", "lag", "activeSeconds"], [], label);
    assert(replica.current === true, `${label}.current must be true`);
    assert(replica.lag === 0, `${label}.lag must equal 0`);
    assert(typeof replica.activeSeconds === "number" && replica.activeSeconds >= 0 && replica.activeSeconds <= 30, `${label}.activeSeconds must be in 0..30`);
  }

  exactKeys(evidence.gates, REQUIRED_GATES, [], "gates");
  for (const gate of REQUIRED_GATES) assert(evidence.gates[gate] === true, `gates.${gate} must be true`);

  exactKeys(evidence.proof, REQUIRED_PROOFS, [], "proof");
  const proofValues = [];
  for (const proof of REQUIRED_PROOFS) {
    const value = evidence.proof[proof];
    assert(typeof value === "string" && PROOF_RE.test(value), `proof.${proof} is invalid`);
    if (evidence.evidenceMode === "live") assert(!value.startsWith("example:"), `proof.${proof} cannot use example evidence in live mode`);
    proofValues.push(value);
  }
  assert(new Set(proofValues).size === proofValues.length, "proof identifiers must be distinct");

  return {
    schemaVersion: 1,
    status: "passed",
    evidenceMode: evidence.evidenceMode,
    observedAt: evidence.observedAt,
    evidenceFingerprint: digest(evidence),
    clusterName: evidence.clusterName,
    serverVersion: evidence.serverVersion,
    serverCount: 3,
    quorum: 2,
    metaLeader: evidence.metaLeader,
    stream: {
      name: evidence.stream.name,
      replicas: evidence.stream.replicas,
      leader: evidence.stream.leader,
      followersCurrent: 2,
      maximumFollowerLag: 0,
      duplicateWindowSeconds: evidence.stream.duplicateWindowSeconds,
      lostMessages: evidence.stream.lostMessages,
    },
    failureTolerance: {
      anyOneServerLossLeavesQuorum: true,
      twoServerLossesStopAuthoritativeWrites: true,
    },
    controls: Object.fromEntries(REQUIRED_GATES.map((gate) => [gate, true])),
    nonClaims: [
      "Example evidence is never production proof.",
      "The validator does not connect to NATS or independently verify proof identifiers.",
      "Live leader loss, replay, backup, restore, and protected-mutation tests remain required.",
    ],
  };
}

export function loadEvidence(file) {
  if (!file || !fs.existsSync(file)) fail(`evidence file does not exist: ${file || "(none)"}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid evidence JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usage() {
  return "usage: node tools/validate-laptop-jetstream-evidence.mjs --evidence <file> [--allow-example] [--now <iso-timestamp>]";
}

function parseArgs(argv) {
  const args = { evidence: null, allowExample: false, now: new Date() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--evidence") args.evidence = path.resolve(argv[++index] ?? "");
    else if (arg === "--allow-example") args.allowExample = true;
    else if (arg === "--now") {
      args.now = new Date(argv[++index] ?? "");
      if (Number.isNaN(args.now.getTime())) fail("--now must be an ISO timestamp");
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else fail(`unknown argument ${JSON.stringify(arg)}\n${usage()}`);
  }
  return args;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    if (!args.evidence) fail(`--evidence is required\n${usage()}`);
    const report = validateJetStreamEvidence(loadEvidence(args.evidence), {
      allowExample: args.allowExample,
      now: args.now,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
