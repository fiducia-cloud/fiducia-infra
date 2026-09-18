# tools — topology renderer & cluster tooling

The scripts that turn the declarative `topology.toml` into deployable inputs and stand
up / mesh the clusters.

- `render.mjs` — fans `topology.toml` out into each cluster's `topology.env` + `patches.yaml`
  and `generated/edge-regions.json`; `--check` fails CI on staleness.
- `render.test.mjs` — renderer self-tests (no writes, no network).
- `render-vcluster-hetzner-e2e.mjs` — validates the exactly-three-member logical
  Hetzner topology and generates the tenant overlays and loopback endpoint map.
- `render-hetzner-e2e-release.mjs` — renders a selected `vcluster` (default) or
  optional `vm` profile to an external directory and replaces every Fiducia
  workload image with an immutable GHCR digest.
- `vcluster-hetzner-e2e.test.mjs` — guards topology, service replication,
  isolation controls, immutable images, and fail-closed lifecycle confirmations.
- `rollout.test.mjs` — asserts the rollout runbook's Kubernetes guarantees are encoded in `base/`.
- `clustermesh.sh` — bootstraps Cilium Cluster Mesh across the clusters (cross-cluster Raft connectivity).
- `kind-up.sh` / `kind-down.sh` — create/tear down the local kind test cluster (Tier 1).

Run the tests with `node --test tools/*.test.mjs`.
