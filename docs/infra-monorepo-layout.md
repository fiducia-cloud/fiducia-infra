# Infrastructure monorepo layout

Reusable infrastructure may live under `modules/`, but provider Git sync must always terminate at a provider-native entrypoint. Providers are never expected to discover the ORESoftware `modules/` convention by themselves.

## Provider-facing sync roots

- **Supabase:** the configured Working directory must contain a child `supabase/` directory. Prefer repo working directory `.` with root `supabase/`; for multiple projects use distinct working directories, each with its own `supabase/` child.
- **Cloudflare:** each Worker/Pages build uses the provider Root directory containing its Wrangler/project configuration. Multi-Worker repos should use explicit roots such as `workers/<worker>/` or `cloudflare/<worker>/`. If a root consumes `modules/cloudflare/`, include that shared path in the provider build watch paths.
- **Neon:** use a `neon.ts` config-as-code entrypoint in the linked project root. It may import reusable policy from `modules/neon/`; local `.neon` link metadata stays machine-local.

## Recommended shape

```text
.
├── .ores-infra.toml
├── supabase/
├── neon.ts
├── cloudflare/ or workers/
├── modules/
│   ├── cloudflare/
│   ├── supabase/
│   └── neon/
└── environments/
    ├── dev/
    ├── staging/
    └── production/
```

Provider-facing files are adapters, not a second authority. If a provider format cannot import shared modules directly, keep the deployable native tree where that provider expects it and keep only reusable helpers/templates under `modules/`.

## State, ordering, and CI

Keep state isolated per deploy/environment root; never use one repo-wide local state file. Path-filtered CI should plan affected roots only, but shared-module changes must fan out to every consuming sync root. Provision database infrastructure first, verify health, then run migrations, then promote edge/routing changes.

A module is not considered deployable until a committed provider-native sync root can see it. Mirrors, generated snapshots, and sibling application monorepos are not provider deploy sources. This rollout establishes layout/discovery metadata only; it does not connect providers or apply live infrastructure.
