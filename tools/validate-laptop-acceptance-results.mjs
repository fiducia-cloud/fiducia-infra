#!/usr/bin/env node
// Validate reviewed acceptance results against the exact immutable campaign plan.
// This validator does not execute faults or verify restricted proof references;
// it prevents incomplete, stale, duplicated, or example results from being
// presented as production acceptance.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PROOF_RE = /^[a-z0-9][a-z0-9._:/-]{7,255}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CREDENTIAL_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /tskey-(?:auth|client)-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const FORBIDDEN_KEY = /(?:password|passwd|secret|token|credential|privatekey|authkey|accesskey)/i;

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

function scanCredentials(value, location = "results") {
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

function proofList(values, label, evidenceMode, globalProofs) {
  assert(Array.isArray(values) && values.length >= 3, `${label} must contain at least three proof references`);
  assert(new Set(values).size === values.length, `${label} contains duplicates`);
  for (const value of values) {
    assert(typeof value === "string" && PROOF_RE.test(value), `${label} contains an invalid proof reference`);
    if (evidenceMode === "live") assert(!value.startsWith("example:"), `${label} cannot use example evidence in live mode`);
    assert(!globalProofs.has(value), `${label} reuses proof reference ${value}`);
    globalProofs.add(value);
  }
}

function recoveryLimit(step, targets) {
  if (step.scenario.id === "replacement-host-restore") return targets.replacementHostRecoverySeconds;
  if (["k3s-clean-room-restore", "fiducia-clean-room-restore", "database-clean-room-restore", "jetstream-clean-room-restore"].includes(step.scenario.id)) {
    return targets.fullFleetRecoverySeconds;
  }
  return targets.memberRecoverySeconds;
}

export function buildExampleAcceptanceResults(plan) {
  const base = new Date("2026-08-03T18:15:00Z").getTime();
  const steps = plan.steps.map((step, index) => {
    const startedAt = new Date(base + index * 20 * 60 * 1000);
    const endedAt = new Date(startedAt.getTime() + 5 * 60 * 1000);
    return {
      stepId: step.stepId,
      scenarioId: step.scenario.id,
      target: step.target,
      execution: step.scenario.execution,
      status: "passed",
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      faultInjected: step.scenario.id !== "seven-day-soak",
      alertDelivered: true,
      recoveryVerified: true,
      fullCatchupVerified: true,
      externalProbeRegions: ["us-east", "eu-west"],
      publicFailoverSeconds: step.scenario.expectedPublicOriginsLost ? 60 : 0,
      memberRecoverySeconds: step.scenario.id === "replacement-host-restore" ? 1800 : 180,
      measuredRpoSeconds: 0,
      lostCommittedFiduciaEntries: 0,
      lostJetStreamMessages: 0,
      duplicateProtectedEffects: 0,
      unresolvedCriticalFindings: 0,
      humanObserver: step.scenario.execution === "automated-kubernetes" ? null : "example-human-observer",
      stopAuthorityConfirmed: true,
      proofRefs: [
        `example:result:${String(index + 1).padStart(2, "0")}:before`,
        `example:result:${String(index + 1).padStart(2, "0")}:alert`,
        `example:result:${String(index + 1).padStart(2, "0")}:after`,
      ],
    };
  });
  const startedAt = new Date(base);
  const endedAt = new Date(base + plan.engineeringTargets.fullFleetRecoverySeconds * 1000 + 168 * 60 * 60 * 1000);
  return {
    schemaVersion: 1,
    evidenceMode: "example",
    campaignId: plan.campaignId,
    planFingerprint: plan.planFingerprint,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    reviewedAt: new Date(endedAt.getTime() + 60 * 60 * 1000).toISOString(),
    reviewer: "example-reviewer",
    finalDecision: "approved",
    launchClassification: "limited-production",
    physicalFailureDomainsIndependent: true,
    steps,
    soak: {
      actualHours: 168,
      representativeTraffic: true,
      boundedFaultsDuringSoak: 6,
      backupsCompleted: true,
      restoreChecksCompleted: true,
      alertDeliveryVerified: true,
      operatorInterventions: 2,
      availabilityPercent: 99.95,
      unresolvedCriticalFindings: 0,
      proofRefs: [
        "example:soak:traffic",
        "example:soak:alerts",
        "example:soak:backups",
        "example:soak:review"
      ]
    },
    measuredFleetRecoverySeconds: 7200,
    measuredCriticalRpoSeconds: 0,
    unresolvedCriticalFindings: 0,
    finalProofRefs: [
      "example:final:approval",
      "example:final:rto-rpo",
      "example:final:risk-classification"
    ]
  };
}

export function validateAcceptanceResults(plan, results, { allowExample = false } = {}) {
  scanCredentials(results);
  exactKeys(
    results,
    [
      "schemaVersion",
      "evidenceMode",
      "campaignId",
      "planFingerprint",
      "startedAt",
      "endedAt",
      "reviewedAt",
      "reviewer",
      "finalDecision",
      "launchClassification",
      "physicalFailureDomainsIndependent",
      "steps",
      "soak",
      "measuredFleetRecoverySeconds",
      "measuredCriticalRpoSeconds",
      "unresolvedCriticalFindings",
      "finalProofRefs"
    ],
    [],
    "results",
  );
  assert(results.schemaVersion === 1, "results.schemaVersion must equal 1");
  assert(["example", "live"].includes(results.evidenceMode), "results.evidenceMode must be example or live");
  if (results.evidenceMode === "example" && !allowExample) fail("example acceptance results require --allow-example");
  assert(results.campaignId === plan.campaignId, "results.campaignId does not match the plan");
  assert(results.planFingerprint === plan.planFingerprint, "results.planFingerprint does not match the immutable plan");
  assert(typeof results.planFingerprint === "string" && SHA256_RE.test(results.planFingerprint), "results.planFingerprint must be lowercase SHA-256");

  const startedAt = timestamp(results.startedAt, "results.startedAt");
  const endedAt = timestamp(results.endedAt, "results.endedAt");
  const reviewedAt = timestamp(results.reviewedAt, "results.reviewedAt");
  assert(startedAt < endedAt, "results.startedAt must precede endedAt");
  assert(endedAt <= reviewedAt, "results.reviewedAt must not precede endedAt");
  assert(typeof results.reviewer === "string" && results.reviewer.length >= 3, "results.reviewer is required");
  assert(["approved", "rejected"].includes(results.finalDecision), "results.finalDecision must be approved or rejected");
  assert(["beta-only", "limited-production"].includes(results.launchClassification), "results.launchClassification is invalid");
  assert(typeof results.physicalFailureDomainsIndependent === "boolean", "physicalFailureDomainsIndependent must be boolean");
  if (results.launchClassification === "limited-production") {
    assert(results.physicalFailureDomainsIndependent === true, "limited-production requires independent physical failure domains");
  }

  assert(Array.isArray(results.steps), "results.steps must be an array");
  const expectedSteps = new Map(plan.steps.map((step) => [step.stepId, step]));
  assert(results.steps.length === expectedSteps.size, `results.steps must contain exactly ${expectedSteps.size} entries`);
  assert(new Set(results.steps.map((step) => step.stepId)).size === results.steps.length, "results.steps contains duplicate step IDs");
  const globalProofs = new Set();

  for (const [index, result] of results.steps.entries()) {
    const label = `results.steps[${index}]`;
    exactKeys(
      result,
      [
        "stepId",
        "scenarioId",
        "target",
        "execution",
        "status",
        "startedAt",
        "endedAt",
        "faultInjected",
        "alertDelivered",
        "recoveryVerified",
        "fullCatchupVerified",
        "externalProbeRegions",
        "publicFailoverSeconds",
        "memberRecoverySeconds",
        "measuredRpoSeconds",
        "lostCommittedFiduciaEntries",
        "lostJetStreamMessages",
        "duplicateProtectedEffects",
        "unresolvedCriticalFindings",
        "humanObserver",
        "stopAuthorityConfirmed",
        "proofRefs"
      ],
      [],
      label,
    );
    const planned = expectedSteps.get(result.stepId);
    assert(planned, `${label}.stepId is not in the immutable plan`);
    assert(result.scenarioId === planned.scenario.id, `${label}.scenarioId does not match the plan`);
    assert(result.target === planned.target, `${label}.target does not match the plan`);
    assert(result.execution === planned.scenario.execution, `${label}.execution does not match the plan`);
    assert(result.status === "passed", `${label}.status must be passed`);
    const stepStarted = timestamp(result.startedAt, `${label}.startedAt`);
    const stepEnded = timestamp(result.endedAt, `${label}.endedAt`);
    assert(stepStarted >= startedAt && stepEnded <= endedAt && stepStarted < stepEnded, `${label} timestamps fall outside the campaign or are reversed`);
    const shouldInject = planned.scenario.id !== "seven-day-soak";
    assert(result.faultInjected === shouldInject, `${label}.faultInjected does not match the scenario`);
    for (const key of ["alertDelivered", "recoveryVerified", "fullCatchupVerified", "stopAuthorityConfirmed"]) {
      assert(result[key] === true, `${label}.${key} must be true`);
    }
    assert(Array.isArray(result.externalProbeRegions) && new Set(result.externalProbeRegions).size >= plan.globalPreconditions.externalProbeRegions.length, `${label} lacks independent external probe regions`);
    assert(Number.isFinite(result.publicFailoverSeconds) && result.publicFailoverSeconds >= 0 && result.publicFailoverSeconds <= plan.engineeringTargets.publicFailoverSeconds, `${label}.publicFailoverSeconds exceeds the target`);
    assert(Number.isFinite(result.memberRecoverySeconds) && result.memberRecoverySeconds >= 0 && result.memberRecoverySeconds <= recoveryLimit(planned, plan.engineeringTargets), `${label}.memberRecoverySeconds exceeds the target`);
    assert(Number.isFinite(result.measuredRpoSeconds) && result.measuredRpoSeconds >= 0 && result.measuredRpoSeconds <= plan.engineeringTargets.criticalRpoSeconds, `${label}.measuredRpoSeconds exceeds the target`);
    for (const key of ["lostCommittedFiduciaEntries", "lostJetStreamMessages", "duplicateProtectedEffects", "unresolvedCriticalFindings"]) {
      assert(result[key] === 0, `${label}.${key} must equal 0`);
    }
    if (planned.scenario.execution === "automated-kubernetes") {
      assert(result.humanObserver === null || (typeof result.humanObserver === "string" && result.humanObserver.length >= 3), `${label}.humanObserver must be null or a reviewer`);
    } else {
      assert(typeof result.humanObserver === "string" && result.humanObserver.length >= 3, `${label}.humanObserver is required for manual/physical/destructive work`);
    }
    proofList(result.proofRefs, `${label}.proofRefs`, results.evidenceMode, globalProofs);
    expectedSteps.delete(result.stepId);
  }
  assert(expectedSteps.size === 0, `results are missing planned steps: ${[...expectedSteps.keys()].join(", ")}`);

  exactKeys(results.soak, ["actualHours", "representativeTraffic", "boundedFaultsDuringSoak", "backupsCompleted", "restoreChecksCompleted", "alertDeliveryVerified", "operatorInterventions", "availabilityPercent", "unresolvedCriticalFindings", "proofRefs"], [], "results.soak");
  assert(Number.isFinite(results.soak.actualHours) && results.soak.actualHours >= 168, "results.soak.actualHours must be at least 168");
  for (const key of ["representativeTraffic", "backupsCompleted", "restoreChecksCompleted", "alertDeliveryVerified"]) {
    assert(results.soak[key] === true, `results.soak.${key} must be true`);
  }
  assert(Number.isInteger(results.soak.boundedFaultsDuringSoak) && results.soak.boundedFaultsDuringSoak >= 3, "results.soak.boundedFaultsDuringSoak must be at least 3");
  assert(Number.isInteger(results.soak.operatorInterventions) && results.soak.operatorInterventions >= 0, "results.soak.operatorInterventions must be non-negative");
  assert(Number.isFinite(results.soak.availabilityPercent) && results.soak.availabilityPercent >= 0 && results.soak.availabilityPercent <= 100, "results.soak.availabilityPercent is invalid");
  assert(results.soak.unresolvedCriticalFindings === 0, "results.soak.unresolvedCriticalFindings must equal 0");
  proofList(results.soak.proofRefs, "results.soak.proofRefs", results.evidenceMode, globalProofs);

  assert(Number.isFinite(results.measuredFleetRecoverySeconds) && results.measuredFleetRecoverySeconds >= 0 && results.measuredFleetRecoverySeconds <= plan.engineeringTargets.fullFleetRecoverySeconds, "measuredFleetRecoverySeconds exceeds the target");
  assert(Number.isFinite(results.measuredCriticalRpoSeconds) && results.measuredCriticalRpoSeconds >= 0 && results.measuredCriticalRpoSeconds <= plan.engineeringTargets.criticalRpoSeconds, "measuredCriticalRpoSeconds exceeds the target");
  assert(results.unresolvedCriticalFindings === 0, "results.unresolvedCriticalFindings must equal 0");
  proofList(results.finalProofRefs, "results.finalProofRefs", results.evidenceMode, globalProofs);
  if (results.finalDecision === "approved") assert(results.unresolvedCriticalFindings === 0, "approved results cannot contain critical findings");

  const reportCore = {
    schemaVersion: 1,
    status: results.finalDecision === "approved" ? "passed" : "rejected",
    evidenceMode: results.evidenceMode,
    campaignId: results.campaignId,
    planFingerprint: results.planFingerprint,
    launchClassification: results.launchClassification,
    stepCount: results.steps.length,
    soakHours: results.soak.actualHours,
    availabilityPercent: results.soak.availabilityPercent,
    measuredFleetRecoverySeconds: results.measuredFleetRecoverySeconds,
    measuredCriticalRpoSeconds: results.measuredCriticalRpoSeconds,
    zeroLostCommittedFiduciaEntries: true,
    zeroLostJetStreamMessages: true,
    zeroDuplicateProtectedEffects: true,
    zeroUnresolvedCriticalFindings: true,
    proofCount: globalProofs.size,
    reviewer: results.reviewer,
    reviewedAt: results.reviewedAt,
    nonClaims: [
      "The validator does not execute faults or independently inspect restricted proof references.",
      "Example results are never production acceptance evidence.",
      "Approval still requires accountable human review of the underlying evidence and risk classification."
    ]
  };
  return { ...reportCore, reportFingerprint: digest(reportCore) };
}

export function loadJson(file, label) {
  if (!file || !fs.existsSync(file)) fail(`${label} file does not exist: ${file || "(none)"}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usage() {
  return "usage: node tools/validate-laptop-acceptance-results.mjs --plan <file> --results <file> [--allow-example]";
}

function parseArgs(argv) {
  const args = { plan: null, results: null, allowExample: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") args.plan = path.resolve(argv[++index] ?? "");
    else if (arg === "--results") args.results = path.resolve(argv[++index] ?? "");
    else if (arg === "--allow-example") args.allowExample = true;
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
    if (!args.plan || !args.results) fail(usage());
    const report = validateAcceptanceResults(
      loadJson(args.plan, "plan"),
      loadJson(args.results, "results"),
      { allowExample: args.allowExample },
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
