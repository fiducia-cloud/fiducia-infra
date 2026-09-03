# Generated contract artifacts

Files created in this directory are derivative build artifacts. **Do not edit them directly.**

Run the generator from `quote-system/`:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run contracts:generate
```

The generator writes these read-only files:

- `payload-types.ts`, generated independently from `contracts/commercial-intake.schema.json` and preserving exact JSON wire names plus validation annotations;
- `api-operations.ts`, generated from `contracts/main.tsp` through the locked TypeSpec OpenAPI JSON emitter;
- `contract-manifest.json`, recording deterministic source hashes, document discriminators, definitions, operations, audiences, required headers, and response status families.

TypeSpec and JSON Schema remain complementary canonical inputs. Neither source is generated from the other. A discrepancy must fail the build and be reviewed rather than silently choosing one authority.

The generated files are ignored by Git and set to mode `0444`. Regenerate them instead of changing permissions or editing them in place. Promotion into a published SDK or language-specific client repository requires a separate reviewed release change.
