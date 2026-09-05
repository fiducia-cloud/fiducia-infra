# Neon infrastructure boundary

This directory is the infrastructure-as-code entry point for Neon Postgres
projects and branches used by Fiducia. It complements the Supabase provider
overlay: Neon is used for branchable Postgres workloads, while Supabase remains
the provider overlay for hosted auth/database integrations where configured.

## Invariants

- Treat every Neon branch as an isolated environment. Development, CI,
  staging, production, and recovery branches must have distinct identifiers.
- Keep project IDs, branch names, and non-secret topology metadata in reviewed
  configuration; inject `NEON_API_KEY`, `DATABASE_URL`, and passwords only at
  runtime from encrypted environment or CI secrets.
- Prefer branch-first migrations and verify schema compatibility before
  promoting a branch. Never rewrite a shared branch or commit connection
  strings.
- Record provider state and migration provenance so a promotion can be
  reproduced and audited alongside the Supabase overlay.

Terraform modules, Neon CLI wrappers, and environment-specific overlays belong
here. Shared SQL contracts remain owned by `fiducia-interfaces` and the
provider repositories rather than being copied into this directory.
