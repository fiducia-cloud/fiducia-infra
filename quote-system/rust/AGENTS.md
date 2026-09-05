# AGENTS.md — commercial Rust model projections

These instructions apply to `quote-system/rust/**` and supplement
`quote-system/AGENTS.md`, the repository-root `AGENTS.md`, and the canonical
fleet policy at `ORESoftware/my-ai/AGENTS.md`. The stricter rule wins.

- `../db/0001_commercial_intake.sql` remains the persistence authority while
  this workspace is located in `fiducia-infra`.
- TypeSpec and JSON Schema remain complementary public contract authorities.
  Never derive public API payloads from SeaORM or Diesel row structs.
- Do not hand-edit `fiducia-commercial-seaorm/src/entities/*.rs`,
  `fiducia-commercial-diesel/src/schema.rs`, or
  `fiducia-commercial-diesel/src/models.rs`; update the DDL and reviewed
  manifest, then run `scripts/model_codegen.py --write`.
- Preserve tenant-scoped composite keys, nullability, encrypted fields, opaque
  identifiers, append-only evidence, and RLS assumptions.
- Never add plaintext customer data, contract bodies, signatures, credentials,
  Cloudflare bindings, database URLs, or production identifiers.
- Do not activate migrations or production infrastructure from a model/schema
  pull request.

Required verification:

```bash
python3 -m py_compile quote-system/rust/scripts/model_codegen.py
python3 quote-system/rust/scripts/model_codegen.py --check
cargo fmt --manifest-path quote-system/rust/Cargo.toml --all -- --check
cargo check --manifest-path quote-system/rust/Cargo.toml --all-targets --all-features
cargo test --manifest-path quote-system/rust/Cargo.toml --all-features
cargo clippy --manifest-path quote-system/rust/Cargo.toml --all-targets --all-features -- -D warnings
```
