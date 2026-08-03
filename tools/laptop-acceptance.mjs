#!/usr/bin/env node
// Deterministic planning and strict validation for the DEN-946 physical laptop
// acceptance campaign. This tool never injects a fault or mutates a cluster.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const defaultSpecPath = path.join(root, "acceptance", "laptop-fleet", "campaign.json");
const SHA40_RE = /^[a-f0-9]{40}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROOF_RE = /^[a-z0-9][a-z0-9._:/-]{7,255}$/i;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export const REQUIRED_CLUSTERS = [
  "laptop-aws-sim",
  "laptop-gcp-sim",
  "laptop-azure-sim",
];

export const REQUIRED_SCENARIO_IDS = [
  "k3s-clean-restore",
  "fiducia-raft-clean-restore",
  "managed-database-restore",
  "jetstream-outbox-replay",
  "follower-laptop-power-loss",
  "fiducia-leader-power-loss",
  "jetstream-stream-leader-loss",
  "jetstream-meta-leader-loss",
  "primary-wan-loss",
  "asymmetric-mesh-partition",
  "cloudflared-connector-loss",
  "k3s-api-loss",
  "disk-mount-loss",
  "fiducia-member-stop",
  "jetstream-member-stop",
  "telemetry-path-loss",
  "disk-pressure",
  "high-io-latency",
  "bounded-clock-drift",
  "bounded-thermal-pressure",
  "failed-image-pull",
  "interrupted-upgrade",
  "lost-device-revocation",
  "replacement-laptop-rejoin",
  "public-port-exposure-scan",
  "alert-routing-matrix",
  "follower-first-maintenance-rollback",
  "seven-day-soak",
];

const CREDENTIAL_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /tskey-(?:auth|client)-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
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
  assert(Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_INTEGER, `${label} must be a non-negative safe integer`);
}

function positiveInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0 && value <= MAX_SAFE_INTEGER, `${label} must be a positive safe integer`);
}

function finiteRange(value, minimum, maximum, label) {
  assert(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum, `${label} must be in ${minimum}..${maximum}`);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function parseTimestamp(value, label) {
  assert(typeof value === "string", `${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  assert(!Number.isNaN(parsed.getTime()), `${label} must be an ISO timestamp`);
  return parsed;
}

function scanCredentials(value, location = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanCredentials(entry, `${location}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z0-9]/gi, "");
      assert(
        !/(password|secret|credential|privatekey|accesskey|authkey|sessiontoken|token)/i.test(normalized),
        `${location}.${key} is a forbidden credential-bearing key`,
      );
      scanCredentials(child, `${location}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    for (const pattern of CREDENTIAL_PATTERNS) {
      assert(!pattern.test(value), `${location} contains a credential-like value`);
    }
  }
}

export function loadJson(file) {
  assert(typeof file === "string" && file, "file path is required");
  assert(fs.existsSync(file), `file does not exist: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadAcceptanceSpec(file = defaultSpecPath) {
  return loadJson(file);
}

export function validateAcceptanceSpec(spec) {
  exactKeys(
    spec,
    [
      "schemaVersion",
      "campaignId",
      "requiredClusters",
      "minimumSoakHours",
      "minimumExternalProbeRegions",
      "minimumExternalAvailabilityPercent",
      "minimumDiskFreePercent",
      "maxCriticalFindings",
      "maxAcknowledgedMessageLoss",
      "maxDuplicateProtectedMutations",
      "maxFinalReplicationLag",
      "liveEvidenceMaxAgeHours",
      "scenarios",
    ],
    [],
    "spec",
  );
  assert(spec.schemaVersion === 1, "spec.schemaVersion must equal 1");
  assert(typeof spec.campaignId === "string" && /^[a-z0-9][a-z0-9-]{7,95}$/.test(spec.campaignId), "spec.campaignId is invalid");
  exactSet(spec.requiredClusters, REQUIRED_CLUSTERS, "spec.requiredClusters");
  assert(Number.isInteger(spec.minimumSoakHours) && spec.minimumSoakHours >= 168, "spec.minimumSoakHours must be at least 168");
  assert(Number.isInteger(spec.minimumExternalProbeRegions) && spec.minimumExternalProbeRegions >= 2, "spec.minimumExternalProbeRegions must be at least 2");
  finiteRange(spec.minimumExternalAvailabilityPercent, 0, 100, "spec.minimumExternalAvailabilityPercent");
  finiteRange(spec.minimumDiskFreePercent, 20, 100, "spec.minimumDiskFreePercent");
  assert(spec.maxCriticalFindings === 0, "spec.maxCriticalFindings must remain 0");
  assert(spec.maxAcknowledgedMessageLoss === 0, "spec.maxAcknowledgedMessageLoss must remain 0");
  assert(spec.maxDuplicateProtectedMutations === 0, "spec.maxDuplicateProtectedMutations must remain 0");
  assert(spec.maxFinalReplicationLag === 0, "spec.maxFinalReplicationLag must remain 0");
  assert(Number.isInteger(spec.liveEvidenceMaxAgeHours) && spec.liveEvidenceMaxAgeHours > 0 && spec.liveEvidenceMaxAgeHours <= 48, "spec.liveEvidenceMaxAgeHours must be in 1..48");

  assert(Array.isArray(spec.scenarios), "spec.scenarios must be an array");
  exactSet(spec.scenarios.map((scenario) => scenario.id), REQUIRED_SCENARIO_IDS, "spec scenario IDs");
  assert(new Set(spec.scenarios.map((scenario) => scenario.order)).size === spec.scenarios.length, "spec scenario order contains duplicates");

  const ordered = [...spec.scenarios].sort((a, b) => a.order - b.order);
  for (const [index, scenario] of ordered.entries()) {
    const label = `spec.scenarios[${index}]`;
    exactKeys(
      scenario,
      [
        "id",
        "order",
        "category",
        "execution",
        "destructive",
        "targetScope",
        "requiresAlert",
        "requiresRestore",
        "requiresQuorum",
        "allowedRtoSeconds",
        "allowedRpoSeconds",
        "phases",
      ],
      [],
      label,
    );
    assert(scenario.order === index + 1, `${label}.order must form a contiguous sequence starting at 1`);
    assert(typeof scenario.category === "string" && scenario.category.length >= 3, `${label}.category is invalid`);
    assert(scenario.execution === "manual", `${label}.execution must remain manual`);
    assert(typeof scenario.destructive === "boolean", `${label}.destructive must be boolean`);
    assert(typeof scenario.targetScope === "string" && scenario.targetScope.length >= 3, `${label}.targetScope is invalid`);
    for (const field of ["requiresAlert", "requiresRestore", "requiresQuorum"]) {
      assert(typeof scenario[field] === "boolean", `${label}.${field} must be boolean`);
    }
    nonNegativeInteger(scenario.allowedRtoSeconds, `${label}.allowedRtoSeconds`);
    nonNegativeInteger(scenario.allowedRpoSeconds, `${label}.allowedRpoSeconds`);
    exactSet(
      scenario.phases,
      scenario.id === "seven-day-soak" ? ["start", "daily", "complete"] : ["before", "fault", "recovered"],
      `${label}.phases`,
    );
  }

  const orderOf = (id) => ordered.find((scenario) => scenario.id === id).order;
  assert(orderOf("follower-laptop-power-loss") < orderOf("fiducia-leader-power-loss"), "follower power loss must precede leader power loss");
  assert(orderOf("lost-device-revocation") < orderOf("replacement-laptop-rejoin"), "lost-device revocation must precede replacement-member rejoin");
  assert(ordered.at(-1).id === "seven-day-soak", "seven-day-soak must be the final scenario");

  return {
    ...spec,
    scenarios: ordered,
    scenarioById: new Map(ordered.map((scenario) => [scenario.id, scenario])),
  };
}

export function assertScenarioId(spec, scenarioId) {
  const policy = validateAcceptanceSpec(spec);
  assert(policy.scenarioById.has(scenarioId), `unknown acceptance scenario ${JSON.stringify(scenarioId)}`);
  return policy.scenarioById.get(scenarioId);
}

function planActions(scenario) {
  if (scenario.id === "seven-day-soak") {
    return [
      { kind: "verify_campaign_preconditions" },
      { kind: "capture_checkpoint", phase: "start" },
      { kind: "begin_manual_soak", minimumHours: 168, automatedFaultInjection: false },
      { kind: "capture_daily_checkpoint", phase: "daily", minimumCount: 8 },
      { kind: "capture_checkpoint", phase: "complete" },
      { kind: "validate_soak_and_findings" },
    ];
  }
  return [
    { kind: "verify_campaign_preconditions" },
    { kind: "capture_checkpoint", phase: "before" },
    {
      kind: scenario.destructive ? "execute_manual_fault_or_restore" : "execute_manual_observation",
      automatedFaultInjection: false,
    },
    { kind: "capture_checkpoint", phase: "fault" },
    { kind: "execute_manual_recovery", automatedRecovery: false },
    { kind: "capture_checkpoint", phase: "recovered" },
    { kind: "validate_scenario_evidence" },
  ];
}

export function buildAcceptancePlan(spec) {
  const policy = validateAcceptanceSpec(spec);
  const scenarios = policy.scenarios.map((scenario) => ({
    ...scenario,
    automatedFaultInjection: false,
    actions: planActions(scenario),
  }));
  return {
    schemaVersion: 1,
    campaignId: policy.campaignId,
    planFingerprint: digest({
      campaignId: policy.campaignId,
      clusters: policy.requiredClusters,
      scenarios: policy.scenarios,
      thresholds: {
        minimumSoakHours: policy.minimumSoakHours,
        minimumExternalProbeRegions: policy.minimumExternalProbeRegions,
        minimumExternalAvailabilityPercent: policy.minimumExternalAvailabilityPercent,
        minimumDiskFreePercent: policy.minimumDiskFreePercent,
      },
    }),
    softwareOnly: true,
    clusters: policy.requiredClusters,
    scenarioCount: scenarios.length,
    scenarios,
    invariants: {
      faultsAreManual: scenarios.every((scenario) => scenario.automatedFaultInjection === false),
      oneScenarioAtATime: true,
      followerBeforeLeader: true,
      revocationBeforeReplacement: true,
      soakRunsLast: true,
      exampleEvidenceIsNeverProductionProof: true,
    },
    nonClaims: [
      "The plan does not inject faults or mutate a cluster.",
      "A passing software rehearsal is not physical acceptance evidence.",
      "DEN-946 remains open until fresh live artifacts and the launch decision are reviewed.",
    ],
  };
}

function validateArtifact(artifact, label, evidenceMode) {
  exactKeys(artifact, ["name", "sha256", "sizeBytes", "uriRef"], [], label);
  assert(typeof artifact.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(artifact.name), `${label}.name is invalid`);
  assert(typeof artifact.sha256 === "string" && SHA256_RE.test(artifact.sha256), `${label}.sha256 must be lowercase SHA-256`);
  positiveInteger(artifact.sizeBytes, `${label}.sizeBytes`);
  assert(typeof artifact.uriRef === "string" && PROOF_RE.test(artifact.uriRef), `${label}.uriRef is invalid`);
  if (evidenceMode === "live") assert(!artifact.uriRef.startsWith("example:"), `${label}.uriRef cannot use example evidence in live mode`);
}

function uniqueFingerprint(records, field, classification) {
  const values = records.map((record) => record[field]);
  const unique = new Set(values).size === values.length;
  if (classification === "limited-production") {
    assert(unique, `${field} values must be distinct for limited-production`);
  }
  return unique;
}

export function validateAcceptanceEvidence(evidence, spec, { allowExample = false, now = new Date() } = {}) {
  const policy = validateAcceptanceSpec(spec);
  scanCredentials(evidence);
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "evidenceMode",
      "campaignId",
      "startedAt",
      "completedAt",
      "pinnedRevision",
      "rollbackRevision",
      "failureDomains",
      "globalProof",
      "scenarios",
      "soak",
      "findings",
      "operatorDecision",
    ],
    [],
    "evidence",
  );
  assert(evidence.schemaVersion === 1, "evidence.schemaVersion must equal 1");
  assert(["example", "live"].includes(evidence.evidenceMode), "evidence.evidenceMode must be example or live");
  if (evidence.evidenceMode === "example" && !allowExample) fail("example acceptance evidence requires --allow-example");
  assert(evidence.campaignId === policy.campaignId, `evidence.campaignId must equal ${policy.campaignId}`);
  assert(SHA40_RE.test(evidence.pinnedRevision), "evidence.pinnedRevision must be an exact 40-character Git SHA");
  assert(SHA40_RE.test(evidence.rollbackRevision), "evidence.rollbackRevision must be an exact 40-character Git SHA");

  const startedAt = parseTimestamp(evidence.startedAt, "evidence.startedAt");
  const completedAt = parseTimestamp(evidence.completedAt, "evidence.completedAt");
  assert(startedAt < completedAt, "evidence.startedAt must precede completedAt");
  assert(completedAt <= now, "evidence.completedAt cannot be in the future");
  if (evidence.evidenceMode === "live") {
    const ageHours = (now - completedAt) / 3_600_000;
    assert(ageHours <= policy.liveEvidenceMaxAgeHours, `live acceptance evidence is older than ${policy.liveEvidenceMaxAgeHours} hours`);
  }

  exactKeys(evidence.operatorDecision, ["classification", "riskAcceptance", "customerLimit", "tenantDataLimitGiB", "rollbackAuthority", "cloudMigrationTrigger"], [], "operatorDecision");
  assert(["limited-production", "beta-only", "rejected"].includes(evidence.operatorDecision.classification), "operatorDecision.classification is invalid");
  assert(typeof evidence.operatorDecision.riskAcceptance === "string" && evidence.operatorDecision.riskAcceptance.length >= 16, "operatorDecision.riskAcceptance is too short");
  nonNegativeInteger(evidence.operatorDecision.customerLimit, "operatorDecision.customerLimit");
  nonNegativeInteger(evidence.operatorDecision.tenantDataLimitGiB, "operatorDecision.tenantDataLimitGiB");
  assert(typeof evidence.operatorDecision.rollbackAuthority === "string" && evidence.operatorDecision.rollbackAuthority.length >= 3, "operatorDecision.rollbackAuthority is invalid");
  assert(typeof evidence.operatorDecision.cloudMigrationTrigger === "string" && evidence.operatorDecision.cloudMigrationTrigger.length >= 16, "operatorDecision.cloudMigrationTrigger is invalid");

  exactKeys(evidence.failureDomains, ["clusters", "externalProbeRegions"], [], "failureDomains");
  assert(Array.isArray(evidence.failureDomains.clusters) && evidence.failureDomains.clusters.length === 3, "failureDomains.clusters must contain three records");
  exactSet(evidence.failureDomains.clusters.map((record) => record.cluster), policy.requiredClusters, "failure-domain clusters");
  for (const [index, record] of evidence.failureDomains.clusters.entries()) {
    exactKeys(record, ["cluster", "siteFingerprint", "ispFingerprint", "powerDomainFingerprint"], [], `failureDomains.clusters[${index}]`);
    for (const field of ["siteFingerprint", "ispFingerprint", "powerDomainFingerprint"]) {
      assert(typeof record[field] === "string" && SHA256_RE.test(record[field]), `failureDomains.clusters[${index}].${field} must be lowercase SHA-256`);
    }
  }
  exactSet(evidence.failureDomains.externalProbeRegions, [...new Set(evidence.failureDomains.externalProbeRegions)], "externalProbeRegions");
  assert(evidence.failureDomains.externalProbeRegions.length >= policy.minimumExternalProbeRegions, `at least ${policy.minimumExternalProbeRegions} external probe regions are required`);

  const classification = evidence.operatorDecision.classification;
  const distinctSites = uniqueFingerprint(evidence.failureDomains.clusters, "siteFingerprint", classification);
  const distinctIsps = uniqueFingerprint(evidence.failureDomains.clusters, "ispFingerprint", classification);
  const distinctPowerDomains = uniqueFingerprint(evidence.failureDomains.clusters, "powerDomainFingerprint", classification);
  if (classification === "beta-only") {
    assert(evidence.operatorDecision.customerLimit > 0, "beta-only requires a positive customerLimit");
  }
  if (classification === "rejected") {
    assert(evidence.operatorDecision.customerLimit === 0, "rejected classification requires customerLimit=0");
  }

  exactKeys(evidence.globalProof, ["backupCatalog", "recoveryKeyCustody", "publicExposureScan", "alertRouting", "changeFreeze"], [], "globalProof");
  for (const [key, value] of Object.entries(evidence.globalProof)) {
    assert(typeof value === "string" && PROOF_RE.test(value), `globalProof.${key} is invalid`);
    if (evidence.evidenceMode === "live") assert(!value.startsWith("example:"), `globalProof.${key} cannot use example evidence in live mode`);
  }

  assert(Array.isArray(evidence.scenarios), "evidence.scenarios must be an array");
  exactSet(evidence.scenarios.map((scenario) => scenario.id), REQUIRED_SCENARIO_IDS, "evidence scenario IDs");
  const scenarioById = new Map(evidence.scenarios.map((scenario) => [scenario.id, scenario]));
  let maximumObservedRtoSeconds = 0;
  let maximumObservedRpoSeconds = 0;
  let totalOperatorInterventions = 0;
  let passedScenarios = 0;

  for (const policyScenario of policy.scenarios) {
    const scenario = scenarioById.get(policyScenario.id);
    const label = `scenario.${policyScenario.id}`;
    exactKeys(
      scenario,
      [
        "id",
        "status",
        "startedAt",
        "completedAt",
        "targetClusters",
        "observedRole",
        "artifacts",
        "rtoSeconds",
        "rpoSeconds",
        "acknowledgedMessageLoss",
        "duplicateProtectedMutations",
        "finalReplicationLag",
        "minimumDiskFreePercent",
        "quorumPreserved",
        "restoreVerified",
        "alertDelivered",
        "safetyInvariantHeld",
        "operatorInterventions",
        "notes",
      ],
      [],
      label,
    );
    assert(scenario.status === "passed", `${label}.status must equal passed`);
    passedScenarios += 1;
    const scenarioStart = parseTimestamp(scenario.startedAt, `${label}.startedAt`);
    const scenarioEnd = parseTimestamp(scenario.completedAt, `${label}.completedAt`);
    assert(scenarioStart >= startedAt && scenarioEnd <= completedAt && scenarioStart < scenarioEnd, `${label} timestamps must fall inside the campaign`);
    assert(Array.isArray(scenario.targetClusters), `${label}.targetClusters must be an array`);
    assert(new Set(scenario.targetClusters).size === scenario.targetClusters.length, `${label}.targetClusters contains duplicates`);
    assert(scenario.targetClusters.every((cluster) => policy.requiredClusters.includes(cluster)), `${label}.targetClusters contains an unknown cluster`);
    if (policyScenario.targetScope === "fleet") exactSet(scenario.targetClusters, policy.requiredClusters, `${label}.targetClusters`);
    if (policyScenario.targetScope === "pairwise-path") assert(scenario.targetClusters.length === 2, `${label}.targetClusters must contain two clusters`);
    if (policyScenario.targetScope === "single-cluster" || policyScenario.targetScope === "single-site") assert(scenario.targetClusters.length === 1, `${label}.targetClusters must contain one cluster`);
    if (policyScenario.targetScope === "managed-service") assert(scenario.targetClusters.length === 0, `${label}.targetClusters must be empty`);
    assert(typeof scenario.observedRole === "string" && scenario.observedRole.length >= 3, `${label}.observedRole is invalid`);
    assert(Array.isArray(scenario.artifacts) && scenario.artifacts.length >= 1, `${label}.artifacts must be non-empty`);
    scenario.artifacts.forEach((artifact, index) => validateArtifact(artifact, `${label}.artifacts[${index}]`, evidence.evidenceMode));
    assert(new Set(scenario.artifacts.map((artifact) => artifact.sha256)).size === scenario.artifacts.length, `${label}.artifacts contains duplicate hashes`);

    nonNegativeInteger(scenario.rtoSeconds, `${label}.rtoSeconds`);
    nonNegativeInteger(scenario.rpoSeconds, `${label}.rpoSeconds`);
    assert(scenario.rtoSeconds <= policyScenario.allowedRtoSeconds, `${label}.rtoSeconds exceeds ${policyScenario.allowedRtoSeconds}`);
    assert(scenario.rpoSeconds <= policyScenario.allowedRpoSeconds, `${label}.rpoSeconds exceeds ${policyScenario.allowedRpoSeconds}`);
    maximumObservedRtoSeconds = Math.max(maximumObservedRtoSeconds, scenario.rtoSeconds);
    maximumObservedRpoSeconds = Math.max(maximumObservedRpoSeconds, scenario.rpoSeconds);

    assert(scenario.acknowledgedMessageLoss === policy.maxAcknowledgedMessageLoss, `${label}.acknowledgedMessageLoss must equal 0`);
    assert(scenario.duplicateProtectedMutations === policy.maxDuplicateProtectedMutations, `${label}.duplicateProtectedMutations must equal 0`);
    assert(scenario.finalReplicationLag === policy.maxFinalReplicationLag, `${label}.finalReplicationLag must equal 0`);
    finiteRange(scenario.minimumDiskFreePercent, policy.minimumDiskFreePercent, 100, `${label}.minimumDiskFreePercent`);
    assert(scenario.safetyInvariantHeld === true, `${label}.safetyInvariantHeld must be true`);
    if (policyScenario.requiresQuorum) assert(scenario.quorumPreserved === true, `${label}.quorumPreserved must be true`);
    if (policyScenario.requiresRestore) assert(scenario.restoreVerified === true, `${label}.restoreVerified must be true`);
    if (policyScenario.requiresAlert) assert(scenario.alertDelivered === true, `${label}.alertDelivered must be true`);
    nonNegativeInteger(scenario.operatorInterventions, `${label}.operatorInterventions`);
    totalOperatorInterventions += scenario.operatorInterventions;
    assert(typeof scenario.notes === "string" && scenario.notes.length >= 16, `${label}.notes is too short`);
  }

  exactKeys(
    evidence.soak,
    [
      "startedAt",
      "completedAt",
      "durationHours",
      "externalAvailabilityPercent",
      "acknowledgedMessageLoss",
      "duplicateProtectedMutations",
      "maximumFinalReplicationLag",
      "criticalFindings",
      "unresolvedHighFindings",
      "backupSuccessRatePercent",
      "minimumDiskFreePercent",
      "maximumCpuPercent",
      "maximumMemoryPercent",
      "maximumTemperatureC",
      "maximumClockDriftMilliseconds",
      "maximumPacketLossPercent",
      "operatorInterventions",
      "dailyCheckpointProofs",
    ],
    [],
    "soak",
  );
  const soakStartedAt = parseTimestamp(evidence.soak.startedAt, "soak.startedAt");
  const soakCompletedAt = parseTimestamp(evidence.soak.completedAt, "soak.completedAt");
  assert(soakStartedAt >= startedAt && soakCompletedAt <= completedAt && soakStartedAt < soakCompletedAt, "soak timestamps must fall inside the campaign");
  const measuredSoakHours = (soakCompletedAt - soakStartedAt) / 3_600_000;
  assert(evidence.soak.durationHours === measuredSoakHours, "soak.durationHours must match its timestamps exactly");
  assert(evidence.soak.durationHours >= policy.minimumSoakHours, `soak.durationHours must be at least ${policy.minimumSoakHours}`);
  finiteRange(evidence.soak.externalAvailabilityPercent, policy.minimumExternalAvailabilityPercent, 100, "soak.externalAvailabilityPercent");
  assert(evidence.soak.acknowledgedMessageLoss === 0, "soak.acknowledgedMessageLoss must equal 0");
  assert(evidence.soak.duplicateProtectedMutations === 0, "soak.duplicateProtectedMutations must equal 0");
  assert(evidence.soak.maximumFinalReplicationLag === 0, "soak.maximumFinalReplicationLag must equal 0");
  assert(evidence.soak.criticalFindings === 0, "soak.criticalFindings must equal 0");
  assert(evidence.soak.unresolvedHighFindings === 0, "soak.unresolvedHighFindings must equal 0");
  assert(evidence.soak.backupSuccessRatePercent === 100, "soak.backupSuccessRatePercent must equal 100");
  finiteRange(evidence.soak.minimumDiskFreePercent, policy.minimumDiskFreePercent, 100, "soak.minimumDiskFreePercent");
  finiteRange(evidence.soak.maximumCpuPercent, 0, 100, "soak.maximumCpuPercent");
  finiteRange(evidence.soak.maximumMemoryPercent, 0, 100, "soak.maximumMemoryPercent");
  finiteRange(evidence.soak.maximumTemperatureC, 0, 100, "soak.maximumTemperatureC");
  finiteRange(evidence.soak.maximumClockDriftMilliseconds, 0, 1000, "soak.maximumClockDriftMilliseconds");
  finiteRange(evidence.soak.maximumPacketLossPercent, 0, 5, "soak.maximumPacketLossPercent");
  nonNegativeInteger(evidence.soak.operatorInterventions, "soak.operatorInterventions");
  totalOperatorInterventions += evidence.soak.operatorInterventions;
  assert(Array.isArray(evidence.soak.dailyCheckpointProofs) && evidence.soak.dailyCheckpointProofs.length >= 8, "soak.dailyCheckpointProofs must contain at least eight checkpoints");
  assert(new Set(evidence.soak.dailyCheckpointProofs).size === evidence.soak.dailyCheckpointProofs.length, "soak.dailyCheckpointProofs contains duplicates");
  for (const [index, value] of evidence.soak.dailyCheckpointProofs.entries()) {
    assert(typeof value === "string" && PROOF_RE.test(value), `soak.dailyCheckpointProofs[${index}] is invalid`);
    if (evidence.evidenceMode === "live") assert(!value.startsWith("example:"), `soak.dailyCheckpointProofs[${index}] cannot use example evidence in live mode`);
  }

  assert(Array.isArray(evidence.findings), "evidence.findings must be an array");
  const unresolvedCritical = evidence.findings.filter((finding) => finding.severity === "critical" && finding.status !== "resolved");
  const unresolvedHigh = evidence.findings.filter((finding) => finding.severity === "high" && finding.status !== "resolved");
  assert(unresolvedCritical.length <= policy.maxCriticalFindings, "unresolved critical findings exceed the policy");
  assert(unresolvedHigh.length === 0, "unresolved high findings are not permitted");

  const allAcceptanceGatesPass =
    passedScenarios === policy.scenarios.length &&
    evidence.soak.criticalFindings === 0 &&
    evidence.soak.unresolvedHighFindings === 0 &&
    evidence.soak.acknowledgedMessageLoss === 0 &&
    evidence.soak.duplicateProtectedMutations === 0;

  if (classification === "limited-production") assert(allAcceptanceGatesPass, "limited-production requires every acceptance gate to pass");
  if (classification === "rejected") assert(!allAcceptanceGatesPass || evidence.findings.length > 0, "rejected classification requires a failed gate or finding");

  return {
    schemaVersion: 1,
    status: "passed",
    softwareOnly: true,
    evidenceMode: evidence.evidenceMode,
    campaignId: policy.campaignId,
    evidenceFingerprint: digest(evidence),
    pinnedRevision: evidence.pinnedRevision.toLowerCase(),
    rollbackRevision: evidence.rollbackRevision.toLowerCase(),
    launchClassification: classification,
    scenarioCount: policy.scenarios.length,
    passedScenarios,
    soakHours: evidence.soak.durationHours,
    maximumObservedRtoSeconds,
    maximumObservedRpoSeconds,
    totalOperatorInterventions,
    failureDomains: {
      distinctSites,
      distinctIsps,
      distinctPowerDomains,
      externalProbeRegions: evidence.failureDomains.externalProbeRegions.length,
    },
    safety: {
      acknowledgedMessageLoss: 0,
      duplicateProtectedMutations: 0,
      maximumFinalReplicationLag: 0,
      criticalFindings: 0,
      unresolvedHighFindings: 0,
    },
    nonClaims: [
      "Example evidence is never production proof.",
      "The validator does not independently execute faults or retrieve artifact references.",
      "A passing report still requires human review of the underlying physical evidence.",
    ],
  };
}

function usage() {
  return [
    "usage:",
    "  node tools/laptop-acceptance.mjs --plan [--spec <file>]",
    "  node tools/laptop-acceptance.mjs --evidence <file> [--spec <file>] [--allow-example] [--now <iso>]",
    "  node tools/laptop-acceptance.mjs --assert-scenario <id> [--spec <file>]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    spec: defaultSpecPath,
    evidence: null,
    allowExample: false,
    plan: false,
    assertScenario: null,
    now: new Date(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--spec") args.spec = path.resolve(argv[++index] ?? "");
    else if (arg === "--evidence") args.evidence = path.resolve(argv[++index] ?? "");
    else if (arg === "--allow-example") args.allowExample = true;
    else if (arg === "--plan") args.plan = true;
    else if (arg === "--assert-scenario") args.assertScenario = argv[++index] ?? "";
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
    const spec = loadAcceptanceSpec(args.spec);
    if (args.assertScenario !== null) {
      const scenario = assertScenarioId(spec, args.assertScenario);
      process.stdout.write(`${JSON.stringify(scenario, null, 2)}\n`);
      return;
    }
    if (args.plan) {
      process.stdout.write(`${JSON.stringify(buildAcceptancePlan(spec), null, 2)}\n`);
      return;
    }
    if (!args.evidence) fail(`--evidence or --plan is required\n${usage()}`);
    const evidence = loadJson(args.evidence);
    const report = validateAcceptanceEvidence(evidence, spec, {
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
