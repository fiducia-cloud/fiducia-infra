# Infrastructure modules

This repository uses `modules/` as the canonical provider-module root and `environments/` for composition/state boundaries.

```text
modules/
  cloudflare/
    <worker-or-site>/
      wrangler.toml | wrangler.json | wrangler.jsonc
  neon/
    neon.ts
  supabase/
    config.toml
    migrations/
    functions/
environments/
  preview/
  staging/
  production/
```

## Provider-native Git sync

- **Supabase:** set the GitHub integration **Working directory** to `modules`. Supabase expects a `supabase/` child of that working directory, so it resolves `modules/supabase/` automatically.
- **Cloudflare Workers/Pages:** set the project **Root directory** to `modules/cloudflare` for a single project, or preferably `modules/cloudflare/<worker-or-site>` for each independently deployed Worker/Page. Use build watch paths to avoid unrelated monorepo changes triggering every project.
- **Neon:** treat `modules/neon` as the Neon project root. Run/link Neon from that directory (`working-directory: modules/neon` in CI) so `neon.ts` is discovered there. If a repo-level tool insists on starting at the Git root, add a thin root `neon.ts` adapter that re-exports the canonical `modules/neon/neon.ts`; do not duplicate configuration.

`.ores-infra.toml` records these canonical paths for `oresc`/automation, but it does not replace provider-native dashboard/Git settings.

## State and dependency rules

Keep state isolated per provider/environment rather than sharing one monolithic state. Environment roots may compose provider modules, but provider modules must remain independently plannable/testable. Apply database/control-plane infrastructure before schema migrations and edge/application routing that depends on it.
