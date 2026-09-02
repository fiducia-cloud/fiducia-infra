# Fiducia commercial Rust model projections

This workspace binds the existing Fiducia commercial-intake contract to Rust
persistence libraries without turning database rows into public API payloads.

## Authority map

| Concern | Canonical source | Rust projection |
| --- | --- | --- |
| HTTP operations and cross-language transport models | `../contracts/main.tsp` | exposed as source by `fiducia-commercial-contracts` |
| Portable payload validation and fixtures | `../contracts/commercial-intake.schema.json` (JSON Schema Draft 2020-12) | exposed as source by `fiducia-commercial-contracts` |
| PostgreSQL tables, constraints, RLS, append-only rules, and indexes | `../db/0001_commercial_intake.sql` | generated SeaORM and Diesel crates |
| Consumer feature boundary | this workspace | `fiducia-commercial-models` |

The model generator currently projects **22 tables and 244 columns**, including
pre-interest registration, full applications, attachments, support plans,
SLA policies, versioned quotes and line items, contract references and
acceptances, idempotency records, workflow events, and the outbox.

The encrypted `*_ciphertext` and opaque/hash fields are deliberately preserved.
Neither ORM crate contains plaintext application, contact, contract, signature,
or credential data.

## Crates

- `fiducia-commercial-contracts`: compile-time access to the existing TypeSpec,
  JSON Schema, and PostgreSQL sources; it does not copy them.
- `fiducia-commercial-seaorm`: generated SeaORM entities for every table.
- `fiducia-commercial-diesel`: generated Diesel `table!` declarations and
  queryable/identifiable row structs for every table.
- `fiducia-commercial-models`: thin feature-gated facade with `sql-models`,
  `seaorm-models`, `diesel-models`, and `all-models`.

Composite keys, PostgreSQL nullability, `jsonb`, `numeric(24,6)`,
`timestamptz`, fixed-width currency/country columns, and non-sequential text
identifiers are retained in both ORM projections. Cross-table relations remain
enforced by the canonical DDL; they are intentionally not re-expressed as
single-column ORM associations because most Fiducia foreign keys are
tenant-scoped composites.

## Regeneration and verification

After an intentional DDL change:

```bash
python3 quote-system/rust/scripts/model_codegen.py --write
python3 quote-system/rust/scripts/model_codegen.py --check
cargo fmt --manifest-path quote-system/rust/Cargo.toml --all -- --check
cargo check --manifest-path quote-system/rust/Cargo.toml --all-targets --all-features
cargo test --manifest-path quote-system/rust/Cargo.toml --all-features
cargo clippy --manifest-path quote-system/rust/Cargo.toml --all-targets --all-features -- -D warnings
```

`--write` refuses to run unless the checked-in model manifest exactly matches
the SQL table, column, type, nullability, and primary-key shape. `--check` also
verifies the required TypeSpec models and JSON Schema definitions before
comparing all generated Rust outputs byte-for-byte. Checked-in generated Rust
must remain `cargo fmt`-normalized, and both generation drift and formatting
checks must pass on the exact pull-request head.

### Deterministic rendering contract

The renderer emits Rust in the canonical layout expected by the pinned Rustfmt
toolchain, including multiline SeaORM and Diesel attributes where Rustfmt would
wrap them. This keeps regeneration, formatting, Clippy, and checked-in output in
one agreement instead of relying on a second manual formatting commit.

Python bytecode and `__pycache__` directories are ignored as local build
artifacts. They are not source, generated-model evidence, or permitted inputs to
the bounded projection diff.

## Ownership and extraction

This code is colocated with the current canonical quote-system contract because
the planned `fiducia-cloud/fiducia-lib-core` repository does not yet exist in
the connected GitHub installation. The workspace is extraction-ready: no
production Cloudflare binding, deployment value, credential, customer record,
or runtime activation is included. When `fiducia-lib-core` is provisioned, move
this workspace and the canonical persistence source together, keep
`fiducia-lib` as a thin facade, and replace this location with a pinned
provenance pointer rather than maintaining two authorities.

Follow this repository's `AGENTS.md`, `quote-system/AGENTS.md`, and the canonical
fleet policy in `ORESoftware/my-ai/AGENTS.md`. Never hand-edit generated files.
