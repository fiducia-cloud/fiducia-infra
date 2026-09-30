<!-- generated-policy: frozen -->

# ORES error-trace generated storage projection

Files in this directory are generated evidence. **Do not hand-edit the PostgreSQL projection.**

## Exact provenance

- source: `ORESoftware/ores-err-trace@3cf3e9e5b9824eeed65d1c0e1b8f094a1a568f8c`
- TypeSpec blob: `a4b8bfb815fbbc3581ddfc50ab14f4a47077da5d`
- JSON Schema blob: `7b8a1a6aa2f3a1bb439e5c4f42eb9f3f25e1a718`
- generator blob: `ab5dc743f2c03f5f84e2a4dd21c2af0a42ff898e`
- TJSV: `db0f1e66b2a65cad43c909aa558ae00c6a91578c`
- Contract IR: `dad1106974d7ccfd23357a5f4881a45ec738393ed497aae609cacce3a3e06a29`
- parity receipt run: `d15d2d949da26c6bd0d68581fc1b1e18c1bfd615b92d37132d041e64341c8259`
- funded proof: `fiducia-cloud/fiducia-infra#234`, workflow run `36293322242`, artifact `10922404809`, digest `sha256:a8c6ac34a65b736c5dfdd648f4c8922ffc2acd0ef2087054a7503566d8c39b3a`

The proof rebuilt parity from both independently authored authorities, re-verified the admitted Contract IR, generated PostgreSQL/Diesel/SeaORM in one pass, ran deterministic regeneration with `--check`, and verified native Rust, Go, TypeScript, and Gleam surfaces. The admitted event projection now carries `parent_trace_id`, `otel_trace_id`, and `otel_span_id`, with a native OTel trace lookup index; the peer contract also requires an OTel trace whenever an OTel span is supplied.

This repository vendors the PostgreSQL output as `20260927_ores_err_trace.postgres.sql`. Diesel and SeaORM are not runtime inputs here; their exact hashes remain pinned in the manifest so cross-projection drift is detectable.
