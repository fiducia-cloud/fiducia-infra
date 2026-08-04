#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseToml } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const defaultPolicyPath = path.join(root, "durability", "fiducia-raft-policy.toml");
const SHA40_RE = /^[a-f0-9]{40}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROOF_RE = /^[a-z0-9][a-z0-9._:/-]{7,255}$/i;
const SECRET_KEY_RE = /(?:password|passwd|secretValue|privateKey|accessKey|sessionToken|bearerToken|rawValue)/i;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bghp_[A-Za-z0-9]+\b/,
  /\bgithub_pat_[A-Za-z0-9_]+\b/,
  /\btskey-(?:auth|client)-[A-Za-z0-9_-]+\b/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/i,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
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

function splitList(value, field) {
  assert(typeof value === "string" && value.trim(), `${field} must be a non-empty comma-separated string`);
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  assert(new Set(items).size === items.length, `${field} contains duplicates`);
  return items;
}

function exactSet(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(new Set(actual).size === actual.length, `${label} contains duplicates`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(JSON.stringify(left) === JSON.stringify(right), `${label} must exactly equal [${right.join(", ")}]`);
}

function integer(value, label, minimum = 0) {
  assert(Number.isSafeInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`);
  return value;
}

function finite(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  assert(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum, `${label} must be in ${minimum}..${maximum}`);
  return value;
}

function timestamp(value, label) {
  assert(typeof value === "string", `${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  assert(!Number.isNaN(parsed.getTime()), `${label} must be an ISO timestamp`);
  return parsed;
}

function proof(value, label, evidenceMode) {
  assert(typeof value === "string" && PROOF_RE.test(value), `${label} must be an opaque proof identifier`);
  if (evidenceMode === "live") assert(!/^example(?:-|:|$)/i.test(value), `${label} cannot use example proof data in live mode`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function scanSecrets(value, location = "evidence") {
  if (typeof value === "string") {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      assert(!pattern.test(value), `${location} contains a prohibited credential or private-key pattern`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assert(!SECRET_KEY_RE.test(key), `${location}.${key} is a prohibited secret-bearing field`);
      scanSecrets(entry, `${location}.${key}`);
    }
  }
}

export function loadDurabilityPolicy(file = defaultPolicyPath) {
  assert(fs.existsSync(file), `missing durability policy: ${file}`);
  const raw = parseToml(fs.readFileSync(file, "utf8"));
  const policy = {
    ...raw,
    clusters: splitList(raw.clusters, "clusters"),
    authoritativeWorkloads: splitList(raw.authoritative_workloads, "authoritative_workloads"),
    requiredBackupMetadata: splitList(raw.required_backup_metadata, "required_backup_metadata"),
    requiredRestoreSemantics: splitList(raw.required_restore_semantics, "required_restore_semantics"),
    requiredScenarios: splitList(raw.required_scenarios, "required_scenarios"),
    requiredProofs: splitList(raw.required_proofs, "required_proofs"),
  };
  assert(typeof policy.policy_id === "string" && /^[a-z0-9][a-z0-9-]{7,95}$/.test(policy.policy_id), "policy_id is invalid");
  assert(policy.clusters.length === 3, "policy must define exactly three clusters");
  exactSet(policy.authoritativeWorkloads, ["fiducia-node", "fiducia-brain"], "authoritative_workloads");
  for (const field of [
    "node_minimum_capacity_gib",
    "brain_minimum_capacity_gib",
    "disk_warning_percent",
    "disk_critical_percent",
    "maximum_p99_write_latency_milliseconds",
    "maximum_final_member_lag_entries",
    "maximum_observation_age_hours",
    "maximum_backup_age_hours",
    "maximum_restore_test_age_days",
    "maximum_critical_rpo_seconds",
    "maximum_member_replacement_rto_seconds",
    "maximum_clean_restore_rto_seconds",
    "minimum_daily_restore_points",
    "minimum_monthly_restore_points",
    "minimum_quarterly_restore_points",
  ]) integer(policy[field], field, 0);
  assert(policy.disk_warning_percent < policy.disk_critical_percent, "disk warning threshold must be below critical");
  for (const field of [
    "require_application_consistent_snapshot",
    "require_encryption_before_external_storage",
    "require_independent_destination",
    "require_immutable_retention",
    "require_checksum",
    "require_full_historical_key_set",
    "require_distinct_operator_and_reviewer",
    "allow_temporary_local_path",
  ]) assert(typeof policy[field] === "boolean", `${field} must be boolean`);
  return policy;
}

function validateWorkloadStorage(workloadName, storage, cluster, evidence, policy, label) {
  exactKeys(
    storage,
    [
      "dataDir",
      "storageSource",
      "storageClass",
      "capacityGiB",
      "accessMode",
      "bound",
      "retentionWhenDeleted",
      "retentionWhenScaled",
      "encryptedAtRest",
      "encryptionLayer",
      "nodeReplacementDurable",
      "expansionSupported",
      "maximumObservedP99WriteLatencyMilliseconds",
      "finalMemberLagEntries",
    ],
    [],
    label,
  );
  const expectedDataDir = workloadName === "fiducia-node" ? policy.node_data_dir : policy.brain_data_dir;
  const minimumCapacity = workloadName === "fiducia-node"
    ? policy.node_minimum_capacity_gib
    : policy.brain_minimum_capacity_gib;
  assert(storage.dataDir === expectedDataDir, `${label}.dataDir must equal ${expectedDataDir}`);
  assert(storage.storageSource === "persistentVolumeClaim", `${label}.storageSource must be persistentVolumeClaim`);
  assert(typeof storage.storageClass === "string" && storage.storageClass.trim(), `${label}.storageClass is required`);
  finite(storage.capacityGiB, `${label}.capacityGiB`, minimumCapacity);
  assert(storage.accessMode === policy.required_access_mode, `${label}.accessMode must equal ${policy.required_access_mode}`);
  assert(storage.bound === true, `${label}.bound must be true`);
  assert(storage.retentionWhenDeleted === policy.required_pvc_retention_when_deleted, `${label}.retentionWhenDeleted must equal Retain`);
  assert(storage.retentionWhenScaled === policy.required_pvc_retention_when_scaled, `${label}.retentionWhenScaled must equal Retain`);
  assert(storage.encryptedAtRest === true, `${label}.encryptedAtRest must be true`);
  assert(typeof storage.encryptionLayer === "string" && storage.encryptionLayer.trim(), `${label}.encryptionLayer is required`);
  assert(typeof storage.nodeReplacementDurable === "boolean", `${label}.nodeReplacementDurable must be boolean`);
  assert(typeof storage.expansionSupported === "boolean", `${label}.expansionSupported must be boolean`);
  finite(storage.maximumObservedP99WriteLatencyMilliseconds, `${label}.maximumObservedP99WriteLatencyMilliseconds`, 0);
  assert(
    storage.maximumObservedP99WriteLatencyMilliseconds <= policy.maximum_p99_write_latency_milliseconds,
    `${label}.maximumObservedP99WriteLatencyMilliseconds exceeds policy`,
  );
  integer(storage.finalMemberLagEntries, `${label}.finalMemberLagEntries`, 0);
  assert(storage.finalMemberLagEntries <= policy.maximum_final_member_lag_entries, `${label}.finalMemberLagEntries exceeds policy`);

  const localPath = storage.storageClass === "local-path";
  if (localPath) {
    assert(policy.allow_temporary_local_path, `${label} uses local-path but policy forbids it`);
    assert(evidence.substrateClassification === "temporary-laptop", `${label} local-path is valid only for temporary-laptop classification`);
    assert(cluster.substrate === "laptop-k3s", `${label} local-path must belong to laptop-k3s`);
    assert(cluster.hostRootEncrypted === true, `${label} local-path requires encrypted host root`);
    assert(storage.encryptionLayer === "host-luks2", `${label} local-path requires host-luks2 encryption evidence`);
    assert(storage.nodeReplacementDurable === false, `${label} local-path must not claim node-replacement durability`);
  } else {
    assert(storage.nodeReplacementDurable === true, `${label} provider storage must survive node replacement`);
    assert(storage.expansionSupported === true, `${label} provider storage must support expansion`);
  }
  return localPath;
}

function validateBackup(backup, policy, evidence, now, label) {
  exactKeys(
    backup,
    [
      "workload",
      "applicationConsistent",
      "snapshotIntervalSeconds",
      "lastSuccessAt",
      "encryptedBeforeExternalStorage",
      "independentDestination",
      "immutableRetention",
      "checksumVerified",
      "dailyRestorePoints",
      "monthlyRestorePoints",
      "quarterlyRestorePoints",
      "metadata",
    ],
    [],
    label,
  );
  assert(policy.authoritativeWorkloads.includes(backup.workload), `${label}.workload is unknown`);
  assert(backup.applicationConsistent === policy.require_application_consistent_snapshot, `${label}.applicationConsistent must be true`);
  integer(backup.snapshotIntervalSeconds, `${label}.snapshotIntervalSeconds`, 1);
  assert(backup.snapshotIntervalSeconds <= policy.maximum_critical_rpo_seconds, `${label}.snapshotIntervalSeconds exceeds critical RPO`);
  const successAt = timestamp(backup.lastSuccessAt, `${label}.lastSuccessAt`);
  assert(successAt <= now, `${label}.lastSuccessAt cannot be in the future`);
  assert((now - successAt) / 3_600_000 <= policy.maximum_backup_age_hours, `${label} backup is older than policy`);
  assert(backup.encryptedBeforeExternalStorage === policy.require_encryption_before_external_storage, `${label}.encryptedBeforeExternalStorage must be true`);
  assert(backup.independentDestination === policy.require_independent_destination, `${label}.independentDestination must be true`);
  assert(backup.immutableRetention === policy.require_immutable_retention, `${label}.immutableRetention must be true`);
  assert(backup.checksumVerified === policy.require_checksum, `${label}.checksumVerified must be true`);
  integer(backup.dailyRestorePoints, `${label}.dailyRestorePoints`, policy.minimum_daily_restore_points);
  integer(backup.monthlyRestorePoints, `${label}.monthlyRestorePoints`, policy.minimum_monthly_restore_points);
  integer(backup.quarterlyRestorePoints, `${label}.quarterlyRestorePoints`, policy.minimum_quarterly_restore_points);

  exactKeys(backup.metadata, policy.requiredBackupMetadata, [], `${label}.metadata`);
  assert(typeof backup.metadata.clusterId === "string" && backup.metadata.clusterId.trim(), `${label}.metadata.clusterId is required`);
  assert(Array.isArray(backup.metadata.memberSet) && backup.metadata.memberSet.length === 3, `${label}.metadata.memberSet must contain three members`);
  assert(new Set(backup.metadata.memberSet).size === 3, `${label}.metadata.memberSet contains duplicates`);
  integer(backup.metadata.appliedIndex, `${label}.metadata.appliedIndex`, 1);
  integer(backup.metadata.revision, `${label}.metadata.revision`, 1);
  integer(backup.metadata.schemaVersion, `${label}.metadata.schemaVersion`, 1);
  const createdAt = timestamp(backup.metadata.createdAt, `${label}.metadata.createdAt`);
  assert(createdAt <= successAt, `${label}.metadata.createdAt cannot follow lastSuccessAt`);
  assert(typeof backup.metadata.checksum === "string" && SHA256_RE.test(backup.metadata.checksum), `${label}.metadata.checksum must be lowercase SHA-256`);
  assert(backup.metadata.activeKeyId === evidence.encryptionKeyring.activeKeyId, `${label}.metadata.activeKeyId differs from live keyring`);
  exactSet(backup.metadata.requiredKeyIds, evidence.encryptionKeyring.requiredKeyIds, `${label}.metadata.requiredKeyIds`);
  proof(backup.metadata.artifactId, `${label}.metadata.artifactId`, evidence.evidenceMode);
}

function validateRestore(restore, policy, evidence, now) {
  exactKeys(
    restore,
    [
      "isolatedCluster",
      "newPersistentVolumes",
      "copiedMutableLiveData",
      "startedAt",
      "completedAt",
      "rtoSeconds",
      "rpoSeconds",
      "providedKeyIds",
      "representativeValueCount",
      "semantics",
      "proofId",
    ],
    [],
    "cleanRoomRestore",
  );
  assert(restore.isolatedCluster === true, "cleanRoomRestore.isolatedCluster must be true");
  assert(restore.newPersistentVolumes === true, "cleanRoomRestore.newPersistentVolumes must be true");
  assert(restore.copiedMutableLiveData === false, "cleanRoomRestore must not copy mutable live data");
  const startedAt = timestamp(restore.startedAt, "cleanRoomRestore.startedAt");
  const completedAt = timestamp(restore.completedAt, "cleanRoomRestore.completedAt");
  assert(completedAt > startedAt && completedAt <= now, "cleanRoomRestore timestamps are invalid");
  assert((now - completedAt) / 86_400_000 <= policy.maximum_restore_test_age_days, "clean-room restore evidence is too old");
  integer(restore.rtoSeconds, "cleanRoomRestore.rtoSeconds", 0);
  integer(restore.rpoSeconds, "cleanRoomRestore.rpoSeconds", 0);
  assert(restore.rtoSeconds <= policy.maximum_clean_restore_rto_seconds, "cleanRoomRestore.rtoSeconds exceeds policy");
  assert(restore.rpoSeconds <= policy.maximum_critical_rpo_seconds, "cleanRoomRestore.rpoSeconds exceeds policy");
  exactSet(restore.providedKeyIds, evidence.encryptionKeyring.requiredKeyIds, "cleanRoomRestore.providedKeyIds");
  integer(restore.representativeValueCount, "cleanRoomRestore.representativeValueCount", 1);
  exactKeys(restore.semantics, policy.requiredRestoreSemantics, [], "cleanRoomRestore.semantics");
  for (const semantic of policy.requiredRestoreSemantics) {
    assert(restore.semantics[semantic] === true, `cleanRoomRestore.semantics.${semantic} must be true`);
  }
  proof(restore.proofId, "cleanRoomRestore.proofId", evidence.evidenceMode);
  return { startedAt, completedAt };
}

function validateApprovals(approvals, policy, campaignEndedAt) {
  exactKeys(approvals, ["operator", "reviewer"], [], "approvals");
  for (const role of ["operator", "reviewer"]) {
    exactKeys(approvals[role], ["identity", "approvedAt"], [], `approvals.${role}`);
    assert(typeof approvals[role].identity === "string" && approvals[role].identity.trim(), `approvals.${role}.identity is required`);
    const approvedAt = timestamp(approvals[role].approvedAt, `approvals.${role}.approvedAt`);
    assert(approvedAt >= campaignEndedAt, `approvals.${role}.approvedAt must be after campaign end`);
  }
  if (policy.require_distinct_operator_and_reviewer) {
    assert(approvals.operator.identity !== approvals.reviewer.identity, "operator and reviewer must be distinct identities");
  }
}

export function validateDurabilityEvidence(evidence, policy, { allowExample = false, now = new Date() } = {}) {
  assert(isObject(evidence), "evidence must be an object");
  scanSecrets(evidence);
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "evidenceMode",
      "policyId",
      "observedAt",
      "campaignStartedAt",
      "campaignEndedAt",
      "gitRevision",
      "substrateClassification",
      "clusters",
      "encryptionKeyring",
      "backups",
      "cleanRoomRestore",
      "scenarios",
      "proofs",
      "findings",
      "approvals",
    ],
    [],
    "evidence",
  );
  assert(evidence.schemaVersion === 1, "schemaVersion must equal 1");
  assert(["example", "live"].includes(evidence.evidenceMode), "evidenceMode must be example or live");
  if (evidence.evidenceMode === "example" && !allowExample) fail("example durability evidence requires --allow-example");
  assert(evidence.policyId === policy.policy_id, "policyId does not match policy");
  assert(SHA40_RE.test(evidence.gitRevision), "gitRevision must be an exact 40-character Git SHA");
  assert(["temporary-laptop", "durable-provider"].includes(evidence.substrateClassification), "substrateClassification is invalid");

  const observedAt = timestamp(evidence.observedAt, "observedAt");
  const campaignStartedAt = timestamp(evidence.campaignStartedAt, "campaignStartedAt");
  const campaignEndedAt = timestamp(evidence.campaignEndedAt, "campaignEndedAt");
  assert(campaignEndedAt > campaignStartedAt, "campaignEndedAt must follow campaignStartedAt");
  assert(observedAt >= campaignEndedAt && observedAt <= now, "observedAt must be after campaign and not in the future");
  if (evidence.evidenceMode === "live") {
    assert((now - observedAt) / 3_600_000 <= policy.maximum_observation_age_hours, "live durability evidence is stale");
  }

  exactKeys(evidence.clusters, policy.clusters, [], "clusters");
  let localPathWorkloads = 0;
  for (const clusterName of policy.clusters) {
    const cluster = evidence.clusters[clusterName];
    exactKeys(cluster, ["substrate", "hostRootEncrypted", "workloads"], [], `clusters.${clusterName}`);
    assert(typeof cluster.substrate === "string" && cluster.substrate.trim(), `clusters.${clusterName}.substrate is required`);
    assert(typeof cluster.hostRootEncrypted === "boolean", `clusters.${clusterName}.hostRootEncrypted must be boolean`);
    exactKeys(cluster.workloads, policy.authoritativeWorkloads, [], `clusters.${clusterName}.workloads`);
    for (const workloadName of policy.authoritativeWorkloads) {
      if (validateWorkloadStorage(
        workloadName,
        cluster.workloads[workloadName],
        cluster,
        evidence,
        policy,
        `clusters.${clusterName}.workloads.${workloadName}`,
      )) localPathWorkloads += 1;
    }
  }
  if (evidence.substrateClassification === "durable-provider") {
    assert(localPathWorkloads === 0, "durable-provider classification cannot contain local-path authoritative storage");
  }

  exactKeys(evidence.encryptionKeyring, ["activeKeyId", "requiredKeyIds", "custodyProofId"], [], "encryptionKeyring");
  proof(evidence.encryptionKeyring.activeKeyId, "encryptionKeyring.activeKeyId", evidence.evidenceMode);
  assert(Array.isArray(evidence.encryptionKeyring.requiredKeyIds) && evidence.encryptionKeyring.requiredKeyIds.length >= 1, "encryptionKeyring.requiredKeyIds must be non-empty");
  assert(new Set(evidence.encryptionKeyring.requiredKeyIds).size === evidence.encryptionKeyring.requiredKeyIds.length, "encryptionKeyring.requiredKeyIds contains duplicates");
  for (const [index, keyId] of evidence.encryptionKeyring.requiredKeyIds.entries()) {
    proof(keyId, `encryptionKeyring.requiredKeyIds[${index}]`, evidence.evidenceMode);
  }
  assert(evidence.encryptionKeyring.requiredKeyIds.includes(evidence.encryptionKeyring.activeKeyId), "active key ID must be present in required key IDs");
  proof(evidence.encryptionKeyring.custodyProofId, "encryptionKeyring.custodyProofId", evidence.evidenceMode);

  assert(Array.isArray(evidence.backups) && evidence.backups.length === policy.authoritativeWorkloads.length, "backups must contain one record per authoritative workload");
  exactSet(evidence.backups.map((backup) => backup.workload), policy.authoritativeWorkloads, "backup workloads");
  evidence.backups.forEach((backup, index) => validateBackup(backup, policy, evidence, now, `backups[${index}]`));

  const restoreTimes = validateRestore(evidence.cleanRoomRestore, policy, evidence, now);
  assert(campaignStartedAt <= restoreTimes.startedAt && campaignEndedAt >= restoreTimes.completedAt, "clean-room restore must occur inside the campaign window");

  exactKeys(evidence.scenarios, policy.requiredScenarios, [], "scenarios");
  for (const scenarioName of policy.requiredScenarios) {
    const scenario = evidence.scenarios[scenarioName];
    const required = scenarioName === "single-member-replacement"
      ? ["passed", "quorumPreserved", "rtoSeconds", "proofId"]
      : ["passed", "quorumPreserved", "proofId"];
    exactKeys(scenario, required, [], `scenarios.${scenarioName}`);
    assert(scenario.passed === true, `scenarios.${scenarioName}.passed must be true`);
    assert(scenario.quorumPreserved === true, `scenarios.${scenarioName}.quorumPreserved must be true`);
    if (scenarioName === "single-member-replacement") {
      integer(scenario.rtoSeconds, `scenarios.${scenarioName}.rtoSeconds`, 0);
      assert(scenario.rtoSeconds <= policy.maximum_member_replacement_rto_seconds, `scenarios.${scenarioName}.rtoSeconds exceeds policy`);
    }
    proof(scenario.proofId, `scenarios.${scenarioName}.proofId`, evidence.evidenceMode);
  }

  exactKeys(evidence.proofs, policy.requiredProofs, [], "proofs");
  for (const proofName of policy.requiredProofs) proof(evidence.proofs[proofName], `proofs.${proofName}`, evidence.evidenceMode);

  assert(Array.isArray(evidence.findings), "findings must be an array");
  const unresolvedCritical = evidence.findings.filter((finding) => finding?.severity === "critical" && finding?.resolved !== true);
  assert(unresolvedCritical.length === 0, "findings contains unresolved critical issues");

  validateApprovals(evidence.approvals, policy, campaignEndedAt);

  const productionApproval = evidence.evidenceMode === "live";
  return {
    schemaVersion: 1,
    policyId: policy.policy_id,
    evidenceMode: evidence.evidenceMode,
    evidenceFingerprint: digest(evidence),
    policyFingerprint: digest(policy),
    productionApproval,
    decision: !productionApproval
      ? "example-only"
      : evidence.substrateClassification === "temporary-laptop"
        ? "eligible-temporary-laptop-with-restore-dependency"
        : "eligible-durable-provider",
    substrateClassification: evidence.substrateClassification,
    clusters: policy.clusters.length,
    authoritativeWorkloads: policy.authoritativeWorkloads,
    localPathWorkloads,
    backupCount: evidence.backups.length,
    restore: {
      rtoSeconds: evidence.cleanRoomRestore.rtoSeconds,
      rpoSeconds: evidence.cleanRoomRestore.rpoSeconds,
      representativeValueCount: evidence.cleanRoomRestore.representativeValueCount,
    },
    keyring: {
      activeKeyId: evidence.encryptionKeyring.activeKeyId,
      requiredKeyIdCount: evidence.encryptionKeyring.requiredKeyIds.length,
    },
    warnings: !productionApproval
      ? ["Example evidence validates structure only and cannot approve production durability."]
      : localPathWorkloads > 0
        ? ["Authoritative local-path PVCs do not survive laptop/node loss; external backup and clean restore remain mandatory."]
        : [],
  };
}

function usage() {
  return "usage: node tools/validate-fiducia-raft-durability-evidence.mjs --evidence <json> [--policy <toml>] [--allow-example] [--now <iso>]";
}

function parseArgs(argv) {
  const args = { policy: defaultPolicyPath, evidence: null, allowExample: false, now: new Date() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--policy") args.policy = path.resolve(argv[++index] ?? "");
    else if (arg === "--evidence") args.evidence = path.resolve(argv[++index] ?? "");
    else if (arg === "--allow-example") args.allowExample = true;
    else if (arg === "--now") args.now = timestamp(argv[++index], "--now");
    else if (arg === "--help" || arg === "-h") args.help = true;
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
    assert(args.evidence && fs.existsSync(args.evidence), `--evidence must name an existing JSON file\n${usage()}`);
    const policy = loadDurabilityPolicy(args.policy);
    const evidence = JSON.parse(fs.readFileSync(args.evidence, "utf8"));
    const report = validateDurabilityEvidence(evidence, policy, {
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
