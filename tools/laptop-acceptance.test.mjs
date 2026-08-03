import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  loadAcceptancePolicy,
  validateAcceptanceEvidence,
} from "./validate-laptop-acceptance-evidence.mjs";

const policy = loadAcceptancePolicy();
const example = JSON.parse(
  fs.readFileSync(new URL("../acceptance/laptop-fleet-evidence.example.json", import.meta.url), "utf8"),
);
const fixedNow = new Date("2026-08-03T17:30:00Z");

function evidence() {
  return structuredClone(example);
}

function makeLive(value = evidence()) {
  value.evidenceMode = "live";
  value.observedAt = "2026-08-03T17:00:00Z";
  for (const scenario of Object.values(value.scenarios)) {
    scenario.proofId = scenario.proofId.replace(/^example-/, "live-");
  }
  for (const collection of [value.restoreProofs, value.alertReceipts, value.revocationProofs]) {
    for (const key of Object.keys(collection)) {
      collection[key] = collection[key].replace(/^example-/, "live-");
    }
  }
  return value;
}

test("policy requires seven days, three clusters, and zero acknowledged loss or duplicate mutation", () => {
  assert.equal(policy.minimum_soak_hours, 168);
  assert.equal(policy.clusters.length, 3);
  assert.equal(policy.maximum_acknowledged_message_loss, 0);
  assert.equal(policy.maximum_duplicate_protected_mutations, 0);
  assert.ok(policy.requiredScenarios.includes("leader-power-loss"));
  assert.ok(policy.requiredScenarios.includes("clean-room-restore"));
  assert.ok(policy.requiredScenarios.includes("lost-device-revocation"));
  assert.ok(policy.requiredAlerts.includes("quorum"));
  assert.ok(policy.requiredRevocations.includes("tls-mtls"));
});

test("example evidence validates structure only and never approves production", () => {
  assert.throws(
    () => validateAcceptanceEvidence(evidence(), policy, { now: fixedNow }),
    /requires --allow-example/,
  );
  const report = validateAcceptanceEvidence(evidence(), policy, {
    allowExample: true,
    now: fixedNow,
  });
  assert.equal(report.decision, "example-only");
  assert.equal(report.productionApproval, false);
  assert.equal(report.classification, "limited-production");
  assert.equal(report.failureDomains.qualifiesForLimitedProduction, true);
  assert.match(report.warnings.join("\n"), /cannot approve/i);
});

test("complete fresh live evidence can qualify for limited production", () => {
  const report = validateAcceptanceEvidence(makeLive(), policy, { now: fixedNow });
  assert.equal(report.decision, "eligible-limited-production");
  assert.equal(report.productionApproval, true);
  assert.equal(report.passedScenarioCount, policy.requiredScenarios.length);
  assert.equal(report.provedAlertCount, policy.requiredAlerts.length);
  assert.equal(report.provedRestoreCount, policy.requiredRestoreProofs.length);
  assert.equal(report.provedRevocationCount, policy.requiredRevocations.length);
});

test("correlated sites, networks, or power domains cannot request limited production", () => {
  const correlated = makeLive();
  correlated.failureDomains["laptop-gcp-sim"].site = correlated.failureDomains["laptop-aws-sim"].site;
  assert.throws(
    () => validateAcceptanceEvidence(correlated, policy, { now: fixedNow }),
    /may request only beta-only/,
  );

  correlated.classificationRequested = "beta-only";
  const report = validateAcceptanceEvidence(correlated, policy, { now: fixedNow });
  assert.equal(report.decision, "eligible-beta-only");
  assert.equal(report.failureDomains.distinctSites, false);
  assert.equal(report.failureDomains.qualifiesForLimitedProduction, false);
});

test("every scenario, restore, alert, and revocation proof is mandatory", () => {
  const missingScenario = makeLive();
  delete missingScenario.scenarios[policy.requiredScenarios[0]];
  assert.throws(() => validateAcceptanceEvidence(missingScenario, policy, { now: fixedNow }), /scenarios keys/);

  const failedScenario = makeLive();
  failedScenario.scenarios["leader-power-loss"].passed = false;
  assert.throws(() => validateAcceptanceEvidence(failedScenario, policy, { now: fixedNow }), /leader-power-loss\.passed/);

  const missingRestore = makeLive();
  delete missingRestore.restoreProofs.database;
  assert.throws(() => validateAcceptanceEvidence(missingRestore, policy, { now: fixedNow }), /restoreProofs keys/);

  const missingAlert = makeLive();
  missingAlert.alertReceipts.quorum = "";
  assert.throws(() => validateAcceptanceEvidence(missingAlert, policy, { now: fixedNow }), /alertReceipts\.quorum/);

  const missingRevocation = makeLive();
  delete missingRevocation.revocationProofs["runtime-secret-store"];
  assert.throws(() => validateAcceptanceEvidence(missingRevocation, policy, { now: fixedNow }), /revocationProofs keys/);
});

test("RTO, RPO, message-loss, duplicate-effect, soak, and sampling limits fail closed", () => {
  const cases = [
    ["publicFailoverRtoSeconds", policy.maximum_public_failover_rto_seconds + 1],
    ["memberRebuildRtoSeconds", policy.maximum_member_rebuild_rto_seconds + 1],
    ["fleetRestoreRtoSeconds", policy.maximum_fleet_restore_rto_seconds + 1],
    ["criticalRpoSeconds", policy.maximum_critical_rpo_seconds + 1],
    ["acknowledgedMessageLoss", 1],
    ["duplicateProtectedMutations", 1],
  ];
  for (const [field, value] of cases) {
    const candidate = makeLive();
    candidate.measurements[field] = value;
    assert.throws(
      () => validateAcceptanceEvidence(candidate, policy, { now: fixedNow }),
      new RegExp(field),
    );
  }

  const shortSoak = makeLive();
  shortSoak.soak.durationHours = 167;
  assert.throws(() => validateAcceptanceEvidence(shortSoak, policy, { now: fixedNow }), /soak duration/);

  const sparse = makeLive();
  sparse.soak.maximumSampleGapMinutes = policy.maximum_sample_gap_minutes + 1;
  assert.throws(() => validateAcceptanceEvidence(sparse, policy, { now: fixedNow }), /sample gap/);
});

test("stale evidence, placeholder live proofs, and self-approval are rejected", () => {
  const stale = makeLive();
  stale.observedAt = "2026-08-01T00:00:00Z";
  assert.throws(() => validateAcceptanceEvidence(stale, policy, { now: fixedNow }), /stale/);

  const placeholder = makeLive();
  placeholder.restoreProofs.database = "example-database-proof";
  assert.throws(() => validateAcceptanceEvidence(placeholder, policy, { now: fixedNow }), /cannot use example proof/);

  const sameApprover = makeLive();
  sameApprover.approvals.reviewer.identity = sameApprover.approvals.operator.identity;
  assert.throws(() => validateAcceptanceEvidence(sameApprover, policy, { now: fixedNow }), /must be distinct/);
});

test("unresolved critical findings and secret-bearing evidence are rejected", () => {
  const finding = makeLive();
  finding.findings.push({
    id: "live-critical-finding",
    severity: "critical",
    resolved: false,
  });
  assert.throws(() => validateAcceptanceEvidence(finding, policy, { now: fixedNow }), /unresolved critical/);

  const secretField = makeLive();
  secretField.token = "not-allowed-even-if-redacted-later";
  assert.throws(() => validateAcceptanceEvidence(secretField, policy, { now: fixedNow }), /prohibited secret-bearing field/);

  const privateKey = makeLive();
  privateKey.findings.push({
    id: "bad-attachment",
    severity: "low",
    resolved: true,
    note: "-----BEGIN PRIVATE KEY-----",
  });
  assert.throws(() => validateAcceptanceEvidence(privateKey, policy, { now: fixedNow }), /private-key pattern/);
});

test("identical policy and evidence produce a deterministic report fingerprint", () => {
  const first = validateAcceptanceEvidence(makeLive(), policy, { now: fixedNow });
  const second = validateAcceptanceEvidence(makeLive(), policy, { now: fixedNow });
  assert.deepEqual(first, second);
  assert.match(first.evidenceFingerprint, /^[0-9a-f]{64}$/);
  assert.match(first.policyFingerprint, /^[0-9a-f]{64}$/);
});
