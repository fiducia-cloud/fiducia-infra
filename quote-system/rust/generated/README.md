<!-- generated-policy: frozen -->

# Generated Rust model manifest

`model-manifest.json` is committed comparison evidence produced by
`quote-system/rust/scripts/model_codegen.py`. Do not edit the manifest or the
language projections derived from it by hand.

The generator reconciles three reviewed authorities:

- `quote-system/db/0001_commercial_intake.sql` for persistence shape;
- `quote-system/contracts/main.tsp` for transport-facing TypeSpec models;
- `quote-system/contracts/commercial-intake.schema.json` for portable payload validation.

Regenerate from the repository root:

```bash
python3 quote-system/rust/scripts/model_codegen.py --write
python3 quote-system/rust/scripts/model_codegen.py --check
```

The manifest contains structural names, PostgreSQL types, nullability, and key
shape only. It must never contain customer data, contract bodies, signatures,
credentials, deployment identifiers, or decrypted environment values.

This tree is `frozen`: generated payloads are committed and made read-only by
`scripts/check-generated-contract.py --freeze --require-readonly`. Git does not
preserve the local read-only bit, so CI regeneration and drift checks are the
authoritative enforcement boundary.
