import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  REQUIRED_GATES,
  buildMigrationPlan,
  loadMigrationInputs,
  simulateMigrationPlan,
  validateMigrationSpec,
  validateObservations,
} from "./plan-laptop-cloud-migration.mjs";

const root = new URL("../", import.meta.url);
const observations = JSON.parse(
  fs.readFileSync(new URL("../migration/rehearsal-observations.example.json", import.meta.url), "utf8"),
);
const fixedNow = new Date("2026-07-31T05:46:00Z");

function inputs() {
  return loadMigrationInputs();
}

function examplePlan() {
  const { spec, source, target } = inputs();
  return buildMigrationPlan({
    spec,
    source,
    target,
    observations: structuredClone(observations),
    allowExample: true,
    now: fixedNow,
  });
}

test("laptop and cloud profiles share the production identity and provider-neutral base", () => {
  const { spec, source, target } = inputs();
  const policy = validateMigrationSpec(spec, source, target);

  assert.equal(source.cluster_id, "fiducia-prod");
  assert.equal(target.cluster_id, source.cluster_id);
  assert.equal(target.shard_count, source.shard_count);
  assert.equal(target.replication_factor, source.replication_factor);
  assert.equal(policy.quorum, 2);
  assert.equal(policy.max_parallel_replacements, 1);

  for (const replacement of policy.replacements) {
    const sourceOverlay = fs.readFileSync(
      new URL(`../laptop/clusters/${replacement.source}/kustomization.yaml`, import.meta.url),
      "utf8",
    );
    const targetOverlay = fs.readFileSync(
      new URL(`../clusters/${replacement.target}/kustomization.yaml`, import.meta.url),
      "utf8",
    );
    assert.match(sourceOverlay, /resources:\n\s+- \.\.\/\.\.\/\.\.\/base/);
    assert.match(targetOverlay, /resources:\n\s+- \.\.\/\.\.\/base/);
  }
});

test("planner replaces non-leaders first and the observed Fiducia leader last", () => {
  const plan = examplePlan();
  assert.deepEqual(
    plan.replacements.map((replacement) => replacement.source),
    ["laptop-aws-sim", "laptop-gcp-sim", "laptop-azure-sim"],
  );
  assert.equal(plan.replacements[0].observedRoles.fiduciaLeader, false);
  assert.equal(plan.replacements[1].observedRoles.jetstreamLeader, true);
  assert.equal(plan.replacements[2].observedRoles.fiduciaLeader, true);
});

test("every member replacement catches up as a learner before atomic joint consensus", () => {
  const plan = examplePlan();
  for (const replacement of plan.replacements) {
    const kinds = replacement.actions.map((entry) => entry.kind);
    const learner = kinds.indexOf("add_fiducia_learner");
    const raftCatchup = kinds.indexOf("wait_fiducia_learner_catchup");
    const jetstreamReplica = kinds.indexOf("add_jetstream_replica");
    const jetstreamCatchup = kinds.indexOf("wait_jetstream_replica_catchup");
    const fencedReplay = kinds.indexOf("verify_outbox_replay_fencing_and_idempotency");
    const joint = kinds.indexOf("joint_consensus_replace_voter");
    const stable = kinds.indexOf("verify_stable_membership");

    assert.ok(learner < raftCatchup);
    assert.ok(raftCatchup < jetstreamReplica);
    assert.ok(jetstreamReplica < jetstreamCatchup);
    assert.ok(jetstreamCatchup < fencedReplay);
    assert.ok(fencedReplay < joint);
    assert.ok(joint < stable);

    const jointAction = replacement.actions[joint];
    assert.equal(jointAction.oldConfig.length, 3);
    assert.equal(jointAction.newConfig.length, 3);
    assert.equal(jointAction.jointConfigUnion.length, 4);
    assert.equal(jointAction.requireOldMajority, 2);
    assert.equal(jointAction.requireNewMajority, 2);
    assert.equal(jointAction.prohibitStableEvenSizedConfig, true);
    assert.equal(replacement.stableVotersAfter.length, 3);
  }
});

test("abstract rehearsal proves stable 2-of-3 quorum, rollback, and exact cloud membership", () => {
  const plan = examplePlan();
  const report = simulateMigrationPlan(plan);

  assert.equal(report.status, "passed");
  assert.equal(report.softwareOnly, true);
  assert.equal(report.rollbackExercises, 1);
  assert.equal(report.maxConcurrentReplacementsObserved, 1);
  assert.equal(report.everyStableCheckpointSurvivesOneMemberLoss, true);
  assert.deepEqual(report.finalVoters, ["civo", "hetzner", "vultr"]);
  assert.ok(report.stableCheckpoints.some((checkpoint) => checkpoint.name === "rollback-exercise-1"));
});

test("planner fails closed on parallel replacement, identity drift, or a missing safety gate", () => {
  const { spec, source, target } = inputs();

  const parallel = structuredClone(spec);
  parallel.max_parallel_replacements = 2;
  assert.throws(() => validateMigrationSpec(parallel, source, target), /must equal 1/);

  const wrongIdentity = structuredClone(target);
  wrongIdentity.cluster_id = "different-production-cluster";
  assert.throws(() => validateMigrationSpec(spec, source, wrongIdentity), /cluster_id must match/);

  const policy = validateMigrationSpec(spec, source, target);
  const missingGate = structuredClone(observations);
  missingGate.gates.fencing = false;
  assert.throws(
    () => validateObservations(missingGate, policy, { allowExample: true, now: fixedNow }),
    /fencing/,
  );
});

test("example evidence cannot be mistaken for production evidence", () => {
  const { spec, source, target } = inputs();
  const policy = validateMigrationSpec(spec, source, target);
  assert.throws(
    () => validateObservations(structuredClone(observations), policy, { now: fixedNow }),
    /requires --allow-example/,
  );

  const live = structuredClone(observations);
  live.evidenceMode = "live";
  live.observedAt = "2026-07-31T05:45:30Z";
  assert.throws(
    () => validateObservations(live, policy, { now: fixedNow }),
    /cannot use example evidence/,
  );

  for (const key of Object.keys(live.backupProof)) live.backupProof[key] = `live-${key}-proof`;
  assert.doesNotThrow(() => validateObservations(live, policy, { now: fixedNow }));

  live.observedAt = "2026-07-31T05:00:00Z";
  assert.throws(() => validateObservations(live, policy, { now: fixedNow }), /older than ten minutes/);
});

test("all target prerequisites are explicit and retirement remains the final operation", () => {
  const plan = examplePlan();
  assert.deepEqual(plan.globalPreconditions.requiredGates, REQUIRED_GATES);
  assert.equal(plan.invariants.sourceRetainedThroughRollbackWindow, true);
  assert.equal(plan.invariants.physicalRetirementOccursLast, true);

  const cutoverKinds = plan.fleetCutover.map((entry) => entry.kind);
  assert.deepEqual(cutoverKinds.slice(-2), ["revoke_laptop_trust_and_access", "securely_wipe_retired_laptops"]);
  assert.ok(plan.replacements.every((replacement) => replacement.actions.at(-2).kind === "start_rollback_window"));
  assert.ok(plan.stopConditions.some((condition) => condition.includes("fencing")));
});

test("same policy and observations produce byte-for-byte deterministic JSON", () => {
  const first = JSON.stringify(examplePlan());
  const second = JSON.stringify(examplePlan());
  assert.equal(first, second);
});
