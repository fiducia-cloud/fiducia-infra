# Supabase GitOps boundary

This `supabase/` directory is the reviewed infrastructure-as-code boundary for Supabase resources owned by this repository. Existing provider-specific overlays and migration subtrees remain authoritative; this policy does not duplicate or regenerate them.

## GitOps invariants
- Commit non-secret project refs, migration provenance, provider configuration, schemas, and deployment policy. Access tokens, service-role keys, JWT secrets, passwords, and database URLs come only from encrypted environment material or CI secret stores.
- Treat migrations as append-only reviewed changes. Validate on an isolated project or branch before promotion; do not hand-edit a shared remote database to bypass reviewed migration history.
- Keep provider-local CLI state such as `.temp/` and `.branches/` out of Git.
- Serialize production promotion in CI, require hosted verification and repository/environment approval policy, and record provider/migration provenance needed to reproduce the deployment.
- If canonical SQL is owned by a separate provider overlay, reference that authority here instead of copying generated SQL.

Cross-runtime infrastructure contracts are admitted by `oresc audit repo --profile infra`, which runs TJSV against `contracts/infra-gitops`.
