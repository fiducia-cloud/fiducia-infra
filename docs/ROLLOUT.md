# Production rollout / upgrade runbook

How to ship new code to fiducia.cloud without dropping client requests or losing
quorum. The data plane is **sharded multi-Raft**, so an upgrade is not a simple
"replace the pods" — each node leads some shards and follows others, and a node
must be **drained of leadership** before it stops.

> Status: this runbook describes the target procedure. Some primitives it relies
> on are still `TODO` in the code (called out under **Required primitives**); the
> data-plane roll should be gated on those landing. The stateless tiers (edge,
> load-balance, backend) can already roll today.

## Invariants (never violate)

1. **Quorum is never lost** — per shard (2 of 3 replicas) and for the brain
   (2 of 3 members).
2. **No write outage** — a shard is never left without a leader; writes either
   commit or get a `421` redirect to the live leader, never a hard failure.
3. **One leader per shard, replication factor preserved** — no split brain, no
   silent under-replication.
4. **At most one cluster in flight** — finish and verify one cluster before
   touching the next, so the cross-cluster 2/3 majority always holds.

## Why the topology makes this safe

- **RF = 3, one replica per cluster.** A shard's three Raft members live in
  GCP, AWS and Hetzner. Taking one node (or one whole cluster) down leaves 2/3 →
  majority → still serving.
- **Brain = 3-member Raft, one member per cluster.** Same 2/3 property for the
  control plane.
- **The load balancer is a stateless cache.** It refreshes `shard → leader` from
  `fiducia-brain` `GET /v1/placement` (~5s) and self-corrects on a node's
  `421 Misdirected Request` + `x-fiducia-leader` redirect. So leadership moving
  is just a cache update + at most one redirect — nothing to migrate.

## Required primitives (gate the data-plane roll on these)

| Primitive | Where | Today |
|-----------|-------|-------|
| Leadership transfer (Raft TimeoutNow) to a named in-sync follower | `fiducia-node` | TODO (`consensus.rs`) |
| Local **drain/cordon**: shed all leaderships + report `/readyz` = false | `fiducia-node` | TODO |
| Per-shard `role` + `commit_index` + `last_log_index` | `fiducia-node` `/v1/status` | ✅ exists |
| `NotLeader` → `421` + `x-fiducia-leader` redirect | `fiducia-node` | ✅ exists |
| Mark node **Draining** (suppress Dead → re-placement) | `fiducia-brain` `membership.drain` / `DELETE /v1/nodes/{id}` | TODO (stub) |
| Placement refresh skips Draining nodes | `fiducia-load-balance` `table.refresh_from_brain` | TODO (stub) |
| Readiness = "caught up", not "process up" | `fiducia-node` `/readyz` | needs catch-up gate |

## Version compatibility (do before any rollout)

The cluster is **mixed-version** during the roll, so N and N+1 must interoperate:

- **Raft peer RPC** wire format, **HTTP API**, and **on-disk log/snapshot**
  format must be backward/forward compatible across one release step.
- Use **expand/contract** (two-phase) for any format change — add the new
  field/format in N (read both, write old), switch to writing new in N+1, drop
  old in N+2. Never a breaking change in a single release.
- **Feature-flag** new behaviors; enable only after every node is on N+1.

## Pre-flight checklist

- [ ] All shards **3/3 in-sync**, zero under-replicated (`/v1/placement`).
- [ ] Brain **3/3 healthy** with a stable leader.
- [ ] No in-progress rebalance / scale change.
- [ ] New image built, signed, and smoke-tested in staging; **previous image tag
      recorded for rollback**.
- [ ] PodDisruptionBudget present (`maxUnavailable: 1` per cluster).
- [ ] Canary partition ready (StatefulSet `updateStrategy.rollingUpdate.partition`).

## Order of operations (top level)

1. **Shared libs** (`routing` / `telemetry` / `interfaces`): publish new tags.
   They compile *into* service images — no runtime rollout. `routing` is
   especially sensitive: the `key → shard` hash is frozen; a change is a data
   migration, not a deploy.
2. **Stateless tiers (safest, do first):**
   - `fiducia-backend` (marketing) — plain rolling update.
   - `fiducia-edge` (CF Worker) — `wrangler deploy` is atomic; its region
     failover covers a momentary regional blip.
   - `fiducia-load-balance` (Deployment) — `maxSurge: 1, maxUnavailable: 0`
     (zero-downtime; surge a new pod before retiring an old one).
3. **Control plane:** `fiducia-brain`, one member per cluster, one at a time,
   leadership-transfer first.
4. **Data plane:** `fiducia-node`, per cluster, per node, leadership-drain
   rolling — the careful part, below.
5. **`fiducia-admin` / `fiducia-auth`** — rolling update (once `auth` is
   Postgres-backed it is stateless; the in-memory keystore skeleton is not, so
   don't run >1 replica of skeleton auth).

## The core procedure: data-plane node upgrade (per node)

For each node, in ascending pod ordinal, **one at a time**:

1. **Cordon at the brain** — `DELETE /v1/nodes/{id}` (drain): health → `Draining`.
   The brain stops picking it as `preferred_leader` and **will not declare it
   Dead / re-replicate** while it's draining.
2. **Transfer leadership away** — for every shard where `/v1/status` shows
   `role: leader`, trigger leadership transfer to an in-sync follower (in another
   cluster). Confirm `leading_shards: []` on `/v1/status`.
3. **Take it out of the LB** — placement refresh now routes elsewhere; any
   straggler write gets `421` → re-routed. Optionally flip `/readyz` false to
   drop it from the Service endpoints immediately.
4. **Drain in-flight** — `preStop` hook waits `≥ (LB refresh interval ~5s + max
   long-poll/watch window)` so open long-poll lock-acquires and KV watches
   finish or fail over. Set `terminationGracePeriodSeconds ≥ preStop + slack`.
5. **Replace the pod** with the new image (StatefulSet `RollingUpdate`, ordered).
6. **Rejoin** — the new pod rejoins each shard's Raft group as a follower and
   replays log / installs snapshot until caught up.
7. **Catch-up gate** — `/readyz` goes green only when, for **every** hosted
   shard, it is a voting member with `commit_index == last_log_index`. k8s won't
   proceed to the next pod until this node is Ready.
8. **Un-cordon** — clear `Draining`; allow it to take leadership again. Optional:
   rebalance to restore preferred leaders.

After all nodes in the cluster are on N+1 and shards are **3/3 again**, move to
the next cluster.

```
per node:  brain drain → transfer leaderships → LB off → preStop drain
           → replace → catch up (commit==last_log) → /readyz → un-cordon
```

## Brain upgrade (per member, one per cluster)

1. If the target is the brain **leader**, transfer brain leadership first.
2. Upgrade the member (each cluster runs `replicas: 1`, so this is one pod per
   cluster — go cluster by cluster).
3. Verify **3/3 brain quorum + stable leader** before the next cluster.

## k8s mechanics (where these settings live)

- **StatefulSet `updateStrategy: RollingUpdate`** with `partition` for canary:
  set `partition = replicas - 1`, upgrade the top ordinal, bake, then lower the
  partition to roll the rest.
- **PodDisruptionBudget** `maxUnavailable: 1` (only one node down per cluster).
- **`preStop` hook** → local drain (cordon + leadership transfer), then sleep;
  **`terminationGracePeriodSeconds`** ≥ preStop + in-flight window.
- **`readinessProbe` → `/readyz`** (caught-up gate) and **`livenessProbe` →
  `/healthz`** (process up) — keep them distinct so a catching-up node is "not
  ready" but not killed.
- **LB Deployment**: `maxSurge: 1, maxUnavailable: 0`.

## Failure detection vs planned downtime (do not skip)

The brain's sweep demotes silent nodes `Healthy → Suspect → Dead` and
**re-replicates Dead nodes' shards**. A rolling restart must never trigger that
churn. Guarantee one of:

- **(preferred) Cordon suppresses it** — a `Draining` node is excluded from the
  Dead transition and from re-placement; **or**
- **Timeout headroom** — `suspect`/`dead` timeouts exceed worst-case
  pod-restart + catch-up time.

Verify which mechanism is active before rolling. Prefer the explicit cordon.

## Canary & rollback

- **Canary:** upgrade one node (top ordinal) in one cluster; bake for T minutes
  watching the signals below.
- **Abort if:** any shard drops below quorum, election storm, readiness
  flapping, or write-latency / error-rate regression past threshold.
- **Rollback:** because N/N+1 interoperate, set the image back to N (raise the
  StatefulSet `partition` / revert the tag). If you followed expand/contract
  there is no data migration to undo.

## Watch during the roll (sidecar → Prometheus / Tempo / Loki)

- per-shard **leader-change / election count** — ~0 except the intended transfers
- **under-replicated shard count** — must return to 0 before proceeding
- **write errors** — `421` retries are fine; `503 no_leader` is not
- **catch-up lag** — `last_log_index − commit_index` trending to 0
- **brain quorum + leader stability**

## Related

- Architecture diagram: `fiducia-backend` `/docs/diagram` (section 4 shows this flow).
- Zero-downtime Deployment strategy: `maxSurge: 1 / maxUnavailable: 0`.
