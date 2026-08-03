# Three-member JetStream across the laptop clusters

Governing issue: `DEN-945`.

This profile turns the three previously independent laptop NATS servers into one
three-server NATS/JetStream cluster:

| Laptop cluster | NATS server identity |
|---|---|
| `laptop-aws-sim` | `fiducia-nats-laptop-aws-sim` |
| `laptop-gcp-sim` | `fiducia-nats-laptop-gcp-sim` |
| `laptop-azure-sim` | `fiducia-nats-laptop-azure-sim` |

The stable cluster name is `fiducia-laptop-production`. Critical streams use
replication factor three, which has quorum two and tolerates loss of one server.
Loss of two servers must stop authoritative replicated writes rather than
silently accepting an unsafe minority.

The implementation and example evidence are software contracts. They do not
claim that a live three-server cluster, stream, backup, replay, or failover test
already exists.

## Authority boundary

JetStream is a durable delivery and replay layer. It is not the only system of
record for customer workflow state or protected external mutations.

The production boundary remains:

- PostgreSQL/Supabase is authoritative for workflow/application state,
  transactional outbox/inbox records, and durable idempotency records;
- Fiducia is authoritative for leases, fencing tokens, and protected-mutation
  authority;
- JetStream is authoritative for acknowledged delivery state while the cluster
  is healthy, but critical work must be reconstructable from the database
  outbox/inbox path;
- object storage holds approved encrypted snapshots and recovery artifacts;
- Git holds desired configuration, never credentials.

Do not describe NATS publishing as literal exactly-once external execution.
Redelivery, client retry, leader change, and network uncertainty are normal.
Protected external effects require a current Fiducia fence plus a durable
idempotency record.

## Why three standalone brokers are insufficient

One standalone NATS server per laptop does not create replicated JetStream
state. A publish acknowledged by the AWS-sim broker would not automatically
exist on the GCP-sim or Azure-sim broker, and losing that laptop could lose the
only acknowledged copy.

The laptop profile now gives every server:

- one unique `server_name`;
- one shared NATS cluster name;
- one route listener on TCP 6222;
- two explicit peer routes;
- one reachable route-advertisement hostname through the local cluster's
  Tailscale egress service;
- a dedicated route mTLS identity;
- one local encrypted `local-path` PVC;
- bounded memory, file store, catch-up buffers, request queue, and pending-ack
  limits.

The client plane remains local to each Kubernetes cluster on TCP 4222. The
cross-cluster tailnet exposes only route TCP 6222, never client 4222, monitoring
8222, exporter 7777, Kubernetes, SSH, or Fiducia control ports.

## Route topology

Each laptop's NATS configuration lists the other two cluster-local egress
Services:

```text
fiducia-nats-route-<peer>-tailnet.fiducia.svc.cluster.local:6222
```

The Tailscale operator maps those Services to the remote laptop's NATS route
Service. Every remote NATS route Service is tagged
`tag:fiducia-nats-route`. The deny-by-default tailnet policy permits only
`tag:fiducia-peer-egress -> tag:fiducia-nats-route:6222`.

Each server also advertises its own reachable egress-Service hostname rather
than its pod IP, host IP, or residential endpoint. This is necessary because
NATS route discovery occurs across NAT boundaries. The advertised hostname is
present in the server certificate and exists as an egress Service in both peer
clusters.

`no_advertise: true` suppresses advertising the cross-cluster route as a client
connection target. In-cluster clients continue to use the local
`fiducia-nats.fiducia.svc.cluster.local:4222` Service.

## NetworkPolicy and application authentication

`laptop/components/messaging-ha/networkpolicy.yaml` adds the cross-namespace
route path between NATS pods and Tailscale operator proxies on TCP 6222. The base
namespace policy also permits same-namespace traffic, so Kubernetes
NetworkPolicy alone is not the route authorization boundary.

The route plane therefore fails closed at NATS mTLS:

- a pod without a route certificate cannot join or impersonate a server;
- every route certificate must chain to the dedicated route CA;
- every leaf must contain both clientAuth and serverAuth extended key usages,
  because each NATS server acts as both TLS client and TLS server;
- NATS requires TLS 1.3;
- `verify: true` requires peer certificates;
- `verify_cert_and_check_known_urls: true` binds incoming certificates to the
  explicit route URLs and their DNS SANs;
- each laptop receives a distinct leaf certificate and private key;
- client-account credentials remain in the separate `fiducia-nats-auth` Secret.

Do not reuse the route CA or route leaves as client credentials, web
certificates, Fiducia service identities, or Tailscale identities.

## Route certificate requirements

For `<cluster>` and `<tailnet-domain>`, every leaf certificate must include:

```text
DNS:fiducia-nats-route-<cluster>.<tailnet-domain>
DNS:fiducia-nats-route-<cluster>-tailnet.fiducia.svc.cluster.local
```

It must also:

- be an end-entity certificate, not `CA:TRUE`;
- contain TLS Web Server Authentication and TLS Web Client Authentication EKUs;
- be signed by the dedicated route CA;
- match the supplied private key;
- have at least seven days of remaining validity during materialization;
- use a private key file with no group/world permissions.

Validate without changing a cluster:

```sh
scripts/apply-laptop-nats-route-tls.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --tailnet-domain example.ts.net \
  --cert-file /secure/nats-route/laptop-aws-sim/tls.crt \
  --key-file /secure/nats-route/laptop-aws-sim/tls.key \
  --ca-file /secure/nats-route/ca.crt
```

Apply after review:

```sh
scripts/apply-laptop-nats-route-tls.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --tailnet-domain example.ts.net \
  --cert-file /secure/nats-route/laptop-aws-sim/tls.crt \
  --key-file /secure/nats-route/laptop-aws-sim/tls.key \
  --ca-file /secure/nats-route/ca.crt \
  --apply
```

The script verifies the live kube context has exactly one node labeled for the
requested laptop, then creates `fiducia/fiducia-nats-route-tls` from files. It
prints only certificate/CA fingerprints and never prints the private key.

### CA rotation

Rotate the CA without breaking all routes simultaneously:

1. create the new CA and retain the old CA;
2. distribute a trust bundle containing old and new CAs to one follower at a
   time while leaves remain signed by the old CA;
3. wait for all three servers and routes to recover;
4. issue one new leaf per laptop with the required SANs and both EKUs;
5. roll new leaves follower first and current route/meta/stream leaders last;
6. verify two routes per server, zero stream lag, and protected-mutation tests;
7. remove the old CA from the trust bundle one server at a time;
8. revoke and destroy old leaf keys according to the credential policy.

Never rotate the CA and every leaf in one unobserved deployment.

## Generated server configuration

Run:

```sh
node tools/render-laptop-messaging.mjs
node tools/render-laptop-messaging.mjs --check
```

The generated files are:

```text
laptop/clusters/laptop-aws-sim/nats.conf
laptop/clusters/laptop-gcp-sim/nats.conf
laptop/clusters/laptop-azure-sim/nats.conf
```

Each overlay replaces the standalone base ConfigMap with its generated member
configuration and includes `laptop/components/messaging-ha` to mount route TLS
and add route port 6222.

Key limits are intentionally conservative for 16–32 GiB laptop hosts:

```text
max_mem_store: 512MB
max_file_store: 8GB
max_buffered_msgs: 10000
max_buffered_size: 64MB
request_queue_limit: 5000
max_ack_pending: 10000
duplicate_window: 600s
```

These are initial safety limits, not performance promises. Change them only from
measured publish rate, message size, consumer lag, disk I/O, catch-up, memory,
and restore evidence.

The CI workflow starts the exact pinned NATS image in configuration-test mode
with a temporary CA, dual-EKU leaf, auth include, and every generated laptop
configuration. Rendering tests alone are not accepted as syntax validation.

## Existing standalone-state migration

Do not assume that three independent JetStream stores can be merged safely by
adding route configuration. Existing standalone streams may have divergent
sequence numbers, consumer state, deduplication windows, and acknowledged
messages.

Before the first live rollout, classify each local store:

- **empty** — no production stream or consumer state;
- **disposable** — test-only state that may be discarded after snapshot;
- **authoritative pending migration** — acknowledged production delivery state
  that must be reconciled through outbox/inbox and backup evidence.

For any nonempty production store:

1. stop new background work and hold publishers behind the transactional outbox;
2. let consumers settle and record acknowledgement floors, pending counts,
   redelivery, and DLQ state;
3. snapshot every standalone store and copy snapshots off-host;
4. preserve the PostgreSQL outbox/inbox and idempotency tables as the migration
   source of truth;
5. form the three-server cluster with clean JetStream state rather than trying to
   merge divergent stores in place;
6. create `FIDUCIA_MESSAGES` with file storage, three replicas, the approved
   subject set, and at least a ten-minute duplicate window;
7. replay pending work from the database using stable message IDs;
8. verify consumer acknowledgement floors, DLQ, fences, and idempotency before
   resuming customer work;
9. retain old standalone snapshots through the rollback window.

A direct in-place conversion is allowed only when evidence proves the stores are
empty or already members of the same cluster. The operator must record that
classification; absence of evidence is not treated as empty.

## Stream contract

The initial critical stream evidence profile is:

```text
name: FIDUCIA_MESSAGES
subjects: fiducia.>
storage: file
replicas: 3
duplicate window: at least 600 seconds
lost messages: 0
```

Stream replicas must be placed on all three NATS servers. Evidence must show one
leader and two current followers with zero lag before launch or after any
stateful promotion.

Disposable telemetry or progress traffic should use separate streams and may
use lower replication only when explicitly documented. Do not reduce the
critical stream's replication factor to make a degraded cluster appear healthy.

## Rollout sequence

This is a stateful, quorum-bearing change. Use DEN-944's guarded promotion and
do not synchronize all three clusters together.

1. Verify all current Fiducia members, NATS servers, outbox/inbox workers,
   backups, and external probes are healthy.
2. Capture the standalone-state classification and migration evidence.
3. Approve the tailnet route tag/grant and apply the NATS route ingress/egress
   resources.
4. Generate three unique route leaves and validate their SANs/EKUs.
5. Materialize the route TLS Secret on all three clusters before changing the
   StatefulSet configuration.
6. Select a NATS server that is not the current JetStream/meta leader and remove
   its cluster from public/background work where practical.
7. Promote the generated NATS configuration to that follower only.
8. Require two healthy routes, membership visibility, stable disk, and no auth or
   TLS errors.
9. Repeat for the second non-leader.
10. Transfer leadership or accept the controlled leader restart, then promote
    the final server last.
11. Create or validate the RF=3 stream and replay from the outbox where required.
12. Capture fresh evidence and run one-member failure tests before resuming full
    work.

Do not restart a second member while the first is catching up, while a stream
replica is not current, or while the meta/stream leader is unknown.

## Live evidence validator

The committed file
`laptop/messaging/jetstream-evidence.example.json` is explicitly non-production.
It exercises the validator and CI only.

Example rehearsal:

```sh
node tools/validate-laptop-jetstream-evidence.mjs \
  --evidence laptop/messaging/jetstream-evidence.example.json \
  --allow-example \
  --now 2026-08-03T18:05:00Z
```

A real evidence file stays outside Git:

```sh
node tools/validate-laptop-jetstream-evidence.mjs \
  --evidence /secure/evidence/fiducia-laptop-jetstream.json
```

Live evidence must be no more than ten minutes old and must prove:

- exact cluster and three unique server identities;
- exact pinned NATS version;
- one route CA fingerprint and three unique leaf fingerprints;
- route TLS enabled and exactly two named peer routes per server;
- JetStream enabled with `/data/jetstream`, bounded file stores, and at least 20%
  disk free;
- one current meta leader;
- `FIDUCIA_MESSAGES` with RF=3, file storage, zero lost messages, one leader, and
  two current zero-lag followers;
- client authentication, route mTLS, transactional outbox, inbox
  deduplication, Fiducia fencing, protected-mutation idempotency, DLQ replay,
  external backup, and one-member failure gates;
- distinct non-example proof identifiers.

The validator rejects stale evidence, one missing route, duplicate certificates,
RF drift, follower lag, lost messages, missing gates, duplicated proofs,
credential-like values, or example proofs in live mode.

It does not connect to NATS or independently verify proof references. Reviewers
must inspect the restricted evidence source.

## Required failure tests

Before DEN-945 can be completed, perform at least:

- power off a non-leader laptop;
- power off the current stream leader after recording and, where possible,
  transferring leadership;
- interrupt one route in one direction;
- expire or revoke one route certificate in a controlled test;
- make one route CA untrusted and verify that member cannot join;
- fill one local JetStream file store toward its alert threshold;
- create consumer lag and prove alerting, bounded backpressure, and recovery;
- redeliver a protected mutation and prove fencing/idempotency prevents duplicate
  external effect;
- replay the database outbox after a JetStream interruption;
- snapshot, restore, and validate the critical stream and consumer state;
- replace one NATS member with a clean identity and wait for full catch-up.

Every test must capture precondition, leader/member state, exact revision,
expected failure, observed result, alerts, recovery time, and stop/rollback
decision.

## Backup and restore

JetStream snapshots supplement, but do not replace, database replay.

A complete recovery exercise must prove:

1. the stream and critical consumers can be snapshotted without exposing message
   contents in logs;
2. the snapshot leaves the laptop and lands in approved encrypted object
   storage;
3. the database outbox/inbox can identify and replay missing work;
4. a clean NATS member can join as a replica and catch up;
5. a full cluster/stream restore preserves sequence and consumer acknowledgement
   semantics where required;
6. protected external mutations remain fenced and idempotent throughout;
7. no stale server identity or old route certificate can rejoin.

Do not wipe a failed member or old standalone store until the rollback window and
restore review are complete.

## Monitoring and stop conditions

Monitor at least:

- server count, meta leader, route count, route reconnects, TLS/auth failures;
- stream leader, replicas, current/lag/active state, lost messages;
- publish acknowledgements, request queue drops, catch-up buffers, memory and file
  store use;
- consumer pending, acknowledgement floor, redelivery, max-deliver, and DLQ;
- disk free, I/O latency, temperature, throttling, WAN latency/loss, and clock
  drift;
- outbox age, inbox duplicate count, fencing rejection, and protected-mutation
  idempotency;
- snapshot age, upload failure, restore-test age, and object-store reachability.

Stop rollout or customer work when:

- fewer than two servers are healthy;
- any critical stream has fewer than two current replicas;
- a route certificate cannot be validated;
- a follower is not current or has nonzero lag beyond the approved window;
- lost messages is nonzero;
- disk free falls below 20% or file-store limits are approached;
- outbox replay, fencing, or idempotency proof fails;
- backup or recovery-key evidence is unavailable;
- a second member change would overlap an unresolved first change.

## Primary references

- NATS clustering: https://docs.nats.io/running-a-nats-service/configuration/clustering
- NATS TLS configuration: https://docs.nats.io/running-a-nats-service/configuration/securing_nats/tls
- NATS route TLS identity checking: https://docs.nats.io/running-a-nats-service/configuration/securing_nats/tls#known-urls
- JetStream clustering: https://docs.nats.io/running-a-nats-service/configuration/clustering/jetstream_clustering
- JetStream configuration: https://docs.nats.io/running-a-nats-service/configuration/resource_management
