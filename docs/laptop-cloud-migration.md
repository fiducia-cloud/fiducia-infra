# Rolling migration from laptop K3s to real cloud clusters

Governing issue: `DEN-947`.

This procedure replaces the temporary laptop production substrate with the
canonical Hetzner, Vultr, and Civo topology without rewriting the applications or
performing a big-bang cutover.

The repository now has two provider-neutral profiles that share the same
`fiducia-prod` cluster identity, shard count, replication factor, and `base/`
workloads:

| Temporary member | Canonical replacement |
|---|---|
| `laptop-aws-sim` | `hetzner` |
| `laptop-gcp-sim` | `vultr` |
| `laptop-azure-sim` | `civo` |

The synthetic laptop provider labels are not claims that those machines run in
AWS, GCP, or Azure. The target providers may also change before execution; edit
the mapping only through a reviewed change to `migration/laptop-to-cloud.toml`.

## What the planner proves—and what it does not

`tools/plan-laptop-cloud-migration.mjs` validates the static policy, consumes a
fresh snapshot of live readiness/role evidence, creates a deterministic ordered
plan, and abstractly rehearses every stable membership transition.

The software rehearsal proves these invariants:

- one source-target pair changes at a time;
- each target starts as a learner/non-routing replica;
- Raft and JetStream catch-up precede voting membership change;
- a member replacement uses joint consensus rather than a direct delete/add;
- stable membership remains three voters with quorum two;
- every stable checkpoint tolerates loss of any one voter;
- a committed first replacement can roll back and be reapplied;
- the final voters exactly match the canonical cloud topology;
- laptop trust revocation and disk wipe happen only after the rollback soak.

It does **not** prove that a real cluster is healthy, that the runtime implements
the required membership APIs, that a snapshot can be restored, or that an ISP,
power, disk, or provider failure behaves as expected. Those remain live evidence
requirements in `DEN-945`, `DEN-946`, and `DEN-947`.

## Why this is not a six-voter static topology

Do not render all three laptops and all three cloud clusters as one permanent
six-voter Raft group. An even-sized stable voter set has worse quorum properties,
and applying a six-member static peer list would bypass runtime catch-up,
leadership, fencing, and membership-safety checks.

Each replacement follows:

```text
stable old config:       A B C       quorum 2
add target learner:      A B C + d   d is non-voting
catch up d:              A B C + d
joint consensus:         old=A B C, new=d B C
stable new config:       d B C       quorum 2
```

During joint consensus, a write must satisfy a majority of both the old and new
configurations. There is never a stable four- or six-voter configuration. The
runtime must provide a real joint-consensus or equivalent safe member-replacement
API. The planner refuses production evidence unless `dynamicMembershipApi` is
explicitly proven.

JetStream follows the same safety ordering: add a replica without routing public
consumers to it, wait for every critical stream and consumer acknowledgement
floor to catch up, prove database outbox/inbox replay and Fiducia fencing, then
replace the old member through the supported cluster reconfiguration path.

## Hybrid connectivity

The laptop topology uses WireGuard/Tailscale, while the final cloud topology may
use Cilium Cluster Mesh. Cluster Mesh alone cannot connect residential laptops
that are outside the target cloud Kubernetes network.

The migration therefore has a temporary **WireGuard bridge phase**:

1. give every target cloud cluster a private WireGuard/Tailscale identity;
2. establish private DNS for laptop and cloud Raft, NATS, health, telemetry, and
   backup endpoints;
3. verify authenticated TLS/mTLS over the bridge;
4. perform all member replacements and traffic canaries;
5. retain the bridge for the complete rollback window;
6. switch the target-only fleet to the canonical cloud connectivity only after
   no laptop carries membership, traffic, secret, or recovery dependencies.

Do not switch networking and Raft membership in the same unobserved operation.

## Static policy

`migration/laptop-to-cloud.toml` owns:

- source and target topology files;
- source-to-target mapping;
- one-at-a-time replacement limit;
- stable voter count and quorum assumptions;
- bridge connectivity;
- Raft and JetStream lag thresholds;
- catch-up stability interval;
- public traffic percentages;
- rollback soak duration;
- mandatory joint-consensus, backup, fencing, and outbox requirements.

The policy is intentionally conservative: zero known Raft-entry lag, zero known
JetStream-message lag, a five-minute stable catch-up window, and a minimum
24-hour rollback window. Change those only from measured production evidence.

## Live observations

The planner requires a separate JSON evidence file. Never commit a real evidence
file if it contains internal addresses, backup identifiers, customer metadata,
credentials, or security-sensitive topology details.

Required observations include:

- exact 40-character deployment and rollback Git revisions;
- observation timestamp no more than ten minutes old;
- current Fiducia and JetStream leaders;
- exact healthy source voter/member sets;
- at least two independent external probe regions;
- bridge network, DNS, mTLS, secret bootstrap, backup, telemetry, storage,
  database, object-storage, fencing, outbox, dynamic membership, JetStream
  reconfiguration, membership-lock, and external-health gates;
- concrete Fiducia, database, JetStream, object-store, and recovery-key proof
  identifiers;
- Kubernetes, GitOps, storage, mesh, TLS, telemetry, and backup readiness for
  every target cluster.

A sanitized shape is committed as
`migration/rehearsal-observations.example.json`. It is marked
`evidenceMode: example`. The production command refuses it unless the operator
passes `--allow-example`, and live evidence rejects proof IDs beginning with
`example-`.

Example rehearsal:

```sh
node tools/plan-laptop-cloud-migration.mjs \
  --observations migration/rehearsal-observations.example.json \
  --allow-example \
  > /tmp/laptop-cloud-rehearsal.json
```

Live planning:

```sh
node tools/plan-laptop-cloud-migration.mjs \
  --observations /secure/evidence/fiducia-migration-observations.json \
  > /secure/evidence/fiducia-migration-plan.json
```

The output contains both the ordered plan and the deterministic abstract
rehearsal report. Use `--plan-only` or `--report-only` where appropriate.

## Global stop gate

Before every replacement—not just once at the beginning—revalidate:

- all current stable voters and JetStream members are healthy;
- backup and recovery-key proofs are still retrievable;
- the target and source can communicate over private authenticated paths;
- PostgreSQL/Supabase and object storage are reachable from the target;
- fencing, idempotency, and outbox replay tests pass;
- the membership-change lease is exclusively held;
- no other rollout, backup restore, key rotation, or membership change is active;
- external probes see the current production origins as healthy.

Stop immediately if any required gate becomes false. Never continue merely
because a previous replacement succeeded.

## Replacement procedure

The planner orders sources that are not current leaders first. The observed
Fiducia leader is last. A source that leads JetStream traffic gets an explicit
leadership-transfer action before joint consensus. Live roles must be reobserved
because leadership may move between planning and execution.

For each source-target pair:

1. **Acquire the membership-change lease.** The lease is global to the
   production cluster and must carry fencing so a stale operator cannot resume.
2. **Revalidate evidence.** Abort on stale roles, missing backups, unhealthy
   members, network loss, or a failed external probe.
3. **Provision the target at zero traffic.** Bootstrap networking, trust,
   secrets, storage, telemetry, backups, and cluster-local Argo CD. Pin the exact
   reviewed revision through the `DEN-944` workflow.
4. **Add the target as a Fiducia learner.** Stable voters remain unchanged.
5. **Wait for Raft catch-up.** Require the configured lag threshold, matching
   snapshot/committed-index evidence, and a continuous stable interval.
6. **Add the target as a JetStream replica.** Do not route public consumers.
7. **Wait for messaging catch-up.** Verify every critical stream, consumer
   acknowledgement floor, redelivery state, DLQ, and outbox/inbox replay.
8. **Prove fencing and idempotency.** Exercise a protected mutation through the
   target without permitting duplicate external effects.
9. **Transfer leadership where required.** Reobserve after transfer.
10. **Execute joint-consensus replacement.** Replace exactly the source with the
    caught-up target. Require old and new majorities.
11. **Verify stable membership.** Exactly three voters, quorum two, no pending
    learner, healthy replication, and one-member failure tolerance.
12. **Canary stateless traffic.** Progress through 1%, 10%, 25%, 50%, and 100%,
    requiring external health, authentication/session continuity, error, latency,
    and protected-mutation checks at every step.
13. **Start the rollback window.** Keep the source identity, disk, encrypted
    state, network route, and operator access intact but out of normal traffic.
14. **Release the membership lease.** Only after the stable checkpoint and
    evidence are recorded.

Do not start the next replacement while the preceding member is catching up,
inside joint consensus, unhealthy, or awaiting an unresolved rollback decision.

## Rollback

### Before joint consensus

The old voter remains authoritative. Remove the target JetStream replica and
Fiducia learner, restore source traffic, preserve evidence, and release the
membership lease. No voter replacement is necessary.

### After joint consensus

Do not simply restart the old disk and declare it a voter; it may be stale.

1. re-add the old source as a learner and non-routing JetStream replica;
2. catch it up from the current authoritative configuration;
3. verify snapshots, indexes, streams, acknowledgement floors, fencing, and
   replay;
4. transfer leadership away from the target if necessary;
5. joint-consensus replace the target with the source;
6. verify the restored three-voter configuration;
7. restore source traffic gradually;
8. preserve the failed target for investigation without allowing it to rejoin
   under a stale identity.

The abstract rehearsal executes this post-commit rollback for the first mapping,
proves the original stable voter set is restored, and then reapplies the forward
replacement so the rest of the plan can continue.

## Traffic migration

Traffic movement is independent of voting membership. A target can be a healthy
voter while still receiving zero customer traffic, and a retained laptop can be
available for rollback without voting.

At each percentage gate check:

- external availability from at least two independent regions;
- p50/p95/p99 latency and error rate;
- auth, token, and session portability;
- database and object-store access;
- protected external mutation deduplication;
- NATS redelivery, consumer lag, and DLQ depth;
- Fiducia election churn, voter lag, snapshot age, and fencing-token validity;
- target CPU, memory, storage, I/O, and network headroom.

Rollback traffic before changing membership when only the stateless path is
unhealthy.

## Fleet cutover and laptop retirement

After all three targets are stable voters and serve normal traffic:

1. run the full rollback soak while keeping laptop recovery capacity;
2. repeat backup/restore and one-target-failure checks;
3. prove no secret, DNS, tunnel, traffic, database, object-store, telemetry, or
   operator workflow depends on a laptop;
4. switch target-only networking from the temporary WireGuard bridge to the
   canonical target connectivity, if desired;
5. revoke laptop Tailscale/WireGuard, SSH, Git/registry, TLS/mTLS, SOPS/age,
   Cloudflare, runtime-secret, Fiducia, and JetStream identities;
6. remove old DNS, health checks, GitOps roots, backup jobs, and incident routes;
7. preserve only approved encrypted backups and audit evidence;
8. securely wipe the retired disks and record the wipe result.

A powered-off laptop with valid credentials is not retired. Identity revocation
must precede disk disposal.

## CI and review contract

The repository test suite proves:

- both profiles share `fiducia-prod`, shard count, replication factor, and the
  provider-neutral `base/` manifests;
- every source and target is mapped exactly once;
- parallel member replacement, identity drift, missing gates, stale evidence,
  and example evidence fail closed;
- leader-aware ordering is deterministic;
- learner, catch-up, fencing/replay, joint consensus, and stable verification are
  correctly sequenced;
- every stable checkpoint retains 2-of-3 quorum and survives one member loss;
- post-commit rollback restores the old voters before forward progress resumes;
- retirement and secure wipe remain the final operations;
- identical policy and observations produce byte-for-byte identical JSON.

The CI rehearsal is necessary evidence about the state-machine contract, but it
must never be cited as proof that a live laptop-to-cloud migration occurred.
