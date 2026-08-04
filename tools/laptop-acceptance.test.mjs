import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  REQUIRED_CLUSTERS,
  REQUIRED_SCENARIO_IDS,
  assertScenarioId,
  buildAcceptancePlan,
  loadAcceptanceSpec,
  loadJson,
  validateAcceptanceEvidence,
  validateAcceptanceSpec,
} from "./laptop-acceptance.mjs";

const specPath = new URL("../acceptance/laptop-fleet/campaign.json", import.meta.url).pathname;
const evidencePath = new URL("../acceptance/laptop-fleet/evidence.example.json", import.meta.url).pathname;
const fixedNow = new Date("2026-08-03T19:00:00Z");
const spec = () => structuredClone(loadAcceptanceSpec(specPath));
const example = () => structuredClone(loadJson(evidencePath));

function makeLive() {
  const evidence = example();
  evidence.evidenceMode = "live";
  evidence.completedAt = "2026-08-03T18:00:00Z";
  for (const key of Object.keys(evidence.globalProof)) {
    evidence.globalProof[key] = evidence.globalProof[key].replace(/^example:/, "evidence:");
  }
  for (const scenario of evidence.scenarios) {
    for (const artifact of scenario.artifacts) {
      artifact.uriRef = artifact.uriRef.replace(/^example:/, "evidence:");
    }
    scenario.notes = scenario.notes.replace("Example-only", "Live reviewed");
  }
  evidence.soak.dailyCheckpointProofs = evidence.soak.dailyCheckpointProofs.map((value) => value.replace(/^example:/, "evidence:"));
  evidence.operatorDecision.riskAcceptance = "Reviewed live evidence supports this bounded pre-funding classification.";
  return evidence;
}

test("campaign declares the exact 28-scenario physical acceptance matrix in safe order", () => {
  const policy = validateAcceptanceSpec(spec());
  assert.equal(policy.scenarios.length, 28);
  assert.deepEqual(policy.requiredClusters, REQUIRED_CLUSTERS);
  assert.deepEqual(policy.scenarios.map((scenario) => scenario.id), REQUIRED_SCENARIO_IDS);
  assert.ok(policy.scenarios.every((scenario) => scenario.execution === "manual"));
  assert.ok(policy.scenarios.filter((scenario) => scenario.destructive).every((scenario) => scenario.execution === "manual"));
  assert.equal(policy.scenarios.at(-1).id, "seven-day-soak");
  assert.ok(
    policy.scenarioById.get("follower-laptop-power-loss").order <
      policy.scenarioById.get("fiducia-leader-power-loss").order,
  );
  assert.ok(
    policy.scenarioById.get("lost-device-revocation").order <
      policy.scenarioById.get("replacement-laptop-rejoin").order,
  );
});

test("plan is deterministic, capture-oriented, and never automates fault injection", () => {
  const first = buildAcceptancePlan(spec());
  const second = buildAcceptancePlan(spec());
  assert.deepEqual(first, second);
  assert.match(first.planFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.softwareOnly, true);
  assert.equal(first.scenarioCount, REQUIRED_SCENARIO_IDS.length);
  assert.equal(first.invariants.faultsAreManual, true);
  assert.ok(first.scenarios.every((scenario) => scenario.automatedFaultInjection === false));
  assert.ok(
    first.scenarios.every((scenario) =>
      scenario.actions.every((action) => action.automatedFaultInjection !== true && action.automatedRecovery !== true),
    ),
  );
  assert.equal(first.scenarios.at(-1).id, "seven-day-soak");
  assert.ok(first.nonClaims.some((claim) => claim.includes("does not inject faults")));
});

test("example evidence validates only under an explicit non-production allowance", () => {
  assert.throws(
    () => validateAcceptanceEvidence(example(), spec(), { now: fixedNow }),
    /requires --allow-example/,
  );
  const report = validateAcceptanceEvidence(example(), spec(), {
    allowExample: true,
    now: fixedNow,
  });
  assert.equal(report.status, "passed");
  assert.equal(report.softwareOnly, true);
  assert.equal(report.evidenceMode, "example");
  assert.equal(report.launchClassification, "limited-production");
  assert.equal(report.scenarioCount, 28);
  assert.equal(report.passedScenarios, 28);
  assert.equal(report.soakHours, 168);
  assert.deepEqual(report.safety, {
    acknowledgedMessageLoss: 0,
    duplicateProtectedMutations: 0,
    maximumFinalReplicationLag: 0,
    criticalFindings: 0,
    unresolvedHighFindings: 0,
  });
  assert.deepEqual(report.failureDomains, {
    distinctSites: true,
    distinctIsps: true,
    distinctPowerDomains: true,
    externalProbeRegions: 2,
  });
  assert.match(report.evidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(report.nonClaims.some((claim) => claim.includes("never production proof")));
});

test("fresh live evidence rejects example proof references and stale completion", () => {
  const live = makeLive();
  assert.doesNotThrow(() => validateAcceptanceEvidence(live, spec(), { now: fixedNow }));

  const stale = structuredClone(live);
  stale.completedAt = "2026-08-01T18:00:00Z";
  assert.throws(
    () => validateAcceptanceEvidence(stale, spec(), { now: fixedNow }),
    /older than 24 hours/,
  );

  const exampleArtifact = structuredClone(live);
  exampleArtifact.scenarios[0].artifacts[0].uriRef = "example:artifact:not-live";
  assert.throws(
    () => validateAcceptanceEvidence(exampleArtifact, spec(), { now: fixedNow }),
    /cannot use example evidence in live mode/,
  );

  const exampleGlobalProof = structuredClone(live);
  exampleGlobalProof.globalProof.backupCatalog = "example:proof:backup";
  assert.throws(
    () => validateAcceptanceEvidence(exampleGlobalProof, spec(), { now: fixedNow }),
    /cannot use example evidence in live mode/,
  );
});

test("limited production requires distinct site, ISP, and power domains", () => {
  for (const field of ["siteFingerprint", "ispFingerprint", "powerDomainFingerprint"]) {
    const correlated = example();
    correlated.failureDomains.clusters[1][field] = correlated.failureDomains.clusters[0][field];
    assert.throws(
      () => validateAcceptanceEvidence(correlated, spec(), { allowExample: true, now: fixedNow }),
      new RegExp(`${field} values must be distinct`),
    );
  }

  const beta = example();
  beta.operatorDecision.classification = "beta-only";
  beta.operatorDecision.riskAcceptance = "Correlated power remains accepted only for a bounded low-SLA beta.";
  beta.failureDomains.clusters[1].powerDomainFingerprint = beta.failureDomains.clusters[0].powerDomainFingerprint;
  const report = validateAcceptanceEvidence(beta, spec(), { allowExample: true, now: fixedNow });
  assert.equal(report.launchClassification, "beta-only");
  assert.equal(report.failureDomains.distinctPowerDomains, false);
});

test("short soak, weak availability, missed backups, findings, and unsafe outcomes fail closed", () => {
  const cases = [
    ["short soak", (value) => {
      value.soak.startedAt = "2026-07-28T18:00:00Z";
      value.soak.durationHours = 144;
    }, /at least 168/],
    ["availability", (value) => { value.soak.externalAvailabilityPercent = 98.9; }, /must be in 99\.\.100/],
    ["backup success", (value) => { value.soak.backupSuccessRatePercent = 99.9; }, /must equal 100/],
    ["message loss", (value) => { value.scenarios[0].acknowledgedMessageLoss = 1; }, /acknowledgedMessageLoss must equal 0/],
    ["duplicate protected mutation", (value) => { value.scenarios[0].duplicateProtectedMutations = 1; }, /duplicateProtectedMutations must equal 0/],
    ["replication lag", (value) => { value.scenarios[0].finalReplicationLag = 1; }, /finalReplicationLag must equal 0/],
    ["critical finding", (value) => { value.soak.criticalFindings = 1; }, /criticalFindings must equal 0/],
    ["high finding", (value) => { value.soak.unresolvedHighFindings = 1; }, /unresolvedHighFindings must equal 0/],
    ["disk floor", (value) => { value.scenarios[0].minimumDiskFreePercent = 19; }, /must be in 20\.\.100/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const value = example();
    mutate(value);
    assert.throws(
      () => validateAcceptanceEvidence(value, spec(), { allowExample: true, now: fixedNow }),
      pattern,
      name,
    );
  }
});

test("required alert, restore, quorum, RTO, and RPO gates are scenario-specific", () => {
  const alert = example();
  const alertScenario = alert.scenarios.find((scenario) => scenario.id === "alert-routing-matrix");
  alertScenario.alertDelivered = false;
  assert.throws(
    () => validateAcceptanceEvidence(alert, spec(), { allowExample: true, now: fixedNow }),
    /alertDelivered must be true/,
  );

  const restore = example();
  const restoreScenario = restore.scenarios.find((scenario) => scenario.id === "k3s-clean-restore");
  restoreScenario.restoreVerified = false;
  assert.throws(
    () => validateAcceptanceEvidence(restore, spec(), { allowExample: true, now: fixedNow }),
    /restoreVerified must be true/,
  );

  const quorum = example();
  const quorumScenario = quorum.scenarios.find((scenario) => scenario.id === "fiducia-leader-power-loss");
  quorumScenario.quorumPreserved = false;
  assert.throws(
    () => validateAcceptanceEvidence(quorum, spec(), { allowExample: true, now: fixedNow }),
    /quorumPreserved must be true/,
  );

  const rto = example();
  const rtoScenario = rto.scenarios.find((scenario) => scenario.id === "follower-laptop-power-loss");
  rtoScenario.rtoSeconds = 301;
  assert.throws(
    () => validateAcceptanceEvidence(rto, spec(), { allowExample: true, now: fixedNow }),
    /rtoSeconds exceeds 300/,
  );

  const rpo = example();
  const rpoScenario = rpo.scenarios.find((scenario) => scenario.id === "fiducia-raft-clean-restore");
  rpoScenario.rpoSeconds = 1;
  assert.throws(
    () => validateAcceptanceEvidence(rpo, spec(), { allowExample: true, now: fixedNow }),
    /rpoSeconds exceeds 0/,
  );
});

test("scenario, artifact, revision, and checkpoint identities are exact and unique", () => {
  const missing = example();
  missing.scenarios.pop();
  assert.throws(
    () => validateAcceptanceEvidence(missing, spec(), { allowExample: true, now: fixedNow }),
    /must exactly equal/,
  );

  const duplicate = example();
  duplicate.scenarios[1].id = duplicate.scenarios[0].id;
  assert.throws(
    () => validateAcceptanceEvidence(duplicate, spec(), { allowExample: true, now: fixedNow }),
    /contains duplicates/,
  );

  const artifact = example();
  artifact.scenarios[0].artifacts[1].sha256 = artifact.scenarios[0].artifacts[0].sha256;
  assert.throws(
    () => validateAcceptanceEvidence(artifact, spec(), { allowExample: true, now: fixedNow }),
    /duplicate hashes/,
  );

  const revision = example();
  revision.pinnedRevision = "main";
  assert.throws(
    () => validateAcceptanceEvidence(revision, spec(), { allowExample: true, now: fixedNow }),
    /exact 40-character Git SHA/,
  );

  const checkpoints = example();
  checkpoints.soak.dailyCheckpointProofs[1] = checkpoints.soak.dailyCheckpointProofs[0];
  assert.throws(
    () => validateAcceptanceEvidence(checkpoints, spec(), { allowExample: true, now: fixedNow }),
    /contains duplicates/,
  );
});

test("credential-like values and credential-bearing keys are rejected", () => {
  const tokenValue = example();
  tokenValue.scenarios[0].notes = `ghp_${"1".repeat(40)}`;
  assert.throws(
    () => validateAcceptanceEvidence(tokenValue, spec(), { allowExample: true, now: fixedNow }),
    /credential-like value/,
  );

  const tokenKey = example();
  tokenKey.operatorDecision.apiToken = "redacted";
  assert.throws(
    () => validateAcceptanceEvidence(tokenKey, spec(), { allowExample: true, now: fixedNow }),
    /credential-bearing key/,
  );
});

test("spec changes cannot automate destructive faults or reorder safety gates", () => {
  const automated = spec();
  automated.scenarios.find((scenario) => scenario.id === "follower-laptop-power-loss").execution = "automated";
  assert.throws(() => validateAcceptanceSpec(automated), /execution must remain manual/);

  const leaderFirst = spec();
  const follower = leaderFirst.scenarios.find((scenario) => scenario.id === "follower-laptop-power-loss");
  const leader = leaderFirst.scenarios.find((scenario) => scenario.id === "fiducia-leader-power-loss");
  [follower.order, leader.order] = [leader.order, follower.order];
  assert.throws(() => validateAcceptanceSpec(leaderFirst), /follower power loss must precede leader power loss/);

  const replacementFirst = spec();
  const revoke = replacementFirst.scenarios.find((scenario) => scenario.id === "lost-device-revocation");
  const replace = replacementFirst.scenarios.find((scenario) => scenario.id === "replacement-laptop-rejoin");
  [revoke.order, replace.order] = [replace.order, revoke.order];
  assert.throws(() => validateAcceptanceSpec(replacementFirst), /revocation must precede replacement/);

  const soakNotLast = spec();
  soakNotLast.scenarios.find((scenario) => scenario.id === "seven-day-soak").order = 1;
  soakNotLast.scenarios.find((scenario) => scenario.id === "k3s-clean-restore").order = 28;
  assert.throws(() => validateAcceptanceSpec(soakNotLast), /seven-day-soak must be the final scenario/);
});

test("capture script is context-bound, redacted, immutable, and capture-only", () => {
  const script = fs.readFileSync(
    new URL("../scripts/capture-laptop-acceptance-checkpoint.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /umask 077/);
  assert.match(script, /--assert-scenario/);
  assert.match(script, /fiducia\.cloud\/cluster=\$cluster,fiducia\.cloud\/substrate=laptop-k3s/);
  assert.match(script, /install -d -m 700/);
  assert.match(script, /install -m 600/);
  assert.match(script, /sha256sum/);
  assert.match(script, /captureOnly: true/);
  assert.match(script, /automatedFaultInjection: false/);
  assert.match(script, /get --raw='\/readyz\?verbose'/);
  assert.match(script, /get etcdsnapshotfiles\.k3s\.cattle\.io/);
  assert.match(script, /get deployments,statefulsets,daemonsets/);
  assert.doesNotMatch(script, /get secrets?\b|get configmaps?\b/i);
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b|set -x|set -o xtrace/);
  assert.doesNotMatch(script, /\bkubectl\b[^\n]*(?:apply|patch|delete|replace|edit|scale|rollout|cordon|drain)\b/);
  assert.doesNotMatch(script, /systemctl|shutdown|reboot|poweroff|tc qdisc|fallocate|date -s/);
});

test("assertScenarioId accepts only reviewed campaign scenarios", () => {
  assert.equal(assertScenarioId(spec(), "seven-day-soak").category, "soak");
  assert.throws(() => assertScenarioId(spec(), "invented-chaos"), /unknown acceptance scenario/);
});
