# Three-laptop physical acceptance campaign

Governing issue: `DEN-946`.

This document defines the evidence required before the temporary three-laptop
substrate can be approved for limited customer-facing use. It is deliberately
stricter than manifest rendering or unit tests: the campaign must run against the
three physical laptops and their real networks, disks, batteries, private mesh,
ingress connectors, Fiducia members, JetStream members, backups, and alerting.

## Classification boundary

There are two possible successful outcomes:

- **limited-production** — all three laptops have distinct physical sites,
  networks, and power domains, every required scenario passes, all restore and
  revocation proofs exist, RTO/RPO and zero-loss/zero-duplicate thresholds pass,
  and the seven-day soak completes;
- **beta-only** — the same functional evidence passes, but one or more physical
  failure domains remain correlated or the launch is intentionally restricted.

A correlated fleet cannot request limited-production classification. Three
laptops in one room, behind one router, or on one power circuit remain one
physical failure domain regardless of Kubernetes labels.

## Files

```text
acceptance/laptop-fleet-campaign.toml
acceptance/laptop-fleet-evidence.example.json
tools/validate-laptop-acceptance-evidence.mjs
tools/laptop-acceptance.test.mjs
```

The TOML file is the reviewed policy. The JSON example is synthetic and exists
only to exercise the schema and tests. Real evidence should be stored in an
approved encrypted evidence location and should not be committed when it
contains private topology or operational identifiers.

## Validation command

Example-only CI validation:

```sh
node tools/validate-laptop-acceptance-evidence.mjs \
  --evidence acceptance/laptop-fleet-evidence.example.json \
  --allow-example
```

Live validation:

```sh
node tools/validate-laptop-acceptance-evidence.mjs \
  --evidence /secure/evidence/den-946-live.json
```

The production command rejects:

- `evidenceMode: example` without `--allow-example`;
- stale final observations;
- placeholder proof identifiers beginning with `example-`;
- mutable or abbreviated Git/image revisions;
- missing or failed scenarios;
- missing restore, alert, or revocation proof;
- RTO/RPO, acknowledged-loss, or duplicate-mutation threshold violations;
- a soak shorter than seven days or with excessive sampling gaps;
- unresolved critical findings;
- self-approval by the same operator and reviewer;
- private-key, bearer-token, GitHub-token, Tailscale-key, credential-in-URL, or
  explicit secret-bearing fields;
- limited-production requests with correlated physical domains.

## Campaign preparation

Before the seven-day window:

1. Pin the exact Git revision and every production image digest.
2. Record the three cluster identities and physical site, network, power, and
   physical-access ownership for each laptop.
3. Verify off-host K3s, Fiducia, database, JetStream, object-storage, and
   recovery-key proofs.
4. Verify two or more independent external probe regions.
5. Confirm all three Fiducia voters, JetStream members, Cloudflare connectors,
   private-mesh identities, GitOps roots, and telemetry paths are healthy.
6. Verify PostgreSQL/Supabase remains authoritative for workflow state,
   outbox/inbox replay, and idempotency.
7. Confirm one global membership/change lease exists and is fenced.
8. Freeze unrelated stateful rollouts, key rotations, restores, and network
   migrations during each disruptive test.
9. Ensure a rollback operator and an independent reviewer are available.

## Required scenarios

### Baseline

Capture route, quorum, leadership, replica, stream, consumer, acknowledgement,
backup, disk, thermal, WAN, ingress, and external-health observations. Prove the
three-member baseline is fully caught up before injecting faults.

### Invalid route identity

Attempt absent, wrong-CA, wrong-SAN, wrong-EKU, expired, and mismatched-key NATS
route identities. Valid peers must remain healthy and invalid peers must fail
closed without exposing secret values.

### Non-leader power loss

Power off one non-leader laptop. Prove:

- Fiducia and JetStream preserve the tested two-of-three operating mode;
- acknowledged critical messages are not lost;
- protected external mutations do not duplicate;
- public origins route away from the failed laptop;
- the returned member catches up before it serves traffic.

### Leader power loss

Power off the current Fiducia and JetStream leaders in separate controlled
trials. Record election time, delivery behavior, redelivery, consumer
acknowledgement floors, fencing-token behavior, and protected-mutation results.

### ISP loss

Disconnect one laptop's WAN path. Exercise the secondary WAN where available.
Verify external origins, quorum behavior, private-mesh recovery, and alerts.

### Asymmetric partition

Block one direction of peer traffic. The system must not treat one-way reachability
as healthy full membership or permit stale authority to create an unfenced
external mutation.

### Tunnel loss

Stop one Cloudflare connector and then remove one origin. Public HTTP should
continue through healthy clusters without manual DNS changes.

### Kubernetes API loss

Stop or isolate one K3s API while leaving workloads running where possible.
Other clusters must continue independently; no cluster may require Laptop A as a
central reconciliation controller.

### Disk pressure

Apply bounded disk and I/O pressure. Prove pre-exhaustion alerts, bounded
backpressure, no silent authoritative `emptyDir` use, and recoverable snapshots.

### Clock drift

Apply bounded clock skew that is safe for the test environment. Verify detection,
TLS/token behavior, leases, elections, and recovery after time correction.

### Thermal pressure

Create controlled CPU/I/O load within hardware-safe limits. Record temperature,
throttling, battery behavior, latency, lag, and whether the 60% sustained safe
capacity target remains realistic.

### Failed image pull

Promote a deliberately unavailable digest to a non-production canary path.
Prove the rollout stops, healthy clusters remain untouched, and immutable
rollback succeeds.

### Interrupted upgrade

Interrupt one follower upgrade, recover it, wait for catch-up, then continue.
The current leader is handled last. No second member changes while the first is
unhealthy or catching up.

### Outbox replay

Rebuild selected delivery from PostgreSQL/Supabase outbox/inbox state. Prove
current fencing plus durable idempotency prevents duplicate external effects.

### JetStream redelivery

Exercise redelivery, deduplication, acknowledgement floors, DLQ, replay, and
consumer recovery through leader movement and one-member loss.

### Member replacement

Rebuild one clean laptop/member with a new identity. Restore or catch up from
approved sources and never reuse a removed member identity unsafely. Keep the
other two voters stable throughout.

### Clean-room restore

Restore representative K3s control-plane state, Fiducia state, database state,
JetStream state, and object-storage artifacts using independently held recovery
material. No mutable state may be copied from another live laptop as a shortcut.

### Lost-device revocation

Revoke a simulated stolen laptop from:

- private mesh;
- SSH;
- Git and registry;
- TLS/mTLS;
- SOPS/age;
- Cloudflare Tunnel;
- runtime secret store;
- Fiducia membership;
- JetStream membership.

The revoked identity must be unable to reconnect or decrypt new material.

### Alert delivery

Inject or observe every required alert and attach an actionable receipt. A metric
or log existing in storage is not sufficient if no operator receives it.

### Rollback

Exercise immutable stateless rollback and a safe one-member stateful rollback.
After membership changes, reintroduce the old source as a learner/non-routing
replica and catch it up before replacing the failed target.

## Required restore proof

The evidence must include proof identifiers for:

- K3s control plane;
- Fiducia state;
- database;
- JetStream;
- object storage;
- independent recovery-key custody.

A successful upload is not a successful backup. Each path requires a clean
restore result.

## Required alert proof

The campaign covers external HTTP, tunnel health, private mesh, quorum, member
lag, election churn, JetStream replicas, consumer lag, redelivery, DLQ, disk
space, disk health, temperature, thermal throttling, battery, clock drift, WAN,
backup failure, backup age, and restore-test age.

Alert receipts should record the alert identity, start/end time, destination,
operator acknowledgment, and resolution reference without exposing private
credentials or customer data.

## Thresholds

The committed policy currently requires:

- at least 168 hours of soak;
- at least 168 samples;
- no sample gap above 90 minutes;
- public failover RTO no worse than five minutes;
- one-member rebuild RTO no worse than two hours;
- complete fleet recovery RTO no worse than eight hours;
- critical-data RPO no worse than one hour;
- zero acknowledged critical-message loss;
- zero duplicate protected external mutations;
- zero unresolved critical findings;
- at least two independent external probe regions.

These are engineering launch gates, not contractual customer SLAs. Tighten them
only after measured evidence; do not loosen them merely to pass a campaign.

## Seven-day soak

The soak begins only after every disruptive scenario has returned to a healthy
baseline. It must include representative low-volume traffic and bounded fault
injection, with continuous sampling of:

- public availability and latency;
- tunnel and mesh health;
- Fiducia quorum, elections, lag, snapshots, and fencing;
- JetStream replicas, streams, consumers, acknowledgement floors, redelivery,
  and DLQ;
- CPU, memory, disk, I/O, temperature, throttling, battery, clock, and WAN;
- backup completion/age and restore-test age;
- operator interventions and unresolved findings.

Any critical finding restarts the acceptance decision. A finding is not resolved
merely because the symptom stopped.

## Approval

The campaign operator and reviewer must be distinct identities. Both approvals
occur after campaign end. The reviewer verifies evidence completeness, proof
freshness, thresholds, unresolved findings, and requested classification.

The validator's `eligible-limited-production` or `eligible-beta-only` result is a
necessary input to the launch decision, not a substitute for the human review.
`example-only` can never approve a launch.

## Linear completion rule

DEN-946 may move to Done only after the live evidence report, redacted campaign
bundle, measured thresholds, operator/reviewer approvals, and launch decision are
attached. DEN-941 must remain In Progress until DEN-946 and all other physical
implementation gates are complete.
