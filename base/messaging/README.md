# messaging — hardened NATS/JetStream broker

Single-replica `fiducia-nats` StatefulSet (JetStream, file storage on a 10Gi
PVC) with a `prometheus-nats-exporter` sidecar (`:7777`), a ClusterIP service
(`nats://fiducia-nats.fiducia.svc.cluster.local:4222`), and a namespace-scoped
NetworkPolicy. The per-cluster `storageClassName` is injected by the GENERATED
overlay patches (`tools/render.mjs`), like node/brain.

Streams are provisioned **by the fiducia-messaging relay**, not by broker
config — the broker only enables JetStream. At startup the relay verifies that
the `FIDUCIA_MESSAGES` stream on `fiducia.>` has `duplicate_window >= 600s`
(the publish-dedup invariant its Postgres outbox retry loop depends on) and
**fails closed** if it does not hold.

## Auth: fail-closed out-of-band Secret

`nats.conf` ends with `include ./auth/auth.conf`, mounted from the
`fiducia-nats-auth` Secret (key `auth.conf`). The Secret is deliberately **not
committed** and **not optional**: without it the pod never starts, so the bus
can never run unauthenticated — the same out-of-band provisioning contract as
`fiducia-secrets` (see `base/node/statefulset.yaml`).

Expected shape — a `SYS` system account plus a `FIDUCIA` application account
whose users get per-subject allows on `fiducia.>` and
`dd.remote.container_pool.>` (JetStream users also need the `$JS` API/ack
subjects and their `_INBOX` reply subjects):

```conf
system_account: SYS

accounts {
  SYS {
    users: [ { user: sys, password: "<random>" } ]
  }
  FIDUCIA {
    jetstream: enabled
    users: [
      { user: relay, password: "<random>",
        permissions: {
          publish:   { allow: [ "fiducia.>", "dd.remote.container_pool.>", "$JS.API.>", "$JS.ACK.>" ] }
          subscribe: { allow: [ "fiducia.>", "dd.remote.container_pool.>", "_INBOX.>" ] } } }
      { user: lambda, password: "<random>",
        permissions: {
          publish:   { allow: [ "fiducia.>", "$JS.API.>", "$JS.ACK.>" ] }
          subscribe: { allow: [ "fiducia.>", "_INBOX.>" ] } } }
      { user: agent-manager, password: "<random>",
        permissions: {
          publish:   { allow: [ "dd.remote.container_pool.>", "$JS.API.>", "$JS.ACK.>" ] }
          subscribe: { allow: [ "dd.remote.container_pool.>", "_INBOX.>" ] } } }
    ]
  }
}
```

Provision (out-of-band, per cluster):

```sh
kubectl -n fiducia create secret generic fiducia-nats-auth \
  --from-file=auth.conf=./auth.conf
```

Nkey users (`{ nkey: U... }`) are a drop-in alternative to passwords; clients
that authenticate with a credentials file point `NATS_CREDS_FILE` at it.

## TLS

The broker does not yet terminate TLS (a future cert Secret, mounted the same
fail-closed way as auth, will add a `tls {}` block). The fiducia client policy
(fiducia-messaging.rs `src/connect.rs`) **requires TLS for any non-loopback
host**, so in-cluster clients connecting to `fiducia-nats.fiducia.svc...` must
explicitly set `FIDUCIA_NATS_ALLOW_PLAINTEXT=1` (logged loudly) — an
acknowledged trade-off while the plaintext hop is confined to the
namespace-internal network by the default-deny NetworkPolicy baseline.
`FIDUCIA_NATS_REQUIRE_TLS=1` force-enables TLS regardless of host.

## Not yet deployed here (follow-up)

The fiducia-messaging relay itself and its Postgres outbox are not part of this
directory yet — this is only the broker they will talk to.
