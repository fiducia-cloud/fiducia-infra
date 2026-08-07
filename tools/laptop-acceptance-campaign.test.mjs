import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  buildAcceptancePlan,
  loadJson as loadCampaignJson,
  simulateAcceptancePlan,
  validateCampaignSpec,
  validatePreflight,
} from "./plan-laptop-acceptance-campaign.mjs";
import {
  buildExampleAcceptanceResults,
  validateAcceptanceResults,
} from "./validate-laptop-acceptance-results.mjs";

const campaignPath = new URL("../laptop/acceptance/campaign.json", import.meta.url).pathname;
const preflightPath = new URL("../laptop/acceptance/preflight.example.json", import.meta.url).pathname;
const fixedNow = new Date("2026-08-03T18:11:00Z");
const campaign = () => structuredClone(loadCampaignJson(campaignPath, "campaign"));
const preflight = () => structuredClone(loadCampaignJson(preflightPath, "preflight"));

function examplePlan() {
  return buildAcceptancePlan({
    spec: campaign(),
    preflight: preflight(),
    allowExample: true,
    now: fixedNow,
  });
}

function livePreflight() {
  const value = preflight();
  value.evidenceMode = "live";
  value.observedAt = "2026-08-03T18:10:30Z";
  for (const key of Object.keys(value.backups)) {
    value.backups[key] = value.backups[key].replace(/^example:/, "evidence:");
  }
  return value;
}

function liveResults(plan) {
  const results = buildExampleAcceptanceResults(plan);
  results.evidenceMode = "live";
  for (const step of results.steps) {
    step.proofRefs = step.proofRefs.map((proof) => proof.replace(/^example:/, "evidence:"));
    if (step.humanObserver === "example-human-observer") step.humanObserver = "acceptance-reviewer";
  }
  results.soak.proofRefs = results.soak.proofRefs.map((proof) => proof.replace(/^example:/, "evidence:"));
  results.finalProofRefs = results.finalProofRefs.map((proof) => proof.replace(/^example:/, "evidence:"));
  results.reviewer = "acceptance-reviewer";
  return results;
}

test("campaign requires one fault at a time, 2-of-3 safety, and a seven-day final soak", () => {
  const spec = validateCampaignSpec(campaign());
  assert.equal(spec.maxConcurrentFaults, 1);
  assert.equal(spec.minimumHealthyFiduciaVoters, 2);
  assert.equal(spec.minimumHealthyJetStreamMembers, 2);
  assert.equal(spec.minimumHealthyPublicOrigins, 2);
  assert.equal(spec.soakHours, 168);
  assert.equal(spec.scenarios.at(-1).id, "seven-day-soak");
  assert.ok(spec.scenarios.length >= 15);
  assert.ok(spec.scenarios.some((scenario) => scenario.id === "power-loss"));
  assert.ok(spec.scenarios.some((scenario) => scenario.id === "lost-device-revocation"));
  assert.ok(spec.scenarios.some((scenario) => scenario.id === "jetstream-clean-room-restore"));
});

test("example preflight is never silently accepted as live readiness", () => {
  const spec = validateCampaignSpec(campaign());
  assert.throws(() => validatePreflight(preflight(), spec, { now: fixedNow }), /requires --allow-example/);
  assert.doesNotThrow(() => validatePreflight(preflight(), spec, { allowExample: true, now: fixedNow }));

  const live = livePreflight();
  assert.doesNotThrow(() => validatePreflight(live, spec, { now: fixedNow }));
  live.observedAt = "2026-08-03T17:00:00Z";
  assert.throws(() => validatePreflight(live, spec, { now: fixedNow }), /older than ten minutes/);
});

test("preflight fails closed on missing health, backup, role, probe, or readiness evidence", () => {
  const spec = validateCampaignSpec(campaign());

  const missingVoter = preflight();
  missingVoter.healthyFiduciaVoters.pop();
  assert.throws(() => validatePreflight(missingVoter, spec, { allowExample: true, now: fixedNow }), /must exactly equal/);

  const missingBackup = preflight();
  missingBackup.backups.k3sSnapshot = "";
  assert.throws(() => validatePreflight(missingBackup, spec, { allowExample: true, now: fixedNow }), /is invalid/);

  const wrongLeader = preflight();
  wrongLeader.fiduciaLeader = "unknown-cluster";
  assert.throws(() => validatePreflight(wrongLeader, spec, { allowExample: true, now: fixedNow }), /current laptop cluster/);

  const oneProbe = preflight();
  oneProbe.externalProbeRegions = ["us-east"];
  assert.throws(() => validatePreflight(oneProbe, spec, { allowExample: true, now: fixedNow }), /independent probe regions/);

  const unready = preflight();
  unready.clusterReadiness["laptop-aws-sim"].backupUpload = false;
  assert.throws(() => validatePreflight(unready, spec, { allowExample: true, now: fixedNow }), /backupUpload must be true/);
});

test("planner orders non-leaders before leaders and chooses a non-leader recovery target", () => {
  const plan = examplePlan();
  assert.equal(plan.designatedRecoveryCluster, "laptop-aws-sim");

  const fiducia = plan.steps.filter((step) => step.scenario.id === "fiducia-member-restart");
  assert.deepEqual(fiducia.map((step) => step.target), ["laptop-aws-sim", "laptop-gcp-sim", "laptop-azure-sim"]);
  assert.equal(fiducia.at(-1).target, "laptop-azure-sim");

  const jetstream = plan.steps.filter((step) => step.scenario.id === "jetstream-member-restart");
  assert.equal(jetstream.at(-1).target, "laptop-gcp-sim");
  assert.ok(jetstream.at(-1).observedRoleScore > 0);

  assert.equal(plan.steps.at(-1).stepId, "seven-day-soak@fleet");
  assert.match(plan.planFingerprint, /^[a-f0-9]{64}$/);
});

test("every planned fault acquires a lease, verifies degraded safety, recovers, catches up, and releases", () => {
  const plan = examplePlan();
  for (const step of plan.steps) {
    const kinds = step.actions.map((entry) => entry.kind);
    const lease = kinds.indexOf("acquire_exclusive_fault_lease");
    const inject = kinds.indexOf("inject_fault");
    const degraded = kinds.indexOf("verify_degraded_safety");
    const recover = kinds.indexOf("recover_fault");
    const catchup = kinds.indexOf("wait_full_readiness_and_catchup");
    const external = kinds.indexOf("verify_external_probes_and_data_safety");
    const release = kinds.indexOf("record_reviewed_result_and_release_fault_lease");
    assert.ok(lease === 0);
    assert.ok(lease < inject && inject < degraded && degraded < recover && recover < catchup && catchup < external && external < release);
    assert.equal(step.actions[inject].requiresHumanStopAuthority, step.scenario.execution !== "automated-kubernetes");
    if (step.scenario.requiresProtectedMutationProbe) {
      assert.ok(kinds.includes("verify_fencing_outbox_and_idempotency"));
    }
  }
});

test("abstract rehearsal preserves two-of-three safety and full recovery before every next fault", () => {
  const report = simulateAcceptancePlan(examplePlan());
  assert.equal(report.status, "passed");
  assert.equal(report.softwareOnly, true);
  assert.equal(report.maxConcurrentFaultsObserved, 1);
  assert.equal(report.allStepsRecoveredBeforeNextFault, true);
  assert.equal(report.everyDegradedCheckpointPreservesTwoOfThree, true);
  assert.equal(report.statefulLeadersOrderedLast, true);
  assert.equal(report.finalStep, "seven-day-soak@fleet");
  assert.ok(report.stepCount > 40);
  assert.equal(report.checkpoints.length, report.stepCount);
});

test("unsafe campaign edits fail before a plan can exist", () => {
  const parallel = campaign();
  parallel.maxConcurrentFaults = 2;
  assert.throws(() => validateCampaignSpec(parallel), /must equal 1/);

  const shortSoak = campaign();
  shortSoak.soakHours = 24;
  assert.throws(() => validateCampaignSpec(shortSoak), /at least 168/);

  const twoVotersLost = campaign();
  twoVotersLost.scenarios[0].expectedFiduciaVotersLost = 2;
  assert.throws(() => validateCampaignSpec(twoVotersLost), /must be 0 or 1/);

  const soakNotLast = campaign();
  soakNotLast.scenarios.reverse();
  assert.throws(() => validateCampaignSpec(soakNotLast), /final declared scenario/);
});

test("example completed results require explicit rehearsal mode and validate every immutable step", () => {
  const plan = examplePlan();
  const results = buildExampleAcceptanceResults(plan);
  assert.throws(() => validateAcceptanceResults(plan, results), /requires --allow-example/);
  const report = validateAcceptanceResults(plan, results, { allowExample: true });
  assert.equal(report.status, "passed");
  assert.equal(report.evidenceMode, "example");
  assert.equal(report.stepCount, plan.steps.length);
  assert.equal(report.soakHours, 168);
  assert.equal(report.zeroLostCommittedFiduciaEntries, true);
  assert.equal(report.zeroLostJetStreamMessages, true);
  assert.equal(report.zeroDuplicateProtectedEffects, true);
  assert.match(report.reportFingerprint, /^[a-f0-9]{64}$/);
});

test("live results fail on missing steps, loss, duplicate effects, RTO/RPO, soak, or physical-domain misclassification", () => {
  const plan = examplePlan();
  const valid = liveResults(plan);
  assert.doesNotThrow(() => validateAcceptanceResults(plan, valid));

  const missing = liveResults(plan);
  missing.steps.pop();
  assert.throws(() => validateAcceptanceResults(plan, missing), /exactly .* entries/);

  const lostMessage = liveResults(plan);
  lostMessage.steps[0].lostJetStreamMessages = 1;
  assert.throws(() => validateAcceptanceResults(plan, lostMessage), /must equal 0/);

  const duplicateEffect = liveResults(plan);
  duplicateEffect.steps[1].duplicateProtectedEffects = 1;
  assert.throws(() => validateAcceptanceResults(plan, duplicateEffect), /must equal 0/);

  const slowFailover = liveResults(plan);
  slowFailover.steps[0].publicFailoverSeconds = 301;
  assert.throws(() => validateAcceptanceResults(plan, slowFailover), /exceeds the target/);

  const badRpo = liveResults(plan);
  badRpo.measuredCriticalRpoSeconds = 3601;
  assert.throws(() => validateAcceptanceResults(plan, badRpo), /exceeds the target/);

  const shortSoak = liveResults(plan);
  shortSoak.soak.actualHours = 167.99;
  assert.throws(() => validateAcceptanceResults(plan, shortSoak), /at least 168/);

  const correlated = liveResults(plan);
  correlated.physicalFailureDomainsIndependent = false;
  assert.throws(() => validateAcceptanceResults(plan, correlated), /independent physical failure domains/);
});

test("manual, physical, security, and destructive results require a human observer and unique non-example proofs", () => {
  const plan = examplePlan();
  const results = liveResults(plan);
  const manualIndex = results.steps.findIndex((step) => step.execution !== "automated-kubernetes");
  results.steps[manualIndex].humanObserver = null;
  assert.throws(() => validateAcceptanceResults(plan, results), /humanObserver is required/);

  const exampleProof = liveResults(plan);
  exampleProof.steps[0].proofRefs[0] = "example:result:01:before";
  assert.throws(() => validateAcceptanceResults(plan, exampleProof), /cannot use example evidence/);

  const duplicateProof = liveResults(plan);
  duplicateProof.steps[1].proofRefs[0] = duplicateProof.steps[0].proofRefs[0];
  assert.throws(() => validateAcceptanceResults(plan, duplicateProof), /reuses proof reference/);
});

test("cluster snapshot capture excludes secret-bearing and address-rich resources", () => {
  const script = fs.readFileSync(new URL("../scripts/capture-laptop-cluster-snapshot.sh", import.meta.url), "utf8");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /umask 077/);
  assert.match(script, /chmod 600/);
  assert.match(script, /secrets: "excluded"/);
  assert.match(script, /configMaps: "excluded"/);
  assert.match(script, /logs: "excluded"/);
  assert.match(script, /events: "excluded"/);
  assert.match(script, /podAndServiceIpAddresses: "excluded"/);
  assert.doesNotMatch(script, /get secrets|get configmaps|kubectl logs|get events/);
  assert.doesNotMatch(script, /\.status\.podIP|\.spec\.clusterIP|\.status\.addresses/);
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b/);
});

test("software fault runner is plan-only by default, globally locked, acknowledged, and evidence-producing", () => {
  const script = fs.readFileSync(new URL("../scripts/run-laptop-software-fault.sh", import.meta.url), "utf8");
  assert.match(script, /\[\[ "\$apply" == "true" \]\] \|\| exit 0/);
  assert.match(script, /--ack-production-fault/);
  assert.match(script, /--ack-single-fault/);
  assert.match(script, /--ack-rollback-reviewed/);
  assert.match(script, /--ack-leader-last/);
  assert.match(script, /fiducia-acceptance-active-fault/);
  assert.match(script, /another acceptance fault lock already exists/);
  assert.match(script, /expected exactly one running app=/);
  assert.match(script, /rollout status/);
  assert.match(script, /capture-laptop-cluster-snapshot\.sh/);
  assert.match(script, /externalVerificationRequired/);
  assert.match(script, /not a completed DEN-946 acceptance step/);
  assert.doesNotMatch(script, /delete (?:node|persistentvolumeclaim|namespace)/);
  assert.doesNotMatch(script, /set -x|set -o xtrace/);
});

test("identical policy and preflight produce byte-for-byte deterministic plans and reports", () => {
  const firstPlan = examplePlan();
  const secondPlan = examplePlan();
  assert.equal(JSON.stringify(firstPlan), JSON.stringify(secondPlan));
  assert.equal(JSON.stringify(simulateAcceptancePlan(firstPlan)), JSON.stringify(simulateAcceptancePlan(secondPlan)));
});
