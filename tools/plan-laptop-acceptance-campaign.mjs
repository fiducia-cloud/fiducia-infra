#!/usr/bin/env node
// Build and abstractly rehearse the three-laptop production acceptance campaign.
// CI may use example preflight evidence only with --allow-example. Live execution
// still requires physical actions, independently captured evidence, and human
// stop authority.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadTopology } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const defaultCampaignPath = path.join(root, "laptop", "acceptance", "campaign.json");
const topologyPath = path.join(root, "laptop", "topology.toml");
const MAX_LIVE_PREFLIGHT_AGE_MS = 10 * 60 * 1000;
const SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROOF_RE = /^[a-z0-9][a-z0-9._:/-]{7,255}$/;
const EXECUTIONS = new Set([
  "automated-kubernetes",
  "manual-bounded",
  "manual-physical",
  "manual-security",
  "manual-destructive",
  "manual-observed",
]);
const SCOPES = new Set(["per-cluster", "fleet-once"]);
const REQUIRED_CLUSTER_GATES = [
  "kubernetes",
  "gitops",
  "tailnet",
  "cloudflareTunnel",
  "fiducia",
  "jetstream",
  "storage",
  "hostMonitoring",
  "backupUpload",
];
const FORBIDDEN_KEY = /(?:password|passwd|secret|token|credential|privatekey|authkey|accesskey)/i;
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

function timestamp(value, label) {
  const parsed = new Date(value);
  assert(typeof value === "string" && !Number.isNaN(parsed.getTime()), `${label} must be an ISO timestamp`);
  return parsed;
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

function scanCredentials(value, location = "input") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanCredentials(entry, `${location}[${index}]`));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assert(!FORBIDDEN_KEY.test(key.replace(/[^a-z0-9]/gi, "")), `${location}.${key} is a forbidden credential-bearing key`);
      scanCredentials(child, `${location}.${key}`);
    }
  } else if (typeof value === "string") {
    for (const pattern of CREDENTIAL_PATTERNS) {
      assert(!pattern.test(value), `${location} contains a credential-like value`);
    }
  }
}

function clustersFromTopology() {
  const topology = loadTopology(topologyPath);
  assert(topology.cluster_id === "fiducia-prod", "laptop topology must retain cluster_id=fiducia-prod");
  assert(topology.replication_factor === 3, "laptop topology must retain replication_factor=3");
  assert(topology.cluster.length === 3, "laptop topology must contain exactly three clusters");
  return topology.cluster.map((cluster) => cluster.name);
}

export function loadJson(file, label) {
  if (!file || !fs.existsSync(file)) fail(`${label} file does not exist: ${file || "(none)"}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateCampaignSpec(spec) {
  scanCredentials(spec, "campaign");
  exactKeys(
    spec,
    [
      "schemaVersion",
      "campaignId",
      "maxConcurrentFaults",
      "minimumHealthyFiduciaVoters",
      "minimumHealthyJetStreamMembers",
      "minimumHealthyPublicOrigins",
      "requiredExternalProbeRegions",
      "soakHours",
      "engineeringTargets",
      "requiredGlobalGates",
      "scenarios",
    ],
    [],
    "campaign",
  );
  assert(spec.schemaVersion === 1, "campaign.schemaVersion must equal 1");
  assert(typeof spec.campaignId === "string" && /^[a-z0-9][a-z0-9-]{2,62}$/.test(spec.campaignId), "campaignId must be a DNS-like identifier");
  assert(spec.maxConcurrentFaults === 1, "maxConcurrentFaults must equal 1");
  assert(spec.minimumHealthyFiduciaVoters === 2, "minimumHealthyFiduciaVoters must equal 2");
  assert(spec.minimumHealthyJetStreamMembers === 2, "minimumHealthyJetStreamMembers must equal 2");
  assert(spec.minimumHealthyPublicOrigins === 2, "minimumHealthyPublicOrigins must equal 2");
  assert(Number.isInteger(spec.requiredExternalProbeRegions) && spec.requiredExternalProbeRegions >= 2, "requiredExternalProbeRegions must be at least 2");
  assert(Number.isInteger(spec.soakHours) && spec.soakHours >= 168, "soakHours must be at least 168");

  exactKeys(
    spec.engineeringTargets,
    ["publicFailoverSeconds", "memberRecoverySeconds", "replacementHostRecoverySeconds", "fullFleetRecoverySeconds", "criticalRpoSeconds"],
    [],
    "campaign.engineeringTargets",
  );
  for (const [key, value] of Object.entries(spec.engineeringTargets)) {
    assert(Number.isInteger(value) && value > 0, `campaign.engineeringTargets.${key} must be a positive integer`);
  }
  assert(spec.engineeringTargets.publicFailoverSeconds <= 300, "publicFailoverSeconds must not exceed 300");
  assert(spec.engineeringTargets.criticalRpoSeconds <= 3600, "criticalRpoSeconds must not exceed 3600");

  assert(Array.isArray(spec.requiredGlobalGates) && spec.requiredGlobalGates.length >= 10, "requiredGlobalGates must be a nonempty safety list");
  assert(new Set(spec.requiredGlobalGates).size === spec.requiredGlobalGates.length, "requiredGlobalGates contains duplicates");
  for (const gate of spec.requiredGlobalGates) assert(/^[a-z][A-Za-z0-9]+$/.test(gate), `invalid global gate ${gate}`);

  assert(Array.isArray(spec.scenarios) && spec.scenarios.length >= 15, "campaign must contain the complete acceptance scenario set");
  const scenarioIds = new Set();
  for (const [index, scenario] of spec.scenarios.entries()) {
    const label = `campaign.scenarios[${index}]`;
    exactKeys(
      scenario,
      [
        "id",
        "title",
        "scope",
        "plane",
        "execution",
        "leaderSensitive",
        "expectedPublicOriginsLost",
        "expectedFiduciaVotersLost",
        "expectedJetStreamMembersLost",
        "requiresTrafficDrain",
        "requiresBackupCheckpoint",
        "requiresProtectedMutationProbe",
      ],
      [],
      label,
    );
    assert(typeof scenario.id === "string" && /^[a-z0-9][a-z0-9-]{2,62}$/.test(scenario.id), `${label}.id is invalid`);
    assert(!scenarioIds.has(scenario.id), `${label}.id is duplicated`);
    scenarioIds.add(scenario.id);
    assert(typeof scenario.title === "string" && scenario.title.length >= 10, `${label}.title is too short`);
    assert(SCOPES.has(scenario.scope), `${label}.scope is invalid`);
    assert(typeof scenario.plane === "string" && /^[a-z][a-z0-9-]+$/.test(scenario.plane), `${label}.plane is invalid`);
    assert(EXECUTIONS.has(scenario.execution), `${label}.execution is invalid`);
    for (const key of ["leaderSensitive", "requiresTrafficDrain", "requiresBackupCheckpoint", "requiresProtectedMutationProbe"]) {
      assert(typeof scenario[key] === "boolean", `${label}.${key} must be boolean`);
    }
    for (const key of ["expectedPublicOriginsLost", "expectedFiduciaVotersLost", "expectedJetStreamMembersLost"]) {
      assert(Number.isInteger(scenario[key]) && scenario[key] >= 0 && scenario[key] <= 1, `${label}.${key} must be 0 or 1`);
    }
    assert(3 - scenario.expectedPublicOriginsLost >= spec.minimumHealthyPublicOrigins, `${label} would violate public-origin safety`);
    assert(3 - scenario.expectedFiduciaVotersLost >= spec.minimumHealthyFiduciaVoters, `${label} would violate Fiducia quorum safety`);
    assert(3 - scenario.expectedJetStreamMembersLost >= spec.minimumHealthyJetStreamMembers, `${label} would violate JetStream quorum safety`);
  }
  assert(scenarioIds.has("seven-day-soak"), "campaign must contain seven-day-soak");
  assert(spec.scenarios.at(-1).id === "seven-day-soak", "seven-day-soak must be the final declared scenario");
  return spec;
}

export function validatePreflight(preflight, spec, { allowExample = false, now = new Date() } = {}) {
  scanCredentials(preflight, "preflight");
  exactKeys(
    preflight,
    [
      "schemaVersion",
      "evidenceMode",
      "observedAt",
      "pinnedRevision",
      "rollbackRevision",
      "fiduciaLeader",
      "jetstreamMetaLeader",
      "jetstreamStreamLeader",
      "healthyPublicOrigins",
      "healthyFiduciaVoters",
      "healthyJetStreamMembers",
      "externalProbeRegions",
      "fingerprints",
      "backups",
      "gates",
      "clusterReadiness",
    ],
    [],
    "preflight",
  );
  assert(preflight.schemaVersion === 1, "preflight.schemaVersion must equal 1");
  assert(["example", "live"].includes(preflight.evidenceMode), "preflight.evidenceMode must be example or live");
  if (preflight.evidenceMode === "example" && !allowExample) fail("example preflight evidence requires --allow-example");
  const observedAt = timestamp(preflight.observedAt, "preflight.observedAt");
  assert(observedAt <= now, "preflight.observedAt cannot be in the future");
  if (preflight.evidenceMode === "live") {
    assert(now - observedAt <= MAX_LIVE_PREFLIGHT_AGE_MS, "live preflight evidence is older than ten minutes");
  }
  assert(typeof preflight.pinnedRevision === "string" && SHA_RE.test(preflight.pinnedRevision), "pinnedRevision must be an exact lowercase 40-character SHA");
  assert(typeof preflight.rollbackRevision === "string" && SHA_RE.test(preflight.rollbackRevision), "rollbackRevision must be an exact lowercase 40-character SHA");
  assert(preflight.pinnedRevision !== preflight.rollbackRevision, "pinnedRevision and rollbackRevision must differ");

  const clusters = clustersFromTopology();
  exactSet(preflight.healthyPublicOrigins, clusters, "healthyPublicOrigins");
  exactSet(preflight.healthyFiduciaVoters, clusters, "healthyFiduciaVoters");
  exactSet(preflight.healthyJetStreamMembers, clusters, "healthyJetStreamMembers");
  for (const key of ["fiduciaLeader", "jetstreamMetaLeader", "jetstreamStreamLeader"]) {
    assert(clusters.includes(preflight[key]), `${key} must name a current laptop cluster`);
  }
  assert(Array.isArray(preflight.externalProbeRegions), "externalProbeRegions must be an array");
  assert(new Set(preflight.externalProbeRegions).size >= spec.requiredExternalProbeRegions, `at least ${spec.requiredExternalProbeRegions} independent probe regions are required`);

  exactKeys(preflight.fingerprints, ["hostInventory", "tailnetPolicy", "gitopsRoots", "jetstreamEvidence"], [], "preflight.fingerprints");
  for (const [key, value] of Object.entries(preflight.fingerprints)) {
    assert(typeof value === "string" && SHA256_RE.test(value), `preflight.fingerprints.${key} must be lowercase SHA-256`);
  }
  assert(new Set(Object.values(preflight.fingerprints)).size === 4, "preflight fingerprints must be distinct");

  exactKeys(preflight.backups, ["k3sSnapshot", "fiduciaSnapshot", "databaseBackup", "jetstreamSnapshot", "offlineRecoveryKeys"], [], "preflight.backups");
  const backupProofs = [];
  for (const [key, value] of Object.entries(preflight.backups)) {
    assert(typeof value === "string" && PROOF_RE.test(value), `preflight.backups.${key} is invalid`);
    if (preflight.evidenceMode === "live") assert(!value.startsWith("example:"), `preflight.backups.${key} cannot use example evidence in live mode`);
    backupProofs.push(value);
  }
  assert(new Set(backupProofs).size === backupProofs.length, "preflight backup proofs must be distinct");

  exactKeys(preflight.gates, spec.requiredGlobalGates, [], "preflight.gates");
  for (const gate of spec.requiredGlobalGates) assert(preflight.gates[gate] === true, `preflight.gates.${gate} must be true`);

  exactKeys(preflight.clusterReadiness, clusters, [], "preflight.clusterReadiness");
  for (const cluster of clusters) {
    exactKeys(preflight.clusterReadiness[cluster], REQUIRED_CLUSTER_GATES, [], `preflight.clusterReadiness.${cluster}`);
    for (const gate of REQUIRED_CLUSTER_GATES) {
      assert(preflight.clusterReadiness[cluster][gate] === true, `preflight.clusterReadiness.${cluster}.${gate} must be true`);
    }
  }
  return preflight;
}

function leaderScore(cluster, scenario, preflight) {
  if (!scenario.leaderSensitive) return 0;
  let score = 0;
  if (["fiducia", "mesh", "kubernetes", "wan", "power", "storage", "time", "upgrade"].includes(scenario.plane) && cluster === preflight.fiduciaLeader) score += 100;
  if (["jetstream", "mesh", "kubernetes", "wan", "power", "storage", "time", "upgrade"].includes(scenario.plane) && cluster === preflight.jetstreamMetaLeader) score += 30;
  if (["jetstream", "mesh", "kubernetes", "wan", "power", "storage", "time", "upgrade"].includes(scenario.plane) && cluster === preflight.jetstreamStreamLeader) score += 20;
  return score;
}

function recoveryCluster(clusters, preflight) {
  return [...clusters].sort((left, right) => {
    const leftScore = leaderScore(left, { leaderSensitive: true, plane: "power" }, preflight);
    const rightScore = leaderScore(right, { leaderSensitive: true, plane: "power" }, preflight);
    return leftScore - rightScore || left.localeCompare(right);
  })[0];
}

function action(kind, details = {}) {
  return { kind, ...details };
}

function actionsForStep(step, spec, preflight) {
  const scenario = step.scenario;
  const target = step.target;
  const actions = [
    action("acquire_exclusive_fault_lease", {
      campaignId: spec.campaignId,
      maxConcurrentFaults: 1,
    }),
    action("reobserve_roles_health_and_backups", {
      observedAt: preflight.observedAt,
      requiredGlobalGates: spec.requiredGlobalGates,
    }),
    action("capture_redacted_before_snapshot", { target }),
  ];
  if (scenario.requiresBackupCheckpoint) {
    actions.push(action("verify_backup_checkpoint", {
      target,
      requiredBackups: Object.keys(preflight.backups),
      criticalRpoSeconds: spec.engineeringTargets.criticalRpoSeconds,
    }));
  }
  if (scenario.requiresTrafficDrain) {
    actions.push(action("remove_target_from_public_and_background_work", { target }));
  }
  actions.push(
    action("inject_fault", {
      scenarioId: scenario.id,
      execution: scenario.execution,
      target,
      requiresHumanStopAuthority: scenario.execution !== "automated-kubernetes",
    }),
    action("verify_fault_alert_delivery", {
      scenarioId: scenario.id,
      target,
      required: true,
    }),
    action("verify_degraded_safety", {
      minimumHealthyPublicOrigins: spec.minimumHealthyPublicOrigins,
      minimumHealthyFiduciaVoters: spec.minimumHealthyFiduciaVoters,
      minimumHealthyJetStreamMembers: spec.minimumHealthyJetStreamMembers,
      expectedHealthyPublicOrigins: 3 - scenario.expectedPublicOriginsLost,
      expectedHealthyFiduciaVoters: 3 - scenario.expectedFiduciaVotersLost,
      expectedHealthyJetStreamMembers: 3 - scenario.expectedJetStreamMembersLost,
    }),
  );
  if (scenario.requiresProtectedMutationProbe) {
    actions.push(action("verify_fencing_outbox_and_idempotency", {
      target,
      requireZeroDuplicateProtectedEffects: true,
      requireDatabaseOutboxReplay: true,
    }));
  }
  actions.push(
    action("recover_fault", { scenarioId: scenario.id, target }),
    action("wait_full_readiness_and_catchup", {
      target,
      memberRecoverySeconds: scenario.id === "replacement-host-restore"
        ? spec.engineeringTargets.replacementHostRecoverySeconds
        : spec.engineeringTargets.memberRecoverySeconds,
      requireFiduciaLagZero: true,
      requireJetStreamLagZero: true,
      requireAllPublicOriginsHealthy: true,
    }),
    action("capture_redacted_after_snapshot", { target }),
    action("verify_external_probes_and_data_safety", {
      requiredProbeRegions: spec.requiredExternalProbeRegions,
      maximumPublicFailoverSeconds: spec.engineeringTargets.publicFailoverSeconds,
      requireZeroLostCommittedFiduciaEntries: true,
      requireZeroLostJetStreamMessages: true,
      requireZeroDuplicateProtectedEffects: true,
    }),
  );
  if (scenario.requiresTrafficDrain) actions.push(action("restore_target_traffic_and_background_work", { target }));
  actions.push(action("record_reviewed_result_and_release_fault_lease", { scenarioId: scenario.id, target }));
  return actions;
}

export function buildAcceptancePlan({ spec, preflight, allowExample = false, now = new Date() }) {
  const validatedSpec = validateCampaignSpec(spec);
  const validatedPreflight = validatePreflight(preflight, validatedSpec, { allowExample, now });
  const clusters = clustersFromTopology();
  const designatedRecoveryCluster = recoveryCluster(clusters, validatedPreflight);
  const steps = [];
  let sequence = 1;
  for (const scenario of validatedSpec.scenarios) {
    if (scenario.scope === "per-cluster") {
      const ordered = [...clusters].sort((left, right) => {
        const score = leaderScore(left, scenario, validatedPreflight) - leaderScore(right, scenario, validatedPreflight);
        return score || left.localeCompare(right);
      });
      for (const cluster of ordered) {
        const step = {
          sequence: sequence++,
          stepId: `${scenario.id}@${cluster}`,
          target: cluster,
          observedRoleScore: leaderScore(cluster, scenario, validatedPreflight),
          scenario,
        };
        step.actions = actionsForStep(step, validatedSpec, validatedPreflight);
        steps.push(step);
      }
    } else {
      const target = scenario.id === "seven-day-soak" || scenario.id === "database-clean-room-restore"
        ? "fleet"
        : designatedRecoveryCluster;
      const step = {
        sequence: sequence++,
        stepId: `${scenario.id}@${target}`,
        target,
        observedRoleScore: 0,
        scenario,
      };
      step.actions = actionsForStep(step, validatedSpec, validatedPreflight);
      steps.push(step);
    }
  }

  const planCore = {
    schemaVersion: 1,
    campaignId: validatedSpec.campaignId,
    evidenceMode: validatedPreflight.evidenceMode,
    observedAt: validatedPreflight.observedAt,
    pinnedRevision: validatedPreflight.pinnedRevision,
    rollbackRevision: validatedPreflight.rollbackRevision,
    designatedRecoveryCluster,
    invariants: {
      maxConcurrentFaults: 1,
      stableFiduciaVoters: 3,
      stableJetStreamMembers: 3,
      stablePublicOrigins: 3,
      minimumHealthyFiduciaVoters: 2,
      minimumHealthyJetStreamMembers: 2,
      minimumHealthyPublicOrigins: 2,
      fullRecoveryBeforeNextFault: true,
      statefulLeadersLastWithinEachScenario: true,
      physicalAndDestructiveStepsRequireHumanStopAuthority: true,
      exampleEvidenceNeverQualifiesForProduction: true,
    },
    engineeringTargets: validatedSpec.engineeringTargets,
    globalPreconditions: {
      externalProbeRegions: validatedPreflight.externalProbeRegions,
      fingerprints: validatedPreflight.fingerprints,
      backups: validatedPreflight.backups,
      requiredGlobalGates: validatedSpec.requiredGlobalGates,
      clusterReadinessGates: REQUIRED_CLUSTER_GATES,
    },
    steps,
    finalAcceptance: [
      action("verify_all_scenario_results_reviewed", { expectedStepCount: steps.length }),
      action("verify_seven_day_soak", { minimumHours: validatedSpec.soakHours }),
      action("verify_no_unresolved_critical_findings"),
      action("record_measured_rto_rpo_and_operator_interventions"),
      action("approve_beta_or_limited_production_classification"),
    ],
    stopConditions: [
      "another fault or membership change is already active",
      "fresh leader, health, backup, or external-probe evidence is unavailable",
      "a first fault has not fully recovered and caught up",
      "fewer than two Fiducia voters or two JetStream members would remain healthy",
      "fewer than two public origins would remain healthy",
      "any critical stream follower is not current or has nonzero lag",
      "committed Fiducia state or acknowledged JetStream messages are lost",
      "fencing, outbox replay, inbox deduplication, or protected idempotency fails",
      "required alert delivery, backup, recovery-key, or rollback evidence is unavailable",
      "disk, temperature, power, WAN, or clock behavior exceeds the bounded fault procedure",
      "the human stop authority orders immediate recovery or campaign termination",
    ],
    nonClaims: [
      "The plan and CI rehearsal do not inject a physical or production fault.",
      "Example preflight evidence is never production acceptance evidence.",
      "A passing software simulation does not replace live alerts, failover, restore, revocation, and soak evidence.",
    ],
  };
  return { ...planCore, planFingerprint: digest(planCore) };
}

export function simulateAcceptancePlan(plan) {
  let healthyPublicOrigins = 3;
  let healthyFiduciaVoters = 3;
  let healthyJetStreamMembers = 3;
  const checkpoints = [];
  const scenarioTargets = new Map();
  let activeFaults = 0;

  for (const step of plan.steps) {
    assert(activeFaults === 0, `fault overlap before ${step.stepId}`);
    activeFaults += 1;
    assert(activeFaults <= plan.invariants.maxConcurrentFaults, `max concurrent faults exceeded at ${step.stepId}`);

    const { scenario } = step;
    healthyPublicOrigins -= scenario.expectedPublicOriginsLost;
    healthyFiduciaVoters -= scenario.expectedFiduciaVotersLost;
    healthyJetStreamMembers -= scenario.expectedJetStreamMembersLost;
    assert(healthyPublicOrigins >= plan.invariants.minimumHealthyPublicOrigins, `${step.stepId} violates public-origin safety`);
    assert(healthyFiduciaVoters >= plan.invariants.minimumHealthyFiduciaVoters, `${step.stepId} violates Fiducia quorum safety`);
    assert(healthyJetStreamMembers >= plan.invariants.minimumHealthyJetStreamMembers, `${step.stepId} violates JetStream quorum safety`);

    const kinds = step.actions.map((entry) => entry.kind);
    const injectIndex = kinds.indexOf("inject_fault");
    const safetyIndex = kinds.indexOf("verify_degraded_safety");
    const recoverIndex = kinds.indexOf("recover_fault");
    const catchupIndex = kinds.indexOf("wait_full_readiness_and_catchup");
    const releaseIndex = kinds.indexOf("record_reviewed_result_and_release_fault_lease");
    assert(injectIndex >= 0 && injectIndex < safetyIndex && safetyIndex < recoverIndex && recoverIndex < catchupIndex && catchupIndex < releaseIndex, `${step.stepId} action order is unsafe`);

    healthyPublicOrigins += scenario.expectedPublicOriginsLost;
    healthyFiduciaVoters += scenario.expectedFiduciaVotersLost;
    healthyJetStreamMembers += scenario.expectedJetStreamMembersLost;
    activeFaults -= 1;
    assert(healthyPublicOrigins === 3 && healthyFiduciaVoters === 3 && healthyJetStreamMembers === 3, `${step.stepId} did not fully recover before the next fault`);

    const targets = scenarioTargets.get(scenario.id) ?? [];
    targets.push({ target: step.target, score: step.observedRoleScore });
    scenarioTargets.set(scenario.id, targets);
    checkpoints.push({
      stepId: step.stepId,
      degraded: {
        healthyPublicOrigins: 3 - scenario.expectedPublicOriginsLost,
        healthyFiduciaVoters: 3 - scenario.expectedFiduciaVotersLost,
        healthyJetStreamMembers: 3 - scenario.expectedJetStreamMembersLost,
      },
      recovered: {
        healthyPublicOrigins,
        healthyFiduciaVoters,
        healthyJetStreamMembers,
      },
    });
  }

  for (const [scenarioId, targets] of scenarioTargets.entries()) {
    if (targets.length === 3 && targets.some((entry) => entry.score > 0)) {
      const scores = targets.map((entry) => entry.score);
      for (let index = 1; index < scores.length; index += 1) {
        assert(scores[index] >= scores[index - 1], `${scenarioId} does not order leaders last`);
      }
    }
  }
  assert(plan.steps.at(-1)?.scenario.id === "seven-day-soak", "seven-day soak must remain the final campaign step");

  return {
    schemaVersion: 1,
    campaignId: plan.campaignId,
    planFingerprint: plan.planFingerprint,
    status: "passed",
    softwareOnly: true,
    stepCount: plan.steps.length,
    maxConcurrentFaultsObserved: 1,
    allStepsRecoveredBeforeNextFault: true,
    everyDegradedCheckpointPreservesTwoOfThree: checkpoints.every((checkpoint) =>
      checkpoint.degraded.healthyPublicOrigins >= 2
      && checkpoint.degraded.healthyFiduciaVoters >= 2
      && checkpoint.degraded.healthyJetStreamMembers >= 2),
    statefulLeadersOrderedLast: true,
    finalStep: plan.steps.at(-1).stepId,
    checkpoints,
    nonClaim: "This is a deterministic state-machine rehearsal, not live acceptance evidence.",
  };
}

function usage() {
  return [
    "usage: node tools/plan-laptop-acceptance-campaign.mjs --preflight <file> [options]",
    "",
    "options:",
    "  --campaign <file>  campaign spec (default: laptop/acceptance/campaign.json)",
    "  --allow-example    permit evidenceMode=example for CI/rehearsal only",
    "  --now <timestamp>  deterministic validation time",
    "  --plan-only        print only the plan",
    "  --report-only      print only the abstract rehearsal report",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    campaign: defaultCampaignPath,
    preflight: null,
    allowExample: false,
    now: new Date(),
    output: "both",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--campaign") args.campaign = path.resolve(argv[++index] ?? "");
    else if (arg === "--preflight") args.preflight = path.resolve(argv[++index] ?? "");
    else if (arg === "--allow-example") args.allowExample = true;
    else if (arg === "--now") args.now = timestamp(argv[++index], "--now");
    else if (arg === "--plan-only") args.output = "plan";
    else if (arg === "--report-only") args.output = "report";
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
    if (!args.preflight) fail(`--preflight is required\n${usage()}`);
    const spec = loadJson(args.campaign, "campaign");
    const preflight = loadJson(args.preflight, "preflight");
    const plan = buildAcceptancePlan({ spec, preflight, allowExample: args.allowExample, now: args.now });
    const report = simulateAcceptancePlan(plan);
    const output = args.output === "plan" ? plan : args.output === "report" ? report : { plan, report };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
