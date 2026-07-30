# Raft durability, backup, and restore gate

Status: **PVC durability implemented; application-consistent backup/restore
blocked on service APIs**

This runbook is the storage gate for `fiducia-node` and `fiducia-brain`. It
separates the guarantees Kubernetes can provide today from the
consensus-aware backup and restore protocol that still needs application
support.

## Implemented storage contract

Every rendered production overlay must preserve all of these properties:

- `fiducia-node` and `fiducia-brain` use `StatefulSet` stable identities.
- `FIDUCIA_DATA_DIR` points at the `data` PVC mount, never an `emptyDir`.
- the `data` claim uses `ReadWriteOnce`, has an explicit provider storage
  class after overlay rendering, and requests non-zero capacity;
- `.spec.persistentVolumeClaimRetentionPolicy.whenDeleted` and
  `.whenScaled` are both `Retain`;
- Raft workloads use `updateStrategy: OnDelete`, so applying a template does
  not restart voting members automatically;
- the only `emptyDir` volumes on these workloads are bounded scratch paths
  such as `/tmp`.

`tools/durability.test.mjs` checks this contract in the base resources and in
every production overlay. The explicit retention policy requires Kubernetes
1.32 or newer, where the field is stable.

The application-level KV protection contract in `kv-protection.md` seals
values before they enter the Raft log or state-machine snapshot. Disk/provider
encryption is still required as defense in depth; it does not replace the
application keyring or its recovery procedure.

## Storage-class review

Before production apply, record this table in the deployment evidence for
each cluster:

| Field | Required decision |
|---|---|
| provisioner and `StorageClass` | provider CSI driver and exact class name |
| topology | volume must be attachable in the StatefulSet's scheduled zone |
| expansion | online expansion behavior and operator procedure |
| reclaim policy | backing PV must be `Retain`, or deletion must be prevented by an equivalent reviewed control |
| encryption | provider-managed encryption plus key ownership/rotation |
| performance | measured p95/p99 fsync latency and minimum IOPS/throughput |
| capacity | alert before 70%, page before 85%, stop maintenance before 90% |
| snapshots | CSI snapshot support, class, retention, and cross-account/project recovery destination |

The StatefulSet policy retains PVC objects. The backing `StorageClass` and PV
reclaim policy independently decide what happens after someone explicitly
deletes a PVC, so both layers need review.

## Migration from ephemeral members

Do not copy a live Raft directory and do not replace two voters at once.
Until dynamic membership and strict catch-up APIs exist, migration is an
operator-run maintenance operation:

1. Freeze unrelated rollout, scaling, and rebalance work.
2. Record all node and brain member IDs, roles, terms, commit/log indices,
   storage health, under-replicated shards, and leaderless shards.
3. Require healthy quorum in every Raft group and three healthy failure
   domains. Stop if any observation is incomplete.
4. Select exactly one non-leading member. If leadership cannot be transferred
   away through a supported service API, stop; Kubernetes readiness is not a
   substitute.
5. Create or verify its retained PVC and storage policy.
6. Replace only that member, keeping the same stable identity and attaching its
   PVC.
7. Wait for the service's strict catch-up signal on every hosted shard. Stop on
   storage failure, lag that is not converging, a version mismatch, or quorum
   loss.
8. Observe a stable bake window, then repeat for one additional member.

The current node uses fixed membership. That means a general empty-to-PVC
voter migration is not yet automatable; the missing learner/promote/remove and
leadership-transfer contracts are tracked in `operator-architecture.md`.

## Why a raw CSI snapshot is not a complete backup

A CSI `VolumeSnapshot` is crash-consistent for one volume. It does not create
one logical barrier across all shards or prove that the restored state
preserves revision/CAS behavior, authentication records, encryption key IDs,
and fencing-token high-water marks. A snapshot of one replica also is not a
manifest for the whole replicated system.

Therefore this repository deliberately does not ship a CronJob that copies
live PVC files or creates uncoordinated snapshots and calls them backups.
Automation stays blocked until the services expose an idempotent
application-coordinated export and restore validation API.

## Required backup artifact

The application export must contain a signed or authenticated manifest with:

- cluster and member generation;
- every shard ID;
- snapshot index and term per shard;
- committed revision/CAS state;
- checksums and byte sizes;
- Raft, API, command, and on-disk format versions;
- every required encryption-key ID;
- fencing-token high-water marks;
- creation time, operation ID, and maintenance-lock fencing token.

The encrypted payload and manifest go to an independent, versioned recovery
destination with retention, immutability, deletion controls, and separately
managed key custody. A backup is not successful until a separate verifier has
read it from that destination.

## Clean-room restore acceptance

Restore always targets an empty generation. It never overlays a running PVC
and never permits an older member or PVC to rejoin afterward.

1. Provision an isolated cluster and the exact required keyring.
2. Verify manifest authenticity, checksums, versions, and key availability
   before creating workloads.
3. Restore through the application API using an immutable operation ID.
4. Start the restored generation without connectivity to the old generation.
5. Verify representative values, revisions, CAS conflicts, auth key records,
   rotation/revocation state, and fencing-token monotonicity.
6. Exercise one member loss and replacement, then prove continued reads/writes
   and full catch-up.
7. Record the artifact ID, verifier result, timings, and rollback decision.

Production must not treat Fiducia KV as a recoverable secret authority until
this clean-room drill is automated and passes with independently retained
evidence.
