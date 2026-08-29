<!-- generated-policy: frozen -->

# `generated/` — committed, and not hand-editable

Everything in this directory is machine-written and **committed to version
control**. Do not edit these files by hand. Change the source they come from
and re-run the generator.

Typical producers:

- [`flags-2-env`](https://github.com/flags-2-env/flags-2-env-cli) (`f2e generate`) — e.g. `generated/dart/env.dart`
- [`api-docs` / `ridl`](https://github.com/oresoftware/api-docs) — route maps and clients
- JSON Schema / OpenAPI generators and interface adapters in this repository
  (e.g. `node src/generate.mjs` from `schema/tables.json`)
- the topology renderers under `tools/` in this repository

## In this tree

Checked-in artifacts produced by `tools/render.mjs` from `topology.toml`.
Regenerate with `node tools/render.mjs`; CI's `--check` fails on drift.

- `edge-regions.json` — the `FIDUCIA_REGIONS` list (each cluster's public LB
  endpoint) consumed by the Cloudflare edge (`fiducia-edge`).

(Per-cluster generated inputs — `topology.env`, `patches.yaml` — live next to each
overlay under `clusters/<name>/`, not here.)

## Why the files are read-only on disk

After generation they are frozen with `chmod a-w` (0444). Your editor will refuse
the write, which is the point — it turns "I edited the wrong file" into an error
you see immediately rather than a diff you notice in review. Directories and this
`README.md` stay writable so the generator can add and replace files.

**Git does not store this.** Git tracks only the executable bit, so every file
here is mode `100644` in the object database and a fresh clone comes back
writable. The read-only bit is a local ergonomic guard; it is *not* what
enforces the policy. Do not `chmod u+w` and then commit a hand-edit — change the
source and regenerate.

## What actually enforces the policy

CI, not the filesystem:

| Guard | Where | What it catches |
| --- | --- | --- |
| `check-generated-contract.py` | CI + pre-commit | a hand-edited or thawed file |
| regenerate-and-diff | CI | committed output that no longer matches its source |
| `post-checkout` / `post-merge` hooks | your clone | re-freezes after every checkout |

Enable the hooks once per clone:

```sh
git config core.hooksPath .githooks
```

Re-freeze at any time (both are safe and idempotent):

```sh
python3 scripts/check-generated-contract.py --freeze --require-readonly
scripts/freeze-generated.sh
```

## Regenerating

Edit the **primary source** — `topology.toml`, `.cli-flags.toml`, the route map,
`*.schema.json` — then run the generator. Generators thaw, write, and re-freeze on
their own. If you are committing a regeneration, the pre-commit guard needs to be
told so:

```sh
REGEN=1 git commit -m "Regenerate output from the updated source"
```

## JSON Schema and runtime checks

JSON Schema 2020-12 (when present under `json-schema/`) is the **contract**, and a
cross-check rather than the codegen input: generated types come from the primary IR
(topology, route map, `.cli-flags.toml`), and the schema is an independently derived
description of the same contract, so disagreement means one of them has drifted.

Runtime `validate()` / `check_os_env` / `checkOsEnv` / `f2e check-contract` must pass
on real payloads, not only on types that compile. Unit tests should feed **valid**
and **invalid** instances (missing required keys, wrong types, extra properties).

```sh
f2e check-contract --config .cli-flags.toml --json env.fixture.json
```

## Gitignored trees

If a `generated/` folder is listed in `.gitignore`, its artifacts stay local and the
tree's policy is `ignored`, not `frozen`. Keep the README tracked with:

```
generated/*
!generated/README.md
```

(Do not ignore the directory node itself as `generated/` — that prevents the
`!README.md` exception from working.)
