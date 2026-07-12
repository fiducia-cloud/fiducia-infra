# node — the data plane

Manifests for `fiducia-node`, the sharded Raft data plane. Each node is a Raft member,
so it runs as a `StatefulSet` (stable identity + durable storage for shard logs/snapshots).
The `fiducia-node-sidecar` runs as a second container in the same pod: its bridge to the
brain (heartbeat + failure-domain metadata) and telemetry.

- `statefulset.yaml` — the node + sidecar workload.
- `service.yaml` — headless service for stable per-pod peer DNS.
- `pdb.yaml` — PodDisruptionBudget keeping shard quorum during voluntary disruptions.
- `networkpolicy.yaml` — L3/L4 boundary behind the trusted-hop secret.
