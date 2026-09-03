# Dual-authority contract generation

The Fiducia quote and pre-interest boundary intentionally keeps two independent canonical sources:

- `contracts/main.tsp` owns HTTP paths, methods, headers, request/response transport models, public versus administrative audiences, and cross-language transport generation;
- `contracts/commercial-intake.schema.json` owns Draft 2020-12 payload validation, exact JSON wire names, fixtures, document discriminators, and compatibility constraints.

Neither source is generated from the other. This prevents one compiler path from masking a mistake in the other. Build-time generation produces reviewable evidence from both sources and stops on discrepancies.

## Commands

Run from `quote-system/` with Node 22:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run contracts:test
npm run contracts:lint
npm run contracts:generate
```

`contracts:test` runs unit and negative-policy tests for the generator. `contracts:lint` compiles TypeSpec with warnings denied, validates both source documents, and renders all generated artifacts in memory. `contracts:generate` writes the artifacts beneath `generated/`.

## Generated artifacts

`payload-types.ts` is generated from JSON Schema. It preserves snake_case wire properties exactly and emits JSDoc annotations for formats, patterns, lengths, numeric bounds, array bounds, and uniqueness. TypeScript types do not replace runtime validation; services and clients must still validate untrusted payloads against the JSON Schema boundary.

`api-operations.ts` is generated from TypeSpec through the locked OpenAPI JSON emitter. It records operation IDs, HTTP methods, versioned paths, public/admin audiences, required headers, request component names, success component names, and success/error status families.

`contract-manifest.json` binds both inputs with SHA-256 hashes and records the generated document/operation inventory. It is deterministic and contains no timestamps, environment identifiers, customer data, credentials, or production bindings.

Generated files are mode `0444` and ignored by Git. They are derivative and must not be edited directly. A dedicated SDK publication change may copy reviewed generated output into the appropriate client repository, but that promotion must retain source hashes and run its own language compiler/tests.

## Lint and annotation policy

The generator fails when:

- JSON Schema is not Draft 2020-12, has an unresolved/external reference, duplicate discriminator, open data object, invalid `required` entry, empty combinator, or colliding generated TypeScript name;
- a TypeSpec/OpenAPI operation lacks a stable `operationId`, versioned `/v1/` path, success/error response family, or required JSON body declaration;
- any write omits `Idempotency-Key`;
- a transition/update omits `If-Match`;
- a path placeholder and declared path parameter disagree;
- routing is attempted through query parameters or arbitrary request headers;
- public and administrative operations are not both present;
- repeated generation from identical inputs produces different bytes.

Only `Idempotency-Key` and `If-Match` are transport-control headers at this contract boundary. Authentication and authorization are enforced by their separate public/admin audiences and deployment middleware; they are not routing selectors.

## Release boundary

This toolchain generates interfaces and static-analysis evidence only. It does not activate DNS, Cloudflare routes, Workers, databases, quotes, signatures, customer records, or production services. Runtime deployment remains fail-closed and requires the release gates in `README.md`.
