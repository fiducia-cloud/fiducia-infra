<!-- generated-policy: frozen -->

# ORES error-trace generated storage projection

Files in this directory are generated evidence. **Do not hand-edit the PostgreSQL projection.**

## Exact provenance

- source: `ORESoftware/ores-err-trace@dbcee673aef6a3dbc478d28a87715871b4cd9584`
- TypeSpec blob: `6536556490bd3f7556f78fd4533335cd3da21a43`
- JSON Schema blob: `f52ec9f0ca9512edb5c45f9b028f86cc3a1d7889`
- generator blob: `3bfb0a3e7b48aecdaff32a2e125fb53292873bde`
- TJSV: `db0f1e66b2a65cad43c909aa558ae00c6a91578c`
- Contract IR: `33049ebc66627573e47dd707ce25a9f78e5074c240a0eb5d82f5d23a19863e01`
- parity receipt run: `a416cf986bcb48c2332e12d20bb358fe300ea470867ec41b87d3ec9244172356`
- funded proof: `fiducia-cloud/fiducia-infra#228`, workflow run `36269011099`, artifact `10915041704`

The proof rebuilt parity from both independently authored authorities, re-verified the admitted Contract IR, generated PostgreSQL/Diesel/SeaORM in one pass, ran deterministic regeneration with `--check`, and verified each output SHA-256 against `projection-manifest.json`.

This repository vendors the PostgreSQL output as `20260916_ores_err_trace.postgres.sql`. Diesel and SeaORM are not runtime inputs here; their exact hashes remain pinned in the manifest so cross-projection drift is detectable.
