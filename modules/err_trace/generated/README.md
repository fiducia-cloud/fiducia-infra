<!-- generated-policy: frozen -->

# ORES error-trace generated storage projection

Files in this directory are generated artifacts. **Do not hand-edit them.**

## Source authority

The structural authorities live in `ORESoftware/ores-err-trace` and are independently authored peers:

- `contracts/typespec/main.tsp`
- `contracts/json-schema/contract.schema.json`

This rollout currently pins:

- authority commit: `abdc25469c224bef0c9a4c2c8e3a504d549d68a5`
- storage-generator candidate: `bc985ffe1fec66887a4c92c8c13fad804c69882d` (`ORESoftware/ores-err-trace#7`)
- TJSV: `a9db1298cd4c993744a7b24bbc8f0ae9d1d0a33a`

Generated SQL/ORM files are projections, not source contracts.

## Regeneration and merge gate

Before this rollout leaves draft, rebuild a parity-admissible TJSV Contract IR from both authorities, run `scripts/generate-storage-projections.mjs` from the pinned `ores-err-trace` source, and verify PostgreSQL, Diesel, and SeaORM outputs agree with the generated projection manifest.

Do not resolve parity differences by editing files in this directory. Fix the source authorities or generator, regenerate all projections, and update the pinned provenance together.

The PostgreSQL file currently vendored here is a rollout candidate and remains subject to that regeneration/parity gate.
