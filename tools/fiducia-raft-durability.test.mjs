import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  loadDurabilityPolicy,
  validateDurabilityEvidence,
} from "./validate-fiducia-raft-durability-evidence.mjs";

const policy = loadDurabilityPolicy();
const examplePath = new URL("../durability/fiducia-raft-evidence.example.json", import.meta.url);
const example = () => JSON.parse(fs.readFileSync(examplePath, "utf8"));
const fixedNow = new Date("2026-08-03T20:30:00Z");
const clusters = ["laptop-aws-sim", "laptop-gcp-sim", "laptop-azure-sim"];

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function makeLive(value = example()) {
  value.evidenceMode = "live";
  value.observedAt = "2026-08-03T20:00:00Z";
  value.encryptionKeyring.activeKeyId = "live-key-2026-07";
  value.encryptionKeyring.requiredKeyIds = ["live-key-2026-01", "live-key-2026-07"];
  value.encryptionKeyring.custodyProofId = "live-proof-key-custody";
  for (const backup of value.backups) {
    backup.metadata.activeKeyId = value.encryptionKeyring.activeKeyId;
    backup.metadata.requiredKeyIds = [...value.encryptionKeyring.requiredKeyIds];
    backup.metadata.artifactId = backup.metadata.artifactId.replace(/^example-/, "live-");
  }
  value.cleanRoomRestore.providedKeyIds = [...value.encryptionKeyring.requiredKeyIds];
  value.cleanRoomRestore.proofId = "live-proof-clean-room-restore";
  for (const scenario of Object.values(value.scenarios)) {
    scenario.proofId = scenario.proofId.replace(/^example-/, "live-");
  }
  for (const key of Object.keys(value.proofs)) {
    value.proofs[key] = value.proofs[key].replace(/^example-/, "live-");
  }
  return value;
}

test("authoritative node and brain Raft data use retained PVCs, not data emptyDirs", () => {
  const manifests = [
    ["base/node/statefulset.yaml", "/var/lib/fiducia", "10Gi"],
    ["base/components/brain/statefulset.yaml", "/var/lib/fiducia-brain", "2Gi"],
  ];
  for (const [relativePath, dataDir, size] of manifests) {
    const manifest = read(relativePath);
    assert.match(manifest, /kind: StatefulSet/);
    assert.match(manifest, /updateStrategy:[\s\S]*type: OnDelete/);
    assert.match(manifest, /persistentVolumeClaimRetentionPolicy:[\s\S]*whenDeleted: Retain[\s\S]*whenScaled: Retain/);
    assert.ok(manifest.includes(`value: "${dataDir}"`));
    assert.match(manifest, new RegExp(`name: data, mountPath: ${dataDir.replaceAll("/", "\\/")}`));
    assert.match(manifest, /volumeClaimTemplates:[\s\S]*name: data[\s\S]*accessModes: \[ "ReadWriteOnce" \]/);
    assert.ok(manifest.includes(`storage: ${size}`));
    assert.doesNotMatch(manifest, /- name: data\n\s+emptyDir:/);
  }
});

test("every rendered laptop and canonical overlay preserves the full authoritative PVC spec", () => {
  const paths = [
    ...clusters.map((cluster) => `laptop/clusters/${cluster}/patches.yaml`),
    "clusters/hetzner/patches.yaml",
    "clusters/vultr/patches.yaml",
    "clusters/civo/patches.yaml",
  ];
  for (const relativePath of paths) {
    const patch = read(relativePath);
    assert.match(patch, /name: fiducia-node[\s\S]*volumeClaimTemplates:[\s\S]*name: data[\s\S]*accessModes: \[ "ReadWriteOnce" \][\s\S]*storage: 10Gi[\s\S]*storageClassName:/);
    assert.match(patch, /name: fiducia-brain[\s\S]*volumeClaimTemplates:[\s\S]*name: data[\s\S]*accessModes: \[ "ReadWriteOnce" \][\s\S]*storage: 2Gi[\s\S]*storageClassName:/);
    assert.doesNotMatch(patch, /name: fiducia-(?:node|brain)[\s\S]*- name: data\n\s+emptyDir:/);
  }
});

test("example evidence validates only with explicit non-production allowance", () => {
  assert.throws(
    () => validateDurabilityEvidence(example(), policy, { now: fixedNow }),
    /requires --allow-example/,
  );
  const report = validateDurabilityEvidence(example(), policy, {
    allowExample: true,
    now: fixedNow,
  });
  assert.equal(report.productionApproval, false);
  assert.equal(report.decision, "example-only");
  assert.equal(report.localPathWorkloads, 6);
  assert.equal(report.backupCount, 2);
  assert.equal(report.restore.representativeValueCount, 25);
  assert.match(report.evidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(report.warnings.join("\n"), /cannot approve production durability/i);
});

test("fresh live laptop evidence is eligible only with an explicit restore dependency", () => {
  const report = validateDurabilityEvidence(makeLive(), policy, { now: fixedNow });
  assert.equal(report.productionApproval, true);
  assert.equal(report.decision, "eligible-temporary-laptop-with-restore-dependency");
  assert.equal(report.localPathWorkloads, 6);
  assert.match(report.warnings.join("\n"), /do not survive laptop\/node loss/);
});

test("durable-provider classification requires expandable node-replacement storage", () => {
  const candidate = makeLive();
  candidate.substrateClassification = "durable-provider";
  for (const cluster of Object.values(candidate.clusters)) {
    cluster.substrate = "canonical-cloud";
    cluster.hostRootEncrypted = false;
    for (const storage of Object.values(cluster.workloads)) {
      storage.storageClass = "encrypted-network-block";
      storage.encryptionLayer = "provider-block-encryption";
      storage.nodeReplacementDurable = true;
      storage.expansionSupported = true;
    }
  }
  const report = validateDurabilityEvidence(candidate, policy, { now: fixedNow });
  assert.equal(report.decision, "eligible-durable-provider");
  assert.equal(report.localPathWorkloads, 0);

  candidate.clusters[clusters[0]].workloads["fiducia-node"].nodeReplacementDurable = false;
  assert.throws(
    () => validateDurabilityEvidence(candidate, policy, { now: fixedNow }),
    /must survive node replacement/,
  );
});

test("local-path cannot make a durable-provider claim or hide unencrypted host storage", () => {
  const durableClaim = makeLive();
  durableClaim.substrateClassification = "durable-provider";
  assert.throws(
    () => validateDurabilityEvidence(durableClaim, policy, { now: fixedNow }),
    /local-path is valid only for temporary-laptop|cannot contain local-path/,
  );

  const unencrypted = makeLive();
  unencrypted.clusters[clusters[0]].hostRootEncrypted = false;
  assert.throws(
    () => validateDurabilityEvidence(unencrypted, policy, { now: fixedNow }),
    /requires encrypted host root/,
  );
});

test("backup evidence requires application consistency, encryption, independence, immutability, checksum, retention, and freshness", () => {
  const cases = [
    ["application consistency", (value) => { value.backups[0].applicationConsistent = false; }, /applicationConsistent/],
    ["external encryption", (value) => { value.backups[0].encryptedBeforeExternalStorage = false; }, /encryptedBeforeExternalStorage/],
    ["independent destination", (value) => { value.backups[0].independentDestination = false; }, /independentDestination/],
    ["immutability", (value) => { value.backups[0].immutableRetention = false; }, /immutableRetention/],
    ["checksum", (value) => { value.backups[0].checksumVerified = false; }, /checksumVerified/],
    ["daily retention", (value) => { value.backups[0].dailyRestorePoints = 34; }, /dailyRestorePoints/],
    ["backup age", (value) => { value.backups[0].lastSuccessAt = "2026-08-01T00:00:00Z"; }, /older than policy/],
    ["snapshot interval", (value) => { value.backups[0].snapshotIntervalSeconds = 3601; }, /exceeds critical RPO/],
    ["checksum shape", (value) => { value.backups[0].metadata.checksum = "not-a-checksum"; }, /lowercase SHA-256/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const candidate = makeLive();
    mutate(candidate);
    assert.throws(
      () => validateDurabilityEvidence(candidate, policy, { now: fixedNow }),
      pattern,
      name,
    );
  }
});

test("backup and restore retain every historical encryption key ID", () => {
  const missingBackupKey = makeLive();
  missingBackupKey.backups[0].metadata.requiredKeyIds = [missingBackupKey.encryptionKeyring.activeKeyId];
  assert.throws(
    () => validateDurabilityEvidence(missingBackupKey, policy, { now: fixedNow }),
    /requiredKeyIds must exactly equal/,
  );

  const missingRestoreKey = makeLive();
  missingRestoreKey.cleanRoomRestore.providedKeyIds = [missingRestoreKey.encryptionKeyring.activeKeyId];
  assert.throws(
    () => validateDurabilityEvidence(missingRestoreKey, policy, { now: fixedNow }),
    /providedKeyIds must exactly equal/,
  );

  const activeMissing = makeLive();
  activeMissing.encryptionKeyring.requiredKeyIds = ["live-key-2026-01"];
  assert.throws(
    () => validateDurabilityEvidence(activeMissing, policy, { now: fixedNow }),
    /active key ID must be present/,
  );
});

test("clean-room restore proves revisions, CAS, auth, revocation, rotation, and key semantics", () => {
  for (const semantic of policy.requiredRestoreSemantics) {
    const candidate = makeLive();
    candidate.cleanRoomRestore.semantics[semantic] = false;
    assert.throws(
      () => validateDurabilityEvidence(candidate, policy, { now: fixedNow }),
      new RegExp(`semantics\\.${semantic}`),
    );
  }

  const copied = makeLive();
  copied.cleanRoomRestore.copiedMutableLiveData = true;
  assert.throws(() => validateDurabilityEvidence(copied, policy, { now: fixedNow }), /must not copy mutable live data/);

  const slow = makeLive();
  slow.cleanRoomRestore.rtoSeconds = policy.maximum_clean_restore_rto_seconds + 1;
  assert.throws(() => validateDurabilityEvidence(slow, policy, { now: fixedNow }), /rtoSeconds exceeds policy/);
});

test("all quorum-aware migration and disaster scenarios are mandatory and bounded", () => {
  const missing = makeLive();
  delete missing.scenarios[policy.requiredScenarios[0]];
  assert.throws(() => validateDurabilityEvidence(missing, policy, { now: fixedNow }), /scenarios\..*is required/);

  const lostQuorum = makeLive();
  lostQuorum.scenarios["single-member-loss"].quorumPreserved = false;
  assert.throws(() => validateDurabilityEvidence(lostQuorum, policy, { now: fixedNow }), /quorumPreserved must be true/);

  const slowReplacement = makeLive();
  slowReplacement.scenarios["single-member-replacement"].rtoSeconds = policy.maximum_member_replacement_rto_seconds + 1;
  assert.throws(() => validateDurabilityEvidence(slowReplacement, policy, { now: fixedNow }), /rtoSeconds exceeds policy/);
});

test("stale, self-approved, placeholder, critical, and secret-bearing live evidence fails closed", () => {
  const stale = makeLive();
  stale.observedAt = "2026-08-03T20:00:00Z";
  const staleNow = new Date("2026-08-05T20:30:00Z");
  assert.throws(() => validateDurabilityEvidence(stale, policy, { now: staleNow }), /stale/);

  const selfApproved = makeLive();
  selfApproved.approvals.reviewer.identity = selfApproved.approvals.operator.identity;
  assert.throws(() => validateDurabilityEvidence(selfApproved, policy, { now: fixedNow }), /must be distinct/);

  const placeholder = makeLive();
  placeholder.proofs[policy.requiredProofs[0]] = "example-proof-not-live";
  assert.throws(() => validateDurabilityEvidence(placeholder, policy, { now: fixedNow }), /cannot use example proof/);

  const critical = makeLive();
  critical.findings.push({ id: "storage-corruption", severity: "critical", resolved: false });
  assert.throws(() => validateDurabilityEvidence(critical, policy, { now: fixedNow }), /unresolved critical/);

  const secretField = makeLive();
  secretField.rawValue = "redacted";
  assert.throws(() => validateDurabilityEvidence(secretField, policy, { now: fixedNow }), /prohibited secret-bearing field/);

  const privateKey = makeLive();
  privateKey.findings.push({ id: "bad-evidence", severity: "low", resolved: true, note: "-----BEGIN PRIVATE KEY-----" });
  assert.throws(() => validateDurabilityEvidence(privateKey, policy, { now: fixedNow }), /private-key pattern/);
});

test("durability alert rules cover PVC, latency, lag, backup, key IDs, and restore age with bounded labels", () => {
  const rules = read("base/observability/raft-durability-prometheus-rules.yaml");
  for (const alert of [
    "FiduciaRaftPvcNotBound",
    "FiduciaRaftPvcUsageWarning",
    "FiduciaRaftPvcUsageCritical",
    "FiduciaRaftStorageWriteLatencyHigh",
    "FiduciaRaftMemberLagging",
    "FiduciaRaftApplicationSnapshotOld",
    "FiduciaRaftBackupOld",
    "FiduciaRaftBackupFailure",
    "FiduciaRaftBackupMissingHistoricalKey",
    "FiduciaRaftRestoreTestOld",
  ]) assert.match(rules, new RegExp(`alert: ${alert}`));
  assert.match(rules, /kubelet_volume_stats_used_bytes/);
  assert.match(rules, /fiducia_raft_member_lag_entries/);
  assert.match(rules, /fiducia_raft_backup_last_success_timestamp_seconds/);
  assert.match(rules, /fiducia_raft_restore_test_last_success_timestamp_seconds/);

  const promql = rules
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("expr:")
        || trimmed.includes("kubelet_volume_stats_")
        || trimmed.includes("kube_persistentvolumeclaim_status_phase")
        || trimmed.includes("fiducia_raft_")
        || trimmed.includes("histogram_quantile(")
        || trimmed.includes("clamp_min(")
        || trimmed.includes("rate(")
        || trimmed.includes("increase(")
        || trimmed === "time()";
    })
    .join("\n");
  assert.ok(promql.length > 0, "expected PromQL expressions in the durability rule bundle");
  assert.doesNotMatch(promql, /tenant_id|key_name|backup_url|member_uuid|token|customer_value/);
});

test("storage capture is read-only, context-bound, redacted, and cannot approve production", () => {
  const script = read("scripts/capture-fiducia-raft-storage-evidence.sh");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /umask 077/);
  assert.match(script, /fiducia\.cloud\/cluster=\$cluster/);
  assert.match(script, /get statefulsets fiducia-node fiducia-brain/);
  assert.match(script, /get persistentvolumeclaims/);
  assert.match(script, /get storageclass/);
  assert.match(script, /captureOnly: true/);
  assert.match(script, /productionApproval: false/);
  assert.match(script, /secretValues: "not-read"/);
  assert.match(script, /configMapValues: "not-read"/);
  assert.match(script, /chmod 600/);
  assert.doesNotMatch(script, /get secrets?\b|get configmaps?\b/i);
  assert.doesNotMatch(script, /\bkubectl\b[^\n]*(?:apply|patch|delete|replace|scale|rollout|cordon|drain)\b/);
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b|set -x|set -o xtrace/);
});

test("identical live evidence produces a deterministic report", () => {
  const first = validateDurabilityEvidence(makeLive(), policy, { now: fixedNow });
  const second = validateDurabilityEvidence(makeLive(), policy, { now: fixedNow });
  assert.deepEqual(first, second);
  assert.match(first.policyFingerprint, /^[a-f0-9]{64}$/);
});
