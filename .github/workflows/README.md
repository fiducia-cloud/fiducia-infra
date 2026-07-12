# workflows — CI pipelines

GitHub Actions for the infra repo. Nothing here applies to a real cluster; CI only
renders and validates.

- `ci.yml` — runs the `tools/render.mjs` self-tests, checks that the generated
  per-cluster inputs are not stale vs `topology.toml`, `kubectl kustomize`-builds
  every overlay (real clusters + the local kind tier), and `terraform fmt`/`validate`s
  the modules and e2e env. The kind e2e job is `workflow_dispatch`-gated because it
  needs a built `fiducia-node` image.
- `cli-flags.yml` — audits `.cli-flags.toml` against the flags-2-env submodule so
  documented CLI flags stay in sync; runs only when the flag config or tooling changes.
