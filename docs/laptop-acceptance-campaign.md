# Three-laptop production acceptance campaign

Governing issue: `DEN-946`.

This campaign is the final evidence gate before the temporary laptop substrate
may be approved for limited production or explicitly classified as beta-only.
It combines software restarts, private-network failures, physical power/WAN
loss, host pressure, identity revocation, clean-room restores, and a seven-day
soak.

The repository provides an immutable campaign specification, deterministic
planner, software-only state-machine rehearsal, redacted evidence capture,
bounded Kubernetes fault runner, and strict completed-results validator. CI does
not execute a production or physical fault and cannot approve the fleet.

## Safety invariants

The campaign enforces:

- one active fault or membership-changing operation at a time;
- full recovery and catch-up before the next fault;
- at least two healthy Fiducia voters;
- at least two healthy JetStream members;
- at least two healthy public origins;
- fresh roles, health, backups, external probes, and stop authority before every
  step;
- current backup and offline recovery-key evidence;
- zero lost committed Fiducia entries;
- zero lost acknowledged critical JetStream messages;
- zero duplicate protected external effects;
- database outbox replay, inbox deduplication, and Fiducia fencing throughout;
- non-leaders before current leaders within every stateful scenario;
- accountable human observation for physical, security, destructive, and
  bounded host/network faults;
- a reviewed rollback after every fault;
- a minimum seven-day soak as the final campaign step.

A campaign must stop rather than relax quorum, replication, fencing, backup, or
recovery requirements to make a degraded system appear healthy.

## Immutable campaign specification

`laptop/acceptance/campaign.json` owns:

- fault-concurrency and 2-of-3 safety limits;
- required independent external probes;
- initial engineering RTO/RPO targets;
- required global preconditions;
- scenario identities, scope, execution type, expected lost members/origins,
  backup checkpoint, traffic-drain, and protected-mutation requirements;
- the final 168-hour soak.

The initial targets are engineering gates, not contractual SLAs:

| Target | Initial maximum |
|---|---:|
| Public origin failover | 300 seconds |
| Ordinary member recovery | 900 seconds |
| Replacement laptop recovery | 7,200 seconds |
| Full-fleet clean-room recovery | 28,800 seconds |
| Critical data RPO | 3,600 seconds |

A live result exceeding a target fails the strict acceptance validator. The
operator may change a target only through a reviewed campaign-spec change with
explicit risk rationale; do not edit measured evidence.

## Scenario matrix

### Automated Kubernetes restarts

These are the only faults executable by
`scripts/run-laptop-software-fault.sh`:

- one Cloudflare connector pod;
- one stateless API/load-balancer pod;
- one Fiducia voter pod;
- one NATS/JetStream member pod.

The script is plan-only by default and requires explicit production, single-
fault, and rollback acknowledgements for `--apply`. Stateful restarts require a
freshly observed `follower` or `leader` role. A leader additionally requires
`--ack-leader-last`.

### Manual bounded faults

- asymmetric private-mesh partition;
- K3s control-plane restart;
- bounded disk pressure;
- bounded clock drift;
- bounded thermal/load pressure;
- interrupted/failed host or stateful upgrade with rollback.

These require a step-specific runbook, human stop authority, upper bounds, and a
known recovery action. The repository deliberately does not provide a generic
root command for changing system time, filling disks, throttling fans, or
breaking arbitrary routes.

### Manual physical and security faults

- primary ISP disconnection and backup-WAN behavior;
- laptop plus site-network power pull;
- simulated lost/stolen laptop revocation across every trust system;
- clean replacement laptop build and member catch-up.

Physical tests require an observer at the affected site and an independent
operator who can stop the campaign and verify the two healthy sites.

### Clean-room recovery

- K3s control-plane restore;
- Fiducia snapshot/WAL restore and committed-state verification;
- managed database PITR or encrypted backup restore;
- JetStream stream/consumer restore plus database outbox replay.

A backup upload is not a passing restore. Each clean-room exercise must start
from approved clean hardware or an isolated clean environment and must not copy
mutable state from another live laptop.

### Seven-day soak

The final step runs at least 168 consecutive hours with representative traffic,
normal backups, alert delivery, and at least three bounded faults. The review
records availability, latency, elections, replication lag, redelivery, duplicate
protection, CPU, memory, disk, I/O, temperature, bandwidth, backup completion,
restore checks, and operator interventions.

Any unresolved critical finding resets the launch decision; time spent before a
critical reset is not automatically counted as a successful soak.

## Preflight evidence

`laptop/acceptance/preflight.example.json` is non-production rehearsal data.
Live preflight remains outside Git and must be no more than ten minutes old.

It proves:

- exact deployment and rollback commits;
- current Fiducia, JetStream metadata, and critical-stream leaders;
- all three healthy public origins, Fiducia voters, and JetStream members;
- at least two independent external probe regions;
- current host-inventory, tailnet, GitOps, and JetStream evidence fingerprints;
- K3s, Fiducia, database, JetStream, and offline recovery-key proof references;
- exclusive fault lease, alert, backup, fencing, idempotency, outbox, DLQ,
  operator/physical access, rollback, and stop-authority gates;
- Kubernetes, GitOps, tailnet, tunnel, Fiducia, JetStream, storage, host
  monitoring, and backup readiness for every laptop.

Example plan and abstract rehearsal:

```sh
node tools/plan-laptop-acceptance-campaign.mjs \
  --preflight laptop/acceptance/preflight.example.json \
  --allow-example \
  --now 2026-08-03T18:11:00Z \
  > /tmp/den-946-example-plan.json
```

Live planning:

```sh
node tools/plan-laptop-acceptance-campaign.mjs \
  --preflight /secure/evidence/den-946-live-preflight.json \
  > /secure/evidence/den-946-plan-and-rehearsal.json
```

The planner orders leader-sensitive cases from the lowest observed leadership
score to the current leader. It chooses a current non-leader as the designated
clean-recovery/revocation target. Roles must still be reobserved immediately
before execution because leadership may move after planning.

## Global fault lock

The bounded software runner creates
`fiducia/fiducia-acceptance-active-fault` in a designated coordination cluster.
Creating the lock fails when another run is active. The lock records only
campaign, scenario, target, revision, and start time.

The successful path releases the lock only after the replacement pod is ready
and redacted after-evidence is captured. A failed/incomplete path must retain the
lock until an operator proves recovery and explicitly clears it. Never delete a
stale-looking lock without investigating the target cluster and the previous
operator's evidence.

The Kubernetes lock protects operators using this tool. It does not replace the
Fiducia membership/change lease or human change coordination required for
physical and host-level steps.

## Redacted cluster snapshots

`scripts/capture-laptop-cluster-snapshot.sh` captures status-only evidence for one
cluster:

- selected laptop node identity labels, readiness, capacity, and allocatable
  capacity;
- Deployment and StatefulSet desired/ready/current/updated generations;
- pod name, app label, phase, readiness, restart count, and deletion state;
- PVC name, phase, class, requested/capacity, and access modes;
- Service name, type, and ports;
- NetworkPolicy name, policy types, and selected app.

It intentionally excludes:

- Secrets and ConfigMaps;
- logs and events;
- environment variables and workload specifications;
- pod, service, and node IP addresses;
- image pull credentials.

Output is mode `0600`, contains the exact Git revision, and is fingerprinted with
SHA-256. A snapshot is supporting evidence, not proof of external availability,
alert delivery, quorum, lag, fencing, replay, or data safety.

## Running a bounded software fault

Plan only:

```sh
scripts/run-laptop-software-fault.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --coordination-context fiducia-laptop-gcp-sim \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --scenario jetstream-member-restart \
  --observed-role follower \
  --evidence-dir /secure/evidence/den-946
```

Apply only after reviewing fresh preflight and rollback evidence:

```sh
scripts/run-laptop-software-fault.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --coordination-context fiducia-laptop-gcp-sim \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --scenario jetstream-member-restart \
  --observed-role follower \
  --evidence-dir /secure/evidence/den-946 \
  --ack-production-fault \
  --ack-single-fault \
  --ack-rollback-reviewed \
  --apply
```

The runner:

1. validates the target and coordination kube contexts;
2. acquires the global fault lock;
3. captures a redacted before snapshot;
4. requires exactly one running selected pod;
5. deletes that pod only;
6. waits for deletion, rollout completion, and replacement readiness;
7. captures a redacted after snapshot;
8. writes a local result requiring external/data-safety completion;
9. releases the lock only after its bounded work succeeds.

It does not claim or test external probes, alert routing, Fiducia quorum, NATS
stream lag, fencing, idempotency, database replay, or physical recovery. Attach
those independent proofs before marking the campaign step passed.

## Required per-step review

Every completed step must include:

- immutable step/scenario/target identity;
- start/end timestamps and exact revision;
- fault actually injected, expected degraded state, and recovery action;
- alert delivery;
- two or more independent external probe regions;
- public failover and member recovery measurements;
- measured RPO;
- zero lost committed Fiducia entries;
- zero lost JetStream messages;
- zero duplicate protected effects;
- full readiness and zero-lag catch-up;
- a human observer for every non-automated step;
- stop authority confirmation;
- at least three unique restricted proof references.

Do not reuse one screenshot, log, or report as independent proof for multiple
steps. Proof references must be distinct and must not expose credentials or
sensitive topology in Git or Linear.

## Completed-results validator

The exact plan is saved and fingerprinted. Results must contain every immutable
step exactly once and match the plan's scenario, target, and execution type.

The validator fails when:

- the plan fingerprint differs;
- any step is missing or duplicated;
- a step is not passed, recovered, fully caught up, alerted, and externally
  probed;
- public failover, member recovery, fleet recovery, or RPO exceeds the target;
- any committed Fiducia entry or JetStream message is lost;
- any protected effect is duplicated;
- a manual/physical/security/destructive step lacks a human observer;
- the soak is shorter than 168 hours or has fewer than three bounded faults;
- backup, restore, alert, representative-traffic, or critical-finding gates fail;
- limited-production is selected without independent physical failure domains;
- example or duplicated proof references appear in live evidence.

Example result objects are generated only by tests and require explicit
`--allow-example`. A passing validator does not independently inspect restricted
proofs; accountable human review remains mandatory.

## Lost-device revocation

The simulated lost device is removed or denied across:

- Tailscale/WireGuard;
- SSH/operator access;
- Git and image registry;
- TLS/mTLS identities and route certificates;
- SOPS/age recipients;
- Cloudflare connector identity;
- runtime secret store;
- Fiducia membership;
- JetStream membership;
- DNS, probes, backup jobs, and incident routes.

The test fails when the old identity can still authenticate, route traffic, join
quorum, read secrets, upload backups, or reconcile GitOps. The replacement uses
new host, Raft, JetStream, route, tunnel, and bootstrap identities.

## Evidence handling

Live preflight, snapshots, proof bundles, result files, backup IDs, network
measurements, addresses, and security evidence remain in restricted encrypted
storage. Git and Linear receive redacted summaries, fingerprints, PRs, run IDs,
and pass/fail conclusions—not keys, tokens, customer data, home addresses, raw
firewall rules, or internal endpoint inventories.

## CI contract

The dedicated workflow validates:

- campaign schema and safety limits;
- example/live separation and preflight freshness;
- exact three-cluster health and readiness;
- deterministic leader-aware ordering;
- one-fault-at-a-time action ordering;
- 2-of-3 safety at every degraded checkpoint;
- full recovery before every next fault;
- the final seven-day soak position;
- strict completed-result acceptance and negative cases;
- redacted snapshot and bounded fault-runner contracts;
- shell syntax;
- deterministic plans and reports.

CI performs no `kubectl` write and cannot complete DEN-946.

## Completion boundary

DEN-946 may close only after live evidence proves every campaign step, all
clean-room restores, simulated device revocation, measured RTO/RPO, and the full
seven-day soak with zero unresolved critical findings. The parent DEN-941 must
remain In Progress until that review is complete.