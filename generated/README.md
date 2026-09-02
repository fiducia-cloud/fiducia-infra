<!-- generated-policy: frozen -->

# Generated files — read-only

Do **not** hand-edit files in this directory. They are produced by tooling such as:

- `node tools/render.mjs` from `topology.toml` (this repo's primary producer)
- https://github.com/flags-2-env/flags-2-env (typical Dart path: `generated/dart/env.dart`)
- https://github.com/oresoftware/api-docs
- JSON Schema / OpenAPI / route-map generators in this repository

Checked-in artifacts:

- `edge-regions.json` — the `FIDUCIA_REGIONS` list (each cluster's public LB endpoint)
  consumed by the Cloudflare edge (`fiducia-edge`).

Per-cluster generated inputs (`topology.properties`, `patches.yaml`) live next to each
overlay under `clusters/<name>/`, not here. Regenerate with `node tools/render.mjs`
and let CI `--check` catch drift.

## Disk permissions

After generation, files here are frozen with `chmod a-w` (not writable). Directories
and this `README.md` stay writable so generators can replace files.

Git does **not** persist the write bit (only the executable bit). A fresh clone is
writable until you re-freeze:

```sh
scripts/freeze-generated.sh
```

To regenerate, change the **primary source** (`topology.toml`, `.cli-flags.toml`,
route map, OpenAPI, `schema/*.schema.json`, …) and re-run the generator. Preferred
generators thaw, write, then `chmod a-w` themselves.

## Gitignored trees

If `generated/` is in `.gitignore`, generated artifacts stay off VCS. Still commit
this `README.md` (`git add -f generated/README.md` or a `.gitignore` exception) so
the freeze policy is visible. Example exception:

```
generated/**
!generated/README.md
```

## Runtime contract (not just compile-time)

JSON Schema 2020-12 (when present under `json-schema/`) is a **cross-check**, not
always the primary generator input. Runtime `validate()` / `check_os_env` /
`f2e check-contract` must pass on real payloads, not only at compile time. Unit
tests should include valid and invalid instances and compare schema keys to
`.cli-flags.toml` env names or route-map keys when those exist.
