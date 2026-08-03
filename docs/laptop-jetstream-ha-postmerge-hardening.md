# DEN-945 post-merge hardening notes

This document records the semantic reconciliation between the original
three-member JetStream branch and the per-laptop network identity isolation that
landed later in PR #21.

The governing issue remains `DEN-945`. The longer operational procedure is in
`docs/laptop-jetstream-ha.md`.

## Reconciled network identity model

The original JetStream work used one fleet-wide Tailscale egress tag and one
fleet-wide NATS route tag. That design was superseded before merge by the
cluster-specific peer identities introduced for the laptop private mesh.

The final contract uses:

- `tag:fiducia-peer-egress-aws-sim`
- `tag:fiducia-peer-egress-gcp-sim`
- `tag:fiducia-peer-egress-azure-sim`
- `tag:fiducia-nats-route-aws-sim`
- `tag:fiducia-nats-route-gcp-sim`
- `tag:fiducia-nats-route-azure-sim`

Each cluster egress identity may reach only the other two NATS route identities
on TCP 6222. It cannot reach its own route identity, any NATS client listener on
4222, any NATS monitoring listener on 8222, laptop SSH/Kubernetes management, or
unrelated Fiducia ports.

The same cluster-specific egress identity continues to reach only the other two
Fiducia node and brain identities on their explicit Raft ports. No wildcard
source, destination, protocol, or port is introduced.

The `ProxyGroup` remains cluster-scoped and has no `metadata.namespace`. The
per-cluster materialization therefore preserves the Kubernetes-operator contract
introduced by PR #21 while adding one local NATS route ingress Service and two
remote NATS route egress mirrors.

## Route advertisement versus client advertisement

The NATS route configuration deliberately contains both:

```conf
advertise: "fiducia-nats-route-<cluster>-tailnet.fiducia.svc.cluster.local:6222"
no_advertise: true
```

These settings are not contradictory:

- `advertise` gives other NATS servers the route contact address that remains
  reachable through the private-mesh service mirror instead of advertising a
  pod, host, or residential IP;
- `no_advertise` suppresses NATS server URLs from client discovery so local
  clients do not receive cross-cluster route addresses as client connection
  targets.

Every server still lists both remote routes explicitly. Tests inspect only the
actual `routes` entries when checking that a server does not route to itself; the
self route-advertisement address is expected and required.

## Pinned server and canonical configuration fields

The laptop profile uses the same exact server image as the base StatefulSet:

```text
nats:2.11.17-alpine@sha256:e4bf19f15fd3218814a4e3c9e0064e1334bd8aa20d5984b9f1a0afd084f8cc00
```

Generated configuration uses the documented `max_memory_store` spelling rather
than the legacy/ambiguous `max_mem_store` form. It also declares:

- one unique `server_name` per laptop;
- site, cluster, and substrate server tags;
- `unique_tag: "site"` for JetStream placement;
- local `/data/jetstream` storage;
- 512 MiB memory and 8 GiB file-store limits;
- 64 MiB maximum outstanding catch-up traffic;
- bounded buffered messages, bytes, and API requests;
- a ten-minute maximum duplicate window at the server-limit layer;
- one route connection per peer;
- TLS 1.3 route mTLS with certificate verification against known route URLs.

The auth include remains fail-closed. It must define a `SYS` system account and a
separate JetStream-enabled application account. Route certificates and client
authentication are separate trust materials.

## Real parser validation

Text assertions alone cannot prove that a configuration is accepted by the
selected NATS binary. `scripts/test-laptop-nats-configs.sh` therefore:

1. creates a private temporary directory with mode-0600 synthetic auth and route
   material;
2. creates a one-day test CA and leaf certificate carrying both server and
   client authentication EKUs plus all generated route DNS names;
3. starts the exact digest-pinned production image with networking disabled;
4. runs `nats-server -t -c /etc/nats/nats.conf` for every generated laptop
   configuration;
5. deletes all temporary credentials and keys on exit.

The container runs with the host runner UID/GID. Test files do not need to be
made world-readable merely for Docker.

This parser check is necessary but not sufficient. It proves syntax, includes,
TLS-file readability, and binary compatibility. It does not prove live route
connectivity, certificate rotation, quorum, stream replication, or recovery.

## Evidence contract

Example and live evidence now bind to:

- exact NATS version `2.11.17`;
- exactly three named servers;
- exact site/cluster/substrate server tags;
- two authenticated routes per server;
- three distinct route leaf certificates under one recorded CA fingerprint;
- local JetStream storage with at least 8 GiB configured capacity and 20% free
  disk headroom;
- an RF=3 `FIDUCIA_MESSAGES` file stream on `fiducia.>`;
- a duplicate window of at least 600 seconds;
- zero lost messages and zero follower lag;
- current outbox/inbox, fencing, idempotency, DLQ/replay, backup, and
  one-member-failure proof identifiers.

Live evidence older than ten minutes is rejected. Placeholder proof identifiers,
version drift, site-tag drift, route loss, replica lag, RF drift, duplicate
server/certificate/proof identities, and missing safety gates all fail closed.

The validator does not independently retrieve the referenced evidence. The
proof identifiers must point to separately retained logs, reports, snapshots,
or test artifacts.

## Rollout boundary

This merged software contract does not mark DEN-945 complete. Live rollout still
requires:

1. install the Tailscale operator and the three cluster-specific policy bundles;
2. issue one route certificate per laptop from the approved route CA;
3. materialize route TLS and NATS auth Secrets without committing values;
4. start and stabilize the first member, then add one follower at a time;
5. create or update `FIDUCIA_MESSAGES` with RF=3 through the messaging relay;
6. verify the database outbox/inbox remains authoritative for replay;
7. power off a follower and then a current stream/meta leader in separate tests;
8. prove acknowledged critical delivery, fencing, and protected-mutation
   idempotency across failure and redelivery;
9. restore a member from approved snapshots and rejoin it without replacing a
   second member;
10. attach fresh non-example evidence to DEN-945 and DEN-946.

The in-cluster NATS client plane remains a separate TLS hardening dependency. The
cross-cluster route plane added here is private, authenticated, and encrypted,
but DEN-438 and the secret-delivery dependencies remain open before the entire
service-to-service path can be called complete.
