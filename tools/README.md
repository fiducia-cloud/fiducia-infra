# tools — topology renderer & cluster tooling

The scripts that turn the declarative `topology.toml` into deployable inputs and stand
up / mesh the clusters.

- `render.mjs` — fans `topology.toml` out into each cluster's `topology.env` + `patches.yaml`
  and `generated/edge-regions.json`; `--check` fails CI on staleness.
- `render.test.mjs` — renderer self-tests (no writes, no network).
- `rollout.test.mjs` — asserts the rollout runbook's Kubernetes guarantees are encoded in `base/`.
- `clustermesh.sh` — bootstraps Cilium Cluster Mesh across the clusters (cross-cluster Raft connectivity).
- `kind-up.sh` / `kind-down.sh` — create/tear down the local kind test cluster (Tier 1).

Run the tests with `node --test tools/*.test.mjs`.
