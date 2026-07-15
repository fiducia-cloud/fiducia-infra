# clusters

Per-cluster kustomize overlays — one directory per platform (`gcp/`, `aws/`,
`hetzner/`, `azure/`). Everything in them (`topology.env`, `patches.yaml`) is
GENERATED from `../topology.toml` by `tools/render.mjs`; edit the TOML and
re-render, never the outputs (CI fails on staleness via `npm run check`).
`azure/` is node-only (`brain=false`) so the brain group stays odd-sized.
