# kind/overlay — local kind Kustomize overlay

The overlay that deploys `base/` onto the local `../multizone.yaml` kind cluster
(Tier 1). Unlike `../../clusters/*`, this is **single-cluster and hand-authored** (not
rendered from `topology.toml`): one 4-replica `fiducia-node` group spread one-per-zone
by `topologySpread`, kind's `local-path` storage class, and a fixed NodePort so
`localhost:8090` reaches the coordination API.

- `kustomization.yaml` — the overlay wiring.
- `patches.yaml` — replica count, storage class, NodePort.
- `topology.env` — the single in-cluster peer list for the local Raft group.
