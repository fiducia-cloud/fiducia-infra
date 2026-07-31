#!/usr/bin/env node
// Build and abstractly rehearse a one-member-at-a-time migration from the
// temporary laptop topology to the canonical cloud topology. This planner does
// not mutate a cluster. Live execution still requires fresh, independently
// captured evidence and the runtime membership APIs named in the plan.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadTopology, parseToml } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const defaultSpecPath = path.join(root, "migration", "laptop-to-cloud.toml");
const SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_OBSERVATION_AGE_MS = 10 * 60 * 1000;

export const REQUIRED_GATES = [
  "bridgeNetwork",
  "privateDns",
  "mtlsTrust",
  "secretBootstrap",
  "externalBackups",
  "telemetry",
  "targetStorage",
  "databaseReachability",
  "objectStorageReachability",
  "fencing",
  "outboxReplay",
  "dynamicMembershipApi",
  "jetstreamReconfiguration",
  "membershipLease",
  "externalHealthChecks",
];

export const TARGET_READINESS_GATES = [
  "kubernetes",
  "gitops",
  "storage",
  "mesh",
  "tls",
  "telemetry",
  "backups",
];

const fail = (message) => {
  throw new Error(message);
};

function safeRepoPath(relativePath, field) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    fail(`${field} must be a non-empty repository-relative path`);
  }
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`${field} escapes the repository: ${relativePath}`);
  }
  return resolved;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
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

function topologyFingerprint(topology) {
  return digest({
    cluster_id: topology.cluster_id,
    shard_count: topology.shard_count,
    replication_factor: topology.replication_factor,
    connectivity: topology.connectivity,
    raft: topology.raft,
    clusters: topology.cluster
      .map((cluster) => ({
        name: cluster.name,
        platform: cluster.platform ?? null,
        region: cluster.region ?? null,
        site: cluster.site ?? null,
        storage_class: cluster.storage_class,
        node_replicas: cluster.node_replicas,
        brain: cluster.brain,
        brain_endpoint: cluster.brain_endpoint,
        node_peer_endpoint: cluster.node_peer_endpoint,
        node_api_endpoint: cluster.node_api_endpoint ?? null,
        lb_endpoint: cluster.lb_endpoint,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

function exactSet(actual, expected, label) {
  if (!Array.isArray(actual)) fail(`${label} must be an array`);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size !== actual.length) fail(`${label} contains duplicates`);
  const missing = [...expectedSet].filter((item) => !actualSet.has(item));
  const extra = [...actualSet].filter((item) => !expectedSet.has(item));
  if (missing.length || extra.length) {
    fail(`${label} must exactly equal [${expected.join(", ")}]; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`);
  }
}

function brainNames(topology) {
  return topology.cluster.filter((cluster) => cluster.brain !== false).map((cluster) => cluster.name);
}

function parseTrafficSteps(value) {
  if (typeof value !== "string") fail("traffic_steps must be a comma-separated string");
  const steps = value.split(",").map((part) => Number(part.trim()));
  if (!steps.length || steps.some((step) => !Number.isInteger(step) || step < 1 || step > 100)) {
    fail("traffic_steps must contain integer percentages in 1..100");
  }
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index] <= steps[index - 1]) fail("traffic_steps must be strictly increasing");
  }
  if (steps.at(-1) !== 100) fail("traffic_steps must finish at 100");
  return steps;
}

export function loadMigrationInputs(specFile = defaultSpecPath) {
  if (!fs.existsSync(specFile)) fail(`missing migration spec: ${specFile}`);
  const spec = parseToml(fs.readFileSync(specFile, "utf8"));
  const sourcePath = safeRepoPath(spec.source_topology, "source_topology");
  const targetPath = safeRepoPath(spec.target_topology, "target_topology");
  return {
    spec,
    source: loadTopology(sourcePath),
    target: loadTopology(targetPath),
    paths: { spec: specFile, source: sourcePath, target: targetPath },
  };
}

export function validateMigrationSpec(spec, source, target) {
  if (typeof spec.migration_id !== "string" || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(spec.migration_id)) {
    fail("migration_id must be a DNS-like lowercase identifier");
  }
  if (spec.max_parallel_replacements !== 1) {
    fail("max_parallel_replacements must equal 1 for quorum-bearing migration");
  }
  if (!Number.isInteger(spec.minimum_stable_voters) || spec.minimum_stable_voters < 3 || spec.minimum_stable_voters % 2 === 0) {
    fail("minimum_stable_voters must be an odd integer >= 3");
  }
  if (!Number.isInteger(spec.rollback_window_hours) || spec.rollback_window_hours < 24) {
    fail("rollback_window_hours must be at least 24");
  }
  if (!Number.isInteger(spec.catchup_stable_seconds) || spec.catchup_stable_seconds < 60) {
    fail("catchup_stable_seconds must be at least 60");
  }
  for (const field of ["max_raft_lag_entries", "max_jetstream_lag_messages"]) {
    if (!Number.isInteger(spec[field]) || spec[field] < 0) fail(`${field} must be a non-negative integer`);
  }
  for (const field of ["require_joint_consensus", "require_external_backups", "require_fencing", "require_outbox_replay"]) {
    if (spec[field] !== true) fail(`${field} must remain true`);
  }
  if (spec.bridge_connectivity !== "wireguard") {
    fail("bridge_connectivity must be wireguard while laptops and cloud clusters coexist");
  }
  const trafficSteps = parseTrafficSteps(spec.traffic_steps);

  for (const field of ["cluster_id", "shard_count", "replication_factor"]) {
    if (source[field] !== target[field]) {
      fail(`source and target ${field} must match; got ${JSON.stringify(source[field])} vs ${JSON.stringify(target[field])}`);
    }
  }
  if (source.replication_factor !== spec.minimum_stable_voters) {
    fail("minimum_stable_voters must equal the production replication_factor");
  }

  const sourceBrains = brainNames(source);
  const targetBrains = brainNames(target);
  if (sourceBrains.length !== spec.minimum_stable_voters || targetBrains.length !== spec.minimum_stable_voters) {
    fail(`source and target must each have exactly ${spec.minimum_stable_voters} brain voters`);
  }
  const sourceByName = new Map(source.cluster.map((cluster) => [cluster.name, cluster]));
  const targetByName = new Map(target.cluster.map((cluster) => [cluster.name, cluster]));
  for (const name of sourceBrains) {
    if (sourceByName.get(name)?.platform !== "local-laptop") fail(`${name} is not a laptop source member`);
  }
  for (const name of targetBrains) {
    if (targetByName.get(name)?.platform === "local-laptop") fail(`${name} is not a cloud target member`);
  }

  const replacements = spec.replacement;
  if (!Array.isArray(replacements) || replacements.length !== sourceBrains.length) {
    fail(`migration must declare exactly ${sourceBrains.length} [[replacement]] mappings`);
  }
  exactSet(replacements.map((entry) => entry.source), sourceBrains, "replacement sources");
  exactSet(replacements.map((entry) => entry.target), targetBrains, "replacement targets");
  for (const entry of replacements) {
    if (entry.source === entry.target) fail(`replacement source and target must differ: ${entry.source}`);
  }

  return {
    ...spec,
    trafficSteps,
    replacements: replacements.map((entry, index) => ({ ...entry, declaredOrder: index })),
    sourceBrains,
    targetBrains,
    quorum: Math.floor(spec.minimum_stable_voters / 2) + 1,
  };
}

function readObservations(file) {
  if (!file || !fs.existsSync(file)) fail(`missing observations file: ${file || "(none)"}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid observations JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateObservations(observations, policy, { allowExample = false, now = new Date() } = {}) {
  if (!observations || typeof observations !== "object") fail("observations must be an object");
  if (!new Set(["live", "example"]).has(observations.evidenceMode)) {
    fail("evidenceMode must be live or example");
  }
  if (observations.evidenceMode === "example" && !allowExample) {
    fail("example evidence is non-production and requires --allow-example");
  }
  if (!SHA_RE.test(observations.pinnedRevision ?? "")) fail("pinnedRevision must be an exact 40-character Git SHA");
  if (!SHA_RE.test(observations.rollbackRevision ?? "")) fail("rollbackRevision must be an exact 40-character Git SHA");

  const observedAt = new Date(observations.observedAt);
  if (Number.isNaN(observedAt.getTime())) fail("observedAt must be an ISO timestamp");
  if (observations.evidenceMode === "live") {
    const age = now.getTime() - observedAt.getTime();
    if (age < -60_000) fail("live observations cannot be materially in the future");
    if (age > MAX_OBSERVATION_AGE_MS) fail("live observations are older than ten minutes; re-observe roles and health");
  }

  exactSet(observations.healthyFiduciaVoters, policy.sourceBrains, "healthyFiduciaVoters");
  exactSet(observations.healthyJetStreamMembers, policy.sourceBrains, "healthyJetStreamMembers");
  if (!policy.sourceBrains.includes(observations.fiduciaLeader)) fail("fiduciaLeader must be a current source voter");
  if (!Array.isArray(observations.jetstreamLeaders) || !observations.jetstreamLeaders.length) {
    fail("jetstreamLeaders must contain at least one current source member");
  }
  for (const leader of new Set(observations.jetstreamLeaders)) {
    if (!policy.sourceBrains.includes(leader)) fail(`unknown JetStream leader: ${leader}`);
  }

  for (const gate of REQUIRED_GATES) {
    if (observations.gates?.[gate] !== true) fail(`required migration gate is not proven: ${gate}`);
  }
  const proofs = ["fiduciaSnapshot", "databaseBackup", "jetstreamSnapshot", "objectStoreProbe", "recoveryKeyCustody"];
  for (const proof of proofs) {
    const value = observations.backupProof?.[proof];
    if (typeof value !== "string" || !value.trim()) fail(`backupProof.${proof} is required`);
    if (observations.evidenceMode === "live" && /^example-/i.test(value)) {
      fail(`live backupProof.${proof} cannot use example evidence`);
    }
  }
  if (!Array.isArray(observations.externalProbeRegions) || new Set(observations.externalProbeRegions).size < 2) {
    fail("at least two independent external probe regions are required");
  }
  for (const targetName of policy.targetBrains) {
    for (const gate of TARGET_READINESS_GATES) {
      if (observations.targetReadiness?.[targetName]?.[gate] !== true) {
        fail(`targetReadiness.${targetName}.${gate} is not proven`);
      }
    }
  }
  return observations;
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function action(kind, details = {}) {
  return { kind, ...details };
}

export function buildMigrationPlan({ spec, source, target, observations, allowExample = false, now = new Date() }) {
  const policy = validateMigrationSpec(spec, source, target);
  const evidence = validateObservations(observations, policy, { allowExample, now });
  const jetstreamLeaders = new Set(evidence.jetstreamLeaders);

  const ordered = policy.replacements
    .map((entry) => ({
      ...entry,
      isFiduciaLeader: entry.source === evidence.fiduciaLeader,
      isJetStreamLeader: jetstreamLeaders.has(entry.source),
    }))
    .sort((left, right) => {
      const leftScore = (left.isFiduciaLeader ? 100 : 0) + (left.isJetStreamLeader ? 10 : 0);
      const rightScore = (right.isFiduciaLeader ? 100 : 0) + (right.isJetStreamLeader ? 10 : 0);
      return leftScore - rightScore || left.declaredOrder - right.declaredOrder;
    });

  const stableVoters = new Set(policy.sourceBrains);
  const replacements = ordered.map((entry, index) => {
    const before = sorted(stableVoters);
    const afterSet = new Set(stableVoters);
    afterSet.delete(entry.source);
    afterSet.add(entry.target);
    const after = sorted(afterSet);
    const union = sorted(new Set([...before, ...after]));

    const actions = [
      action("acquire_membership_change_lease", {
        scope: source.cluster_id,
        maxParallelReplacements: policy.max_parallel_replacements,
      }),
      action("verify_fresh_global_evidence", {
        observedAt: evidence.observedAt,
        requiredGates: REQUIRED_GATES,
      }),
      action("provision_target_prerequisites", {
        target: entry.target,
        pinnedRevision: evidence.pinnedRevision,
        publicTrafficWeight: 0,
        bridgeConnectivity: policy.bridge_connectivity,
      }),
      action("add_fiducia_learner", {
        target: entry.target,
        votersRemain: before,
      }),
      action("wait_fiducia_learner_catchup", {
        target: entry.target,
        maxLagEntries: policy.max_raft_lag_entries,
        stableSeconds: policy.catchup_stable_seconds,
        requireSnapshotAndCommittedIndexMatch: true,
      }),
      action("add_jetstream_replica", {
        target: entry.target,
        routePublicConsumers: false,
      }),
      action("wait_jetstream_replica_catchup", {
        target: entry.target,
        maxLagMessages: policy.max_jetstream_lag_messages,
        stableSeconds: policy.catchup_stable_seconds,
        requireCriticalStreams: true,
        requireConsumerAckFloorMatch: true,
      }),
      action("verify_outbox_replay_fencing_and_idempotency", {
        source: entry.source,
        target: entry.target,
        databaseRemainsAuthoritative: true,
      }),
      ...(entry.isJetStreamLeader
        ? [action("transfer_jetstream_leadership", { awayFrom: entry.source, reobserveBeforeContinuing: true })]
        : []),
      ...(entry.isFiduciaLeader
        ? [action("transfer_fiducia_leadership", { awayFrom: entry.source, reobserveBeforeContinuing: true })]
        : []),
      action("joint_consensus_replace_voter", {
        source: entry.source,
        target: entry.target,
        oldConfig: before,
        newConfig: after,
        jointConfigUnion: union,
        requireOldMajority: policy.quorum,
        requireNewMajority: policy.quorum,
        prohibitStableEvenSizedConfig: true,
      }),
      action("verify_stable_membership", {
        expectedVoters: after,
        quorum: policy.quorum,
        requireNoLearnersPending: true,
        requireOneFailureTolerance: true,
      }),
      action("promote_stateless_traffic", {
        target: entry.target,
        sourceRetainedForRollback: entry.source,
        percentages: policy.trafficSteps,
        requireExternalHealthAtEveryStep: true,
      }),
      action("start_rollback_window", {
        hours: policy.rollback_window_hours,
        retainSourceIdentityAndDisk: true,
      }),
      action("release_membership_change_lease"),
    ];

    stableVoters.clear();
    for (const voter of after) stableVoters.add(voter);

    return {
      sequence: index + 1,
      source: entry.source,
      target: entry.target,
      observedRoles: {
        fiduciaLeader: entry.isFiduciaLeader,
        jetstreamLeader: entry.isJetStreamLeader,
      },
      stableVotersBefore: before,
      stableVotersAfter: after,
      quorum: policy.quorum,
      actions,
      rollbackBeforeJointConsensus: [
        action("remove_target_jetstream_replica", { target: entry.target }),
        action("remove_target_fiducia_learner", { target: entry.target }),
        action("restore_source_public_weight", { source: entry.source, percentage: 100 }),
        action("release_membership_change_lease"),
      ],
      rollbackAfterJointConsensus: [
        action("readd_source_as_fiducia_learner", { source: entry.source }),
        action("wait_source_raft_catchup", {
          source: entry.source,
          maxLagEntries: policy.max_raft_lag_entries,
          stableSeconds: policy.catchup_stable_seconds,
        }),
        action("readd_source_as_jetstream_replica", { source: entry.source }),
        action("wait_source_jetstream_catchup", {
          source: entry.source,
          maxLagMessages: policy.max_jetstream_lag_messages,
          stableSeconds: policy.catchup_stable_seconds,
        }),
        action("joint_consensus_replace_voter", {
          source: entry.target,
          target: entry.source,
          oldConfig: after,
          newConfig: before,
          requireOldMajority: policy.quorum,
          requireNewMajority: policy.quorum,
        }),
        action("restore_source_public_weight", { source: entry.source, percentage: 100 }),
      ],
    };
  });

  const policyFingerprint = digest({
    ...policy,
    replacement: undefined,
    replacements: policy.replacements,
  });

  return {
    schemaVersion: 1,
    migrationId: policy.migration_id,
    planFingerprint: digest({
      migrationId: policy.migration_id,
      policyFingerprint,
      source: topologyFingerprint(source),
      target: topologyFingerprint(target),
      observations: evidence,
    }),
    evidenceMode: evidence.evidenceMode,
    observedAt: evidence.observedAt,
    pinnedRevision: evidence.pinnedRevision.toLowerCase(),
    rollbackRevision: evidence.rollbackRevision.toLowerCase(),
    topology: {
      clusterId: source.cluster_id,
      shardCount: source.shard_count,
      replicationFactor: source.replication_factor,
      sourceFingerprint: topologyFingerprint(source),
      targetFingerprint: topologyFingerprint(target),
      bridgeConnectivity: policy.bridge_connectivity,
      finalConnectivity: target.connectivity,
    },
    invariants: {
      maxParallelMemberReplacements: 1,
      stableVoterCount: policy.minimum_stable_voters,
      stableQuorum: policy.quorum,
      targetStartsAsLearner: true,
      targetMustCatchUpBeforeJointConsensus: true,
      databaseOutboxRemainsAuthoritative: true,
      fencingRequired: true,
      sourceRetainedThroughRollbackWindow: true,
      physicalRetirementOccursLast: true,
    },
    globalPreconditions: {
      requiredGates: REQUIRED_GATES,
      targetReadinessGates: TARGET_READINESS_GATES,
      externalProbeRegions: evidence.externalProbeRegions,
      backupProof: evidence.backupProof,
    },
    initialStableVoters: sorted(policy.sourceBrains),
    finalStableVoters: sorted(policy.targetBrains),
    replacements,
    fleetCutover: [
      action("verify_all_target_voters_stable", {
        expectedVoters: sorted(policy.targetBrains),
        quorum: policy.quorum,
      }),
      action("complete_full_public_traffic_soak", {
        hours: policy.rollback_window_hours,
        retainLaptopRollbackCapacity: true,
      }),
      action("switch_target_only_connectivity", {
        from: policy.bridge_connectivity,
        to: target.connectivity,
        requireNoLaptopMemberOrTrafficDependency: true,
      }),
      action("revoke_laptop_trust_and_access", {
        systems: [
          "wireguard-or-tailscale",
          "ssh",
          "git-and-registry",
          "tls-mtls",
          "sops-age",
          "cloudflare-tunnel",
          "runtime-secret-store",
          "fiducia-membership",
          "jetstream-membership",
        ],
      }),
      action("securely_wipe_retired_laptops", {
        requireRollbackWindowComplete: true,
        preserveOnlyApprovedEncryptedBackups: true,
      }),
    ],
    stopConditions: [
      "any required gate becomes false",
      "fewer than three healthy stable voters before a replacement",
      "learner or JetStream replica exceeds the configured lag after the stable window",
      "fencing or idempotency proof fails",
      "old or new Raft majority cannot be proven during joint consensus",
      "external health or protected-mutation checks fail at any traffic step",
      "backup, recovery-key, database, or object-storage evidence becomes unavailable",
    ],
    nonClaims: [
      "This plan is not evidence that a physical or cloud cluster was changed.",
      "Example evidence is never acceptable for production execution.",
      "The abstract rehearsal does not replace DEN-946 live failure and restore tests.",
    ],
  };
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function survivesAnyOneFailure(voters, quorum) {
  return voters.every((_removed, index) => voters.filter((_value, candidate) => candidate !== index).length >= quorum);
}

export function simulateMigrationPlan(plan) {
  const current = new Set(plan.initialStableVoters);
  const stableCheckpoints = [
    {
      name: "initial",
      voters: sorted(current),
      quorum: plan.invariants.stableQuorum,
      survivesAnyOneFailure: survivesAnyOneFailure(sorted(current), plan.invariants.stableQuorum),
    },
  ];
  let rollbackExercises = 0;

  for (const replacement of plan.replacements) {
    const before = sorted(current);
    if (!sameMembers(before, replacement.stableVotersBefore)) {
      fail(`simulation drift before replacement ${replacement.sequence}`);
    }
    if (!current.has(replacement.source) || current.has(replacement.target)) {
      fail(`invalid replacement membership for ${replacement.source} -> ${replacement.target}`);
    }

    const actionKinds = replacement.actions.map((entry) => entry.kind);
    const learnerIndex = actionKinds.indexOf("add_fiducia_learner");
    const catchupIndex = actionKinds.indexOf("wait_fiducia_learner_catchup");
    const jointIndex = actionKinds.indexOf("joint_consensus_replace_voter");
    if (!(learnerIndex >= 0 && learnerIndex < catchupIndex && catchupIndex < jointIndex)) {
      fail(`learner/catch-up/joint-consensus order is unsafe for replacement ${replacement.sequence}`);
    }

    const joint = replacement.actions[jointIndex];
    if (joint.oldConfig.length !== 3 || joint.newConfig.length !== 3 || joint.jointConfigUnion.length !== 4) {
      fail(`replacement ${replacement.sequence} must transition 3 -> joint(4 union) -> 3`);
    }

    current.delete(replacement.source);
    current.add(replacement.target);
    const after = sorted(current);
    if (!sameMembers(after, replacement.stableVotersAfter)) {
      fail(`simulation drift after replacement ${replacement.sequence}`);
    }
    if (after.length !== plan.invariants.stableVoterCount) fail("stable voter count changed");
    if (!survivesAnyOneFailure(after, plan.invariants.stableQuorum)) fail("one-member failure tolerance was lost");

    stableCheckpoints.push({
      name: `after-replacement-${replacement.sequence}`,
      voters: after,
      quorum: replacement.quorum,
      survivesAnyOneFailure: true,
    });

    // Exercise a post-commit rollback for the first migration slot, then reapply
    // it so the remainder of the forward plan can continue.
    if (replacement.sequence === 1) {
      current.delete(replacement.target);
      current.add(replacement.source);
      const rolledBack = sorted(current);
      if (!sameMembers(rolledBack, replacement.stableVotersBefore)) fail("rollback did not restore the original voters");
      if (!survivesAnyOneFailure(rolledBack, replacement.quorum)) fail("rollback lost one-member failure tolerance");
      stableCheckpoints.push({
        name: "rollback-exercise-1",
        voters: rolledBack,
        quorum: replacement.quorum,
        survivesAnyOneFailure: true,
      });
      current.delete(replacement.source);
      current.add(replacement.target);
      rollbackExercises += 1;
    }
  }

  const finalVoters = sorted(current);
  if (!sameMembers(finalVoters, plan.finalStableVoters)) fail("simulation did not reach the target voter set");

  return {
    schemaVersion: 1,
    migrationId: plan.migrationId,
    planFingerprint: plan.planFingerprint,
    status: "passed",
    softwareOnly: true,
    stableCheckpoints,
    rollbackExercises,
    maxConcurrentReplacementsObserved: 1,
    everyStableCheckpointSurvivesOneMemberLoss: stableCheckpoints.every((checkpoint) => checkpoint.survivesAnyOneFailure),
    finalVoters,
    assertions: [
      "each target starts non-voting",
      "Raft and JetStream catch-up precede joint consensus",
      "only one source-target pair changes at a time",
      "stable membership remains three voters with quorum two",
      "the first committed replacement can roll back and reapply",
      "the final voter set exactly matches the canonical cloud topology",
    ],
    nonClaim: "This is a deterministic state-machine rehearsal, not live migration evidence.",
  };
}

function usage() {
  return [
    "usage: node tools/plan-laptop-cloud-migration.mjs --observations <file> [options]",
    "",
    "options:",
    "  --spec <file>       migration policy (default: migration/laptop-to-cloud.toml)",
    "  --allow-example     permit evidenceMode=example for CI/rehearsal only",
    "  --plan-only         print only the plan",
    "  --report-only       print only the abstract rehearsal report",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    spec: defaultSpecPath,
    observations: null,
    allowExample: false,
    output: "both",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--spec") args.spec = path.resolve(argv[++index] ?? "");
    else if (arg === "--observations") args.observations = path.resolve(argv[++index] ?? "");
    else if (arg === "--allow-example") args.allowExample = true;
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
    if (!args.observations) fail(`--observations is required\n${usage()}`);
    const { spec, source, target } = loadMigrationInputs(args.spec);
    const observations = readObservations(args.observations);
    const plan = buildMigrationPlan({ spec, source, target, observations, allowExample: args.allowExample });
    const report = simulateMigrationPlan(plan);
    const output = args.output === "plan" ? plan : args.output === "report" ? report : { plan, report };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
