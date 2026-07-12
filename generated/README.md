# generated — machine-written outputs

Checked-in artifacts produced by `tools/render.mjs` from `topology.toml`. **Do not
hand-edit** — regenerate with `node tools/render.mjs` and let CI's `--check` catch drift.

- `edge-regions.json` — the `FIDUCIA_REGIONS` list (each cluster's public LB endpoint)
  consumed by the Cloudflare edge (`fiducia-edge`).

(Per-cluster generated inputs — `topology.env`, `patches.yaml` — live next to each
overlay under `clusters/<name>/`, not here.)
