# Terraform root/child module contract

This infrastructure repository uses two Terraform layers with different responsibilities.

## `modules/` — reusable child modules

`modules/*` contains reusable, parameterized Terraform logic. Child modules should be environment-agnostic: accept values through variables, expose useful outputs, and declare provider requirements when needed. They must not own Terraform backends or state, and they should not contain environment-specific `*.tfvars` files or hard-coded staging/production identities.

Provider authentication and normal provider configuration belong in the calling root module. If a resource graph is needed by two or more environments, prefer promoting that graph into a child module rather than copying it between environment roots.

## `environments/<environment>/` — root modules and state boundaries

Each environment directory is an independent Terraform root module. Run Terraform from that directory, for example:

```sh
terraform -chdir=environments/staging init
terraform -chdir=environments/staging plan
terraform -chdir=environments/production init
terraform -chdir=environments/production plan
```

Environment roots own backend/state configuration, provider wiring, environment values, and composition of child modules via sources such as `../../modules/cloudflare`.

A root module may also define resources directly when they genuinely exist only in that environment. For example, a production-only compliance archive bucket can live directly in `environments/production/*.tf`. If that resource pattern later becomes shared, move it into a child module and use Terraform `moved` blocks when required to preserve resource addresses/state.

## Provider-native repository integrations

The `.ores-infra.toml` file is the repository discovery contract. Its `modules_dir = "modules"` and `environments_dir = "environments"` values identify the Terraform convention, while the provider sections identify native Supabase, Cloudflare, and Neon locations.

Provider-native repository integrations are separate from Terraform module resolution. Supabase GitHub integration should point its working directory at the parent containing the native `supabase/` directory. Terraform CI/CD should invoke Terraform from the appropriate `environments/<environment>` root; Terraform will resolve local child modules from there.

## Invariants

- `modules/*` are child modules, not independently stateful deployments.
- `environments/*` are root modules and independent state/blast-radius boundaries.
- Backends are forbidden in child modules.
- Terraform state and `.terraform/` data are never committed.
- Environment-only resources may coexist with `module` calls in an environment root.
- Shared resource graphs should be parameterized and promoted into `modules/`.
- Native provider folders do not change which Terraform directory is the root module.
