# Fiducia Raft durability, backup, migration, and clean restore

Governing issue: `DEN-437`.

The authoritative Fiducia node and brain Raft state already uses retained StatefulSet PVCs. This runbook defines the remaining safety contract: storage qualification, one-voter-at-a-time migration, application-consistent encrypted backup, historical key custody, clean-room restore, alerts, evidence, and rollback.

The repository policy and example evidence do not claim that a backup or restore has occurred. Live evidence must be captured independently and reviewed.

## Authoritative storage contract

| Workload | Data directory | Minimum PVC | Access | Retention |
|---|---|---:|---|---|
| `fiducia-node` | `/var/lib/fiducia` | 10 GiB | `ReadWriteOnce` | `Retain` on delete and scale |
| `fiducia-brain` | `/var/lib/fiducia-brain` | 2 GiB | `ReadWriteOnce` | `Retain` on delete and scale |

Both StatefulSets use `OnDelete` updates. Kubernetes is not permitted to roll multiple cross-cluster voters automatically.

The `data` volume must be a `volumeClaimTemplate`. An `emptyDir` named `data`, a writable container root filesystem, or an unmounted `FIDUCIA_DATA_DIR` is a release-blocking regression.

## StorageClass qualification

For provider-backed production storage, record:

- CSI provisioner and exact StorageClass name;
- encryption at rest and key ownership;
- `ReadWriteOnce` support;
- volume expansion support;
- binding mode and topology/failure-domain behavior;
- reclaim/deletion behavior;
- minimum capacity and measured p99 write latency;
- node-replacement behavior;
- backup/snapshot integration;
- PVC Pending/Lost and capacity alerts.

The initial engineering thresholds are warning at 70% usage, critical at 85%, and sustained p99 storage write latency no worse than 25 ms.

### Laptop `local-path` exception

The temporary laptop profile uses `local-path`. The laptop root disk must be LUKS2-encrypted, but local-path does **not** survive loss of the laptop or its disk. Evidence must state `nodeReplacementDurable: false`; it may qualify only as `temporary-laptop`, never `durable-provider`.

The laptop durability claim therefore depends on:

- two surviving voters for quorum/catch-up;
- application-consistent encrypted off-host backups;
- complete historical encryption-key custody;
- a tested clean replacement restore.

Do not describe a retained local PVC as independent node-loss durability.

## Pre-migration gates

Before changing a voter:

1. Record Git/image revisions, member IDs, current leaders, commit/applied indexes, revisions, healthy-voter count, PVC inventory, active encryption key ID, and every historical key ID needed by live state or backups.
2. Verify three healthy voters and zero known member lag.
3. Verify the target StorageClass and capacity/encryption/topology behavior.
4. Create and verify a current application-consistent encrypted backup in an independent destination.
5. Confirm rollback operator, restore approver, and key-custody approver are available.
6. Freeze unrelated stateful rollouts, restores, membership changes, and key retirement.

Stop on quorum loss, member divergence, leader churn, missing backup, missing key ID, failed PVC binding, failed readiness, or storage latency outside the policy.

## One-voter-at-a-time migration

Migrate exactly one member at a time, starting with a follower and normally the highest ordinal.

For each member:

1. Verify the other two voters are healthy and caught up.
2. Transfer leadership away or wait until the target is a follower.
3. Remove the cluster from public traffic where applicable.
4. Change only the selected member.
5. Retain the previous PVC and every backup/WAL artifact.
6. Use an application-supported snapshot/restore or learner catch-up path. Do not copy a live, mutating Raft directory with an ordinary filesystem copy.
7. Verify identity, membership, commit/applied index convergence, zero final lag, readiness, representative reads, successful CAS, rejected stale CAS, auth records, revocations, rotation state, and encryption key IDs.
8. Observe a stability window and record the rollback point.
9. Continue only after the member is fully healthy.

Changing a second voter while the first is unhealthy or catching up is prohibited.

## Backup contract

The node/brain implementation must expose or document an application-consistent snapshot and, where supported, incremental/WAL procedure. A filesystem copy of a live Raft store is not accepted unless the storage engine explicitly guarantees consistency.

Every backup record must contain:

- cluster ID;
- exact three-member set;
- applied index and logical revision;
- schema version;
- creation time;
- SHA-256 checksum;
- active encryption key ID;
- complete set of historical key IDs required for decryption;
- opaque external artifact ID.

Every backup must be:

- encrypted before leaving the node or by the approved storage backend;
- independent of live PVC lifecycle and the failed laptop/site;
- immutable or object-locked for its retention window;
- checksum-verified;
- written with least-privilege credentials;
- restorable only through separately authorized credentials;
- monitored for age, failure, size anomaly, checksum failure, and missing key IDs;
- deleted only through documented dual approval.

Initial policy:

- snapshot interval no greater than one hour for critical RPO;
- backup age no greater than 26 hours;
- 35 daily restore points;
- 12 monthly restore points;
- 4 quarterly restore points.

Measured live RPO/RTO may tighten these targets. Do not relax them merely to validate an evidence file.

## Encryption-key custody

The active key ID must be present in the required key set. Every backup and restore manifest must list the exact same required historical key IDs.

Do not retire a key because it is no longer active. Retire it only after:

1. no live value requires it;
2. every retained backup that references it has expired or been re-encrypted through an approved process;
3. a missing-key restore test fails closed;
4. the full-key restore succeeds;
5. deletion receives documented approval.

Evidence records key **IDs**, never key values.

## Clean-room restore

Production reliance on Fiducia as a secret authority requires an independent restore:

1. Create an isolated cluster with new PVCs and no access to the live data directory.
2. Provide only the selected encrypted backups, manifests/checksums, and approved keyring.
3. Restore through the application-supported procedure.
4. Start a valid quorum and verify member/cluster identity rules.
5. Compare representative values without emitting them.
6. Prove revisions, successful CAS, rejected stale CAS, auth-key records, token revocations, rotation state, and encryption key IDs.
7. Measure RPO and RTO.
8. Revoke restore credentials after the drill.
9. Preserve redacted output, fingerprints, timings, failures, and reviewer approval.

Policy limits are one-hour critical RPO and eight-hour clean restore RTO. A restore older than 90 days triggers an alert and must be repeated.

## Required disaster scenarios

- `single-member-loss`: one voter is lost while the surviving quorum serves tested reads/writes.
- `single-member-replacement`: a clean member joins/catches up within two hours without changing a second voter.
- `interrupted-migration-rollback`: the previous member/PVC/revision is restored without touching another voter.
- `clean-room-restore`: representative semantics and complete keyring are proven in isolation.
- `missing-historical-key-fails-closed`: restore fails when one required key ID is unavailable, then succeeds with the complete key set.

All scenarios require quorum preservation and opaque proof identifiers.

## Read-only storage capture

```sh
scripts/capture-fiducia-raft-storage-evidence.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --output /secure/evidence/laptop-aws-sim-raft-storage.json
```

The script captures only selected StatefulSet, PVC, StorageClass, pod readiness, image ID, data-directory, volume-mount, retention, and capacity metadata. It omits Secret/ConfigMap values, PV identifiers, node names/addresses, and general environment variables.

It performs no snapshot, apply, patch, delete, scale, rollout, drain, restore, or member change. Its output is explicitly `captureOnly: true`, `productionApproval: false`, and lists the evidence gates it cannot satisfy.

## Evidence validator

Example rehearsal:

```sh
node tools/validate-fiducia-raft-durability-evidence.mjs \
  --evidence durability/fiducia-raft-evidence.example.json \
  --allow-example \
  --now 2026-08-03T20:30:00Z
```

Live validation:

```sh
node tools/validate-fiducia-raft-durability-evidence.mjs \
  --evidence /secure/evidence/fiducia-raft-live.json
```

The validator rejects:

- example evidence without an explicit non-production flag;
- stale live observations/backups/restore tests;
- mutable Git revisions;
- incomplete cluster/workload coverage;
- `emptyDir` or unbound/undersized/unretained/unencrypted storage claims;
- local-path described as node-replacement durable;
- slow storage, final member lag, weak retention, missing checksum, non-independent or mutable backup;
- incomplete historical key sets;
- missing restore semantics or disaster scenarios;
- RPO/RTO violations;
- self-approval, unresolved critical findings, secret-bearing fields, credential patterns, or placeholder live proof IDs.

A valid example report is `example-only`. Live local-path evidence can be `eligible-temporary-laptop-with-restore-dependency`; provider storage can be `eligible-durable-provider` only when it is encrypted, expandable, and survives node replacement.

## Alerts

`base/observability/raft-durability-prometheus-rules.yaml` covers:

- PVC Pending/Lost;
- 70% and 85% PVC usage;
- storage p99 write latency;
- member lag;
- application snapshot age;
- independent backup age/failure;
- missing required key IDs;
- restore-test age.

Metric labels must remain bounded by workload, cluster, result, and failure class. Never label by KV key, tenant, member UUID, backup URL, key ID, token, or customer value.

## Rollback

On failed migration or replacement:

- stop the replacement before unintended membership forms;
- retain old/new PVCs, snapshots, WAL, and key IDs;
- restore the exact prior revision or reattach the last known-good volume only through the member-identity procedure;
- verify surviving quorum and indexes before traffic resumes;
- do not delete storage or a key as an emergency shortcut;
- treat any rollback requiring a second voter change as an incident.

## Completion gate

DEN-437 remains In Progress until live evidence proves storage qualification, application-consistent encrypted backups, all key IDs, one-member loss/replacement, interrupted rollback, clean-room restore, revision/CAS/auth/revocation/rotation semantics, measured RPO/RTO, and actionable alerts.
