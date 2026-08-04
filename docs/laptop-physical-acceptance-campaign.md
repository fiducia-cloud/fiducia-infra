# DEN-946 physical acceptance campaign

Governing issue: `DEN-946`.

This campaign is the final evidence gate for the temporary three-laptop Fiducia
production substrate. It converts the acceptance requirements into one ordered,
versioned scenario matrix, a redacted checkpoint format, strict evidence
validation, and an explicit launch classification.

The software in this directory **does not inject faults**. Power loss, network
partition, device revocation, storage failure, clock/thermal tests, restores, and
member replacement remain deliberate operator actions under a reviewed runbook.
The capture script records before/fault/recovered checkpoints and hashes the
artifacts; it cannot make a physical test safe merely by being present.

## Files

```text
acceptance/laptop-fleet/campaign.json
  Static scenario order, target scope, alert/restore/quorum requirements,
  allowed RTO/RPO, soak duration, and launch thresholds.

acceptance/laptop-fleet/evidence.example.json
  Synthetic example showing the complete evidence shape. It is never production
  proof and is accepted only with --allow-example.

tools/laptop-acceptance.mjs
  Deterministic planner plus strict example/live evidence validator.

tools/laptop-acceptance.test.mjs
  Positive and negative contracts for ordering, safety, evidence, launch class,
  credentials, soak, failure domains, artifacts, RTO/RPO, and capture behavior.

scripts/capture-laptop-acceptance-checkpoint.sh
  Read-only, context-bound checkpoint capture. It reads no Secret or ConfigMap
  values and performs no fault, recovery, rollout, or host mutation.
```

## Acceptance invariants

The campaign fails closed unless all of these remain true:

1. All 28 reviewed scenarios are present exactly once and run in their declared
   order.
2. Fault and recovery operations remain manual. The repository contains no
   unattended destructive chaos job for the physical laptops.
3. The follower power-loss scenario precedes leader power-loss scenarios.
4. Lost-device revocation precedes replacement-member admission.
5. Exactly one scenario is active at a time. No second member is restarted,
   replaced, restored, or upgraded while the current scenario is unresolved.
6. Every required restore ends with a clean, independently verified recovery—not
   merely a successful backup upload.
7. Acknowledged critical-message loss, duplicate protected mutations, final
   replication lag, and unresolved critical/high findings remain zero.
8. Every scenario-specific RTO/RPO is inside its declared limit.
9. The seven-day soak is the final scenario and contains at least eight
   checkpoints: start, daily coverage, and completion.
10. Example evidence can never be accepted as live evidence.
11. A `limited-production` decision requires three distinct site, ISP, and power
    domain fingerprints plus at least two external probe regions.
12. Laptop identity revocation and disk retirement are not inferred from a host
    being powered off; every trust system must be explicitly covered.

## Scenario matrix

### Backup and clean-room recovery

| Order | Scenario | Required result |
|---:|---|---|
| 1 | `k3s-clean-restore` | Rebuild a clean cluster from versioned host/K3s configuration and an off-host embedded-etcd snapshot within the declared RTO/RPO. |
| 2 | `fiducia-raft-clean-restore` | Restore representative Fiducia Raft state, revisions/CAS behavior, key IDs, and fencing semantics with RPO zero for committed coordination state. |
| 3 | `managed-database-restore` | Restore the managed database through PITR or an encrypted logical backup and validate representative workflow/idempotency rows without exposing customer values. |
| 4 | `jetstream-outbox-replay` | Restore or recreate critical JetStream state and replay from PostgreSQL outbox/inbox with stable message IDs, zero acknowledged-message loss, and zero duplicate protected effects. |

### Physical, network, and service failures

| Order | Scenario | Required result |
|---:|---|---|
| 5 | `follower-laptop-power-loss` | Quorum and healthy public origins persist after deliberate loss of a non-leader site. |
| 6 | `fiducia-leader-power-loss` | Fiducia elects safely; stale authority is fenced; protected effects are not duplicated. |
| 7 | `jetstream-stream-leader-loss` | The critical stream elects a leader and preserves acknowledged state and consumer progress. |
| 8 | `jetstream-meta-leader-loss` | JetStream metadata leadership recovers without unsafe membership or stream drift. |
| 9 | `primary-wan-loss` | Traffic leaves the failed origin; the backup WAN path works where available; quorum remains safe. |
| 10 | `asymmetric-mesh-partition` | A one-way path failure cannot produce dual authority or an unsafe stale member. |
| 11 | `cloudflared-connector-loss` | External traffic remains available through healthy connectors without manual DNS edits. |
| 12 | `k3s-api-loss` | Running workloads continue where expected; the control plane recovers within its RTO. |
| 13 | `disk-mount-loss` | The affected member fails closed; no empty replacement state is mistaken for authoritative data; recovery is proven. |
| 14 | `fiducia-member-stop` | One member loss preserves the 2-of-3 coordination quorum. |
| 15 | `jetstream-member-stop` | One messaging member loss preserves RF=3 critical delivery semantics and safe degraded operation. |
| 16 | `telemetry-path-loss` | External and local alert paths identify the blind spot and recover without hiding the incident. |

### Resource and delivery failures

| Order | Scenario | Required result |
|---:|---|---|
| 17 | `disk-pressure` | Alerts fire before exhaustion; the node sheds or stops work safely; snapshots and authoritative state remain intact. |
| 18 | `high-io-latency` | Election/catch-up behavior remains bounded and the member is removed from traffic when unhealthy. |
| 19 | `bounded-clock-drift` | Drift alerts fire and no stale lease/fence becomes authoritative. Never exceed the reviewed safe injection bound. |
| 20 | `bounded-thermal-pressure` | Thermal alerts and throttling are visible; workloads recover without hardware damage. This is a bounded observation, not an instruction to defeat firmware protection. |
| 21 | `failed-image-pull` | The old healthy revision remains available; promotion halts and rollback evidence is recorded. |
| 22 | `interrupted-upgrade` | A follower-first upgrade interruption is recovered before any second member changes; persisted state remains compatible. |

### Security and replacement

| Order | Scenario | Required result |
|---:|---|---|
| 23 | `lost-device-revocation` | Revoke the simulated lost laptop from Tailscale/WireGuard, SSH, Git/registry, TLS/mTLS, SOPS/age, Cloudflare, runtime secret access, Fiducia, and JetStream. Attempts from the revoked identity fail. |
| 24 | `replacement-laptop-rejoin` | A clean replacement receives a new identity, restores/catches up, and joins without restarting or replacing a second voter. |
| 25 | `public-port-exposure-scan` | Independent scans find no public SSH, Kubernetes, Raft, NATS client/route/monitoring, database, NodePort, or internal admin exposure. |
| 26 | `alert-routing-matrix` | Every required alert reaches the intended actionable destination with cluster, symptom, severity, and runbook context. |
| 27 | `follower-first-maintenance-rollback` | A real maintenance and rollback cycle updates one follower at a time and handles the leader last. |

### Soak

| Order | Scenario | Required result |
|---:|---|---|
| 28 | `seven-day-soak` | At least 168 continuous hours of representative low-volume traffic, backups, telemetry, and bounded fault exercises, with no unresolved critical/high finding, acknowledged loss, duplicate protected effect, or final replication lag. |

## Campaign preparation

Before the first scenario, record and freeze:

- exact 40-character deployment and rollback Git revisions;
- current Fiducia and JetStream leaders and all member IDs;
- three site, ISP, and power-domain fingerprints;
- the two or more external probe regions;
- customer/tenant test data boundaries;
- the approved recovery-key custodian;
- the backup catalog and most recent verified restore artifacts;
- the incident channel and rollback authority;
- the current alert routing matrix;
- the change freeze covering all unrelated stateful rollouts.

A fingerprint is a one-way identifier for the domain, not the address, account
number, Wi-Fi name, or other sensitive value. Do not place private addresses,
customer data, credentials, certificate private keys, recovery keys, or secret
values in Git, Linear, or ordinary CI artifacts.

## Per-scenario procedure

Every scenario except the soak uses three checkpoints.

### 1. Before

1. Confirm no other acceptance scenario, member replacement, backup restore, key
   rotation, or stateful rollout is active.
2. Verify three healthy Fiducia voters and three healthy JetStream members.
3. Record current Fiducia, stream, and metadata leaders.
4. Verify external probes, Cloudflare connectors, database, object storage,
   backups, and alert routing.
5. Capture the `before` checkpoint from every materially involved cluster.
6. Review the artifact manifest and preserve it in the approved evidence store.

### 2. Fault

1. The named operator performs only the reviewed manual action.
2. Do not combine failures. For example, do not pull power and sever the WAN in
   the same scenario unless a separate combined-failure scenario is approved.
3. Capture the `fault` checkpoint from every reachable involved cluster.
4. Record the exact start time, observed role, external symptoms, alert IDs,
   message/fencing behavior, and operator intervention.
5. Abort immediately if the stop conditions below occur.

### 3. Recovered

1. Follow the scenario-specific recovery procedure.
2. Do not admit a stale member merely because its process is running.
3. Require state catch-up, current membership, zero final lag, healthy public
   origins, and restored alerts.
4. Capture the `recovered` checkpoint.
5. Calculate RTO/RPO and compare them with `campaign.json`.
6. Link immutable artifacts by SHA-256 in the live evidence file.
7. Close the scenario before beginning another one.

The checkpoint command shape is:

```sh
scripts/capture-laptop-acceptance-checkpoint.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --scenario follower-laptop-power-loss \
  --phase before \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --output-dir /secure/evidence/den-946
```

Repeat for `fault` and `recovered`, and for every involved cluster. For the soak,
use `start`, `daily`, and `complete`.

## What the capture script records

The script verifies that the kube context contains exactly one node labeled for
the requested laptop cluster and substrate. It writes mode-0600, sorted JSON or
text for:

- selected node identity, readiness, capacity, runtime, and version status;
- pod phases, readiness, restart counts, state, and image IDs;
- Deployment, StatefulSet, and DaemonSet replica/update status;
- PVC phase, requested/capacity storage, and storage class;
- Service type and port surface without ClusterIP or load-balancer addresses;
- NetworkPolicy names, policy types, and rule counts;
- Argo CD repository path, exact revision, sync, and health status;
- K3s `ETCDSnapshotFile` readiness, size, time, and storage class without token
  hashes or S3 locations;
- Kubernetes `/readyz?verbose`;
- checkpoint metadata and a SHA-256 artifact manifest.

It deliberately does **not** read Secrets, ConfigMap data, workload environment
variables or command arguments, Kubernetes event messages, kubeconfig contents,
private keys, tokens, credentials, recovery material, customer values, or
database rows.

It does not run `kubectl apply`, patch, delete, scale, rollout, cordon, drain,
restart, host power, network shaping, disk-filling, clock-changing, or device
revocation commands.

## Backup and restore evidence

A backup path passes only after a clean-room restore. Each restore artifact must
identify, without secret values:

- source backup/snapshot proof;
- checksum and encryption/key-custody proof;
- exact target cluster and new member identity;
- exact software revision;
- start, service restoration, catch-up, and completion times;
- restored key IDs, revisions, CAS behavior, account/session/auth state, stream
  and consumer positions, and representative workflow identifiers;
- RTO/RPO;
- external health and alert behavior;
- cleanup/rollback decision.

The database and outbox/inbox remain the replay authority for protected
workflows. JetStream snapshots are supplementary recovery material, not a reason
to bypass fencing or durable idempotency.

## Device revocation evidence

A simulated lost device is not revoked until all of these are covered:

- host Tailscale/WireGuard identity;
- Tailscale Kubernetes proxy/operator identities associated with that cluster;
- SSH/operator keys and host trust;
- Git deploy and container-registry identities;
- route and service TLS/mTLS identities;
- SOPS/age recipient;
- Cloudflare Tunnel connector identity;
- runtime secret-store access;
- Fiducia voter/member identity;
- NATS/JetStream route/member identity;
- DNS and external health origins;
- backup writer identity and incident/on-call inventory.

Capture failed access attempts from the revoked identity without recording the
credential itself. A powered-off machine with valid credentials does not pass.

## Public exposure evidence

Use independent scanners from at least two networks or regions. The evidence
should enumerate the approved public HTTP/HTTPS hostnames and prove that these
are not reachable from the public Internet:

- SSH;
- Kubernetes API;
- Fiducia Raft or internal HTTP/admin ports;
- NATS client, route, monitoring, or exporter ports;
- PostgreSQL or managed-service private endpoints;
- NodePorts;
- Argo CD, metrics, dashboards, or secret infrastructure.

Store the scan report by checksum. Do not commit residential IPs or other
sensitive network inventory into this repository.

## Seven-day soak ledger

The soak begins only after every preceding scenario passes or has an approved
rerun. Capture at least one start checkpoint, one checkpoint for each UTC date
crossed, one completion checkpoint, and any incident/fault-specific checkpoints.

Track external availability and latency; Fiducia elections, lag, snapshots and
fencing; JetStream routes, RF, lag, acknowledgement/redelivery/DLQ behavior;
message loss and duplicate effects; CPU, memory, disk, I/O, temperature,
throttling, battery, clock, WAN and tunnel health; backup success; alert
delivery; operator interventions; and every finding.

The committed minimums are deliberately strict for the acceptance campaign:

- at least 168 hours;
- at least 99.0% external availability for this engineering gate;
- 100% scheduled backup success;
- at least 20% disk free space;
- zero acknowledged critical-message loss;
- zero duplicate protected mutation;
- zero final replication lag;
- zero unresolved critical or high finding.

These are engineering acceptance thresholds, not a customer contractual SLA.

## Stop conditions

Stop the active scenario and preserve evidence when any of these occurs:

- two voters or two JetStream members become unavailable;
- the current stable membership is unknown;
- a stale fence or duplicate protected effect is observed;
- an acknowledged critical message is lost;
- a restore cannot prove its source/checksum/key custody;
- disk free space falls below the declared safe floor;
- temperature approaches the hardware/firmware protection threshold;
- clock drift exceeds the reviewed bounded test;
- external health or alert visibility is lost beyond the scenario's intended
  scope;
- another operator starts a conflicting rollout, restore, rotation, or fault;
- evidence capture includes a credential or customer value;
- RTO/RPO exceeds the scenario limit.

Do not broaden or compound the fault to “get more data.” Recover the system,
classify the finding, revise the procedure, and rerun under a new evidence record.

## Evidence validation

Render the immutable plan:

```sh
node tools/laptop-acceptance.mjs --plan \
  > /secure/evidence/den-946/acceptance-plan.json
```

Validate the synthetic example in CI:

```sh
node tools/laptop-acceptance.mjs \
  --evidence acceptance/laptop-fleet/evidence.example.json \
  --allow-example \
  --now 2026-08-03T19:00:00Z
```

Validate fresh live evidence:

```sh
node tools/laptop-acceptance.mjs \
  --evidence /secure/evidence/den-946/live-evidence.json
```

Live evidence must be completed recently, use exact Git revisions, contain the
exact scenario matrix, and use non-example proof/artifact references. The tool
scans for credential-like keys and values. It verifies artifact hashes and
sizes structurally but does not retrieve the external artifacts; reviewers must
open and inspect the evidence store independently.

## Launch classification

### Limited production

Allowed only when every scenario and the soak pass; all required restores and
alerts are proven; acknowledged loss, duplicate effects, final lag and unresolved
critical/high findings are zero; sites, ISPs and power domains are distinct; at
least two independent external probe regions are active; and customer/data
limits, rollback authority and the cloud-migration trigger are recorded.

### Beta only

Use when technical safety tests pass but physical failure domains remain
correlated—for example, two laptops share a building, utility circuit, or ISP.
The risk acceptance must be explicit and customer/data/concurrency limits must
remain small. Do not represent this classification as data-center or true
multi-cloud availability.

### Rejected

Use when an acceptance gate, restore, alert, failure-domain assertion, or soak
threshold is not satisfied. Customer limit must be zero until the finding is
resolved and the affected scenario is rerun.

## Review and Linear evidence

Attach to DEN-946 the exact plan fingerprint; deployment and rollback revisions;
redacted failure-domain/probe summary; one immutable artifact manifest per
checkpoint; scenario RTO/RPO table; restore proofs; failure and protected-effect
proofs; revocation matrix; public exposure report; alert matrix; soak summary and
findings; and the final classification, customer/data limits, rollback authority
and migration trigger.

Do not mark DEN-946 or its parent DEN-941 complete because CI validates the
schema. Completion requires review of fresh, non-example physical evidence from
the actual three-laptop fleet.
