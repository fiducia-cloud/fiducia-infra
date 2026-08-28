# generated — machine-written outputs

Checked-in artifacts produced by `tools/render.mjs` from `topology.toml`. **Do not
hand-edit** — regenerate with `node tools/render.mjs` and let CI's `--check` catch drift.

- `edge-regions.json` — the `FIDUCIA_REGIONS` list (each cluster's public LB endpoint)
  consumed by the Cloudflare edge (`fiducia-edge`).

(Per-cluster generated inputs — `topology.env`, `patches.yaml` — live next to each
overlay under `clusters/<name>/`, not here.)
## Read-only on disk

Generated adapters are `chmod a-w` (0444) after the producer runs.
Git does not store the Unix write bit; restore with the generator
or `scripts/freeze-generated.sh`.

## JSON Schema and runtime checks

JSON Schema 2020-12 (when present under `json-schema/`) is the
contract. Runtime `validate()` / `check_os_env` / `f2e check-contract`
must pass on real payloads, not only at compile time. Unit tests
should include valid and invalid instances.
