# Supabase infrastructure boundary

This directory is the infrastructure-as-code entry point for Supabase-backed
Fiducia environments. The canonical provider migrations and schema contract
live in [`fiducia-supabase`](https://github.com/fiducia-cloud/fiducia-supabase);
this layer owns environment wiring, project selection, and deployment policy.

## Invariants

- Each environment maps to its own Supabase project reference; never reuse a
  project ref across customer, admin, test, or recovery environments.
- Project refs and migration metadata may be committed, but access tokens,
  service-role keys, JWT secrets, and database URLs must arrive through the
  encrypted `env/enc/` contract or the CI secret store.
- Apply migrations only through the reviewed provider overlay and its
  validation suite. Do not edit generated SQL copies by hand.
- Production deployment remains gated on hosted verification and an explicit
  operator approval.

Provider-specific Terraform, CLI, or deployment modules should be added here
without duplicating the canonical migrations.
