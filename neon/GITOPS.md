# Neon GitOps boundary

This `neon/` directory is the reviewed infrastructure-as-code policy and overlay boundary for Neon projects and branches owned by this repository. Existing repo-specific Neon subtrees remain authoritative.

## GitOps invariants
- Treat each Neon branch as an isolated environment identity. Development, CI, staging, production, and recovery branches/projects must not be silently reused across trust boundaries.
- Commit non-secret project IDs, branch names/policy, topology, and promotion provenance. `NEON_API_KEY`, passwords, connection strings, and `DATABASE_URL` come only from encrypted environment material or CI secret stores.
- Plan before apply. Perform migrations branch-first, verify schema compatibility, and promote through protected CI rather than mutating a shared branch out of band.
- Provider-native root configuration such as `neon.ts` may remain where the Neon CLI expects it while importing repository-owned implementation from `neon/`.
- Keep dotenv and local `.neon` state out of Git.

Cross-runtime infrastructure contracts are admitted by `oresc audit repo --profile infra`, which runs TJSV against `contracts/infra-gitops`.
