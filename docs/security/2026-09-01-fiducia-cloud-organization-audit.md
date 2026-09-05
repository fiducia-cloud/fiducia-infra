# Fiducia Cloud organization security and configuration audit

**Audit date:** 2026-09-01 (America/New_York)  
**Tracking:** DEN-3512, DEN-1378, DEN-78, DEN-1390, DEN-1404, DEN-4058, DEN-4014, DEN-4134, DEN-4233  
**Primary remediation:** fiducia-cloud/fiducia-infra#52

## Executive summary

This review covered the repositories returned by the authenticated `fiducia-cloud`
organization inventory, the organization policy repository, repository-local agent
contracts, open hardening pull requests, and the related Linear backlog. It focused
on source-visible security defects, configuration/secrets boundaries, CI supply-chain
controls, authentication fail-closed behavior, reliability evidence, and launch
readiness.

The highest-confidence defect found in this pass was a broken configuration boundary
inside `fiducia-infra`: non-secret topology files used the secret-shaped
`topology.env` name. The keyless verifier correctly treated those tracked files as
plaintext environment files, while the first partial rename left sixteen remaining
paths and stale readers. PR #52 now completes the migration to
`topology.properties`, updates every tracked textual reference, limits encrypted
configuration to the exact development and production ciphertext files, and pins the
CI tooling used to verify the boundary.

No plaintext age identity was found by the available organization code-search query,
but that search reported incomplete results and is not a substitute for GitHub secret
scanning, push protection, history scanning, or an administrator export of security
alerts. This audit therefore does **not** claim that the organization is free of
secrets or vulnerabilities.

## Standards and policy basis

The review applies these requirements:

- Repository-local `AGENTS.md`/`agents.md` first, then the fleet-wide contract in
  `ORESoftware/my-ai`.
- Twelve-factor configuration: deployment-varying values are runtime configuration,
  separated from code, and expressed as granular orthogonal settings.
- Twelve-factor dependencies and logs: dependencies are explicitly declared and
  isolated; applications emit event streams rather than owning log routing.
- 22-factor extensions: secure-by-default and least-privilege access, resilience and
  SLO evidence, API-first contracts, privacy/data minimization, automated governance,
  supply-chain integrity, and explicit typed failure behavior.
- Fiducia organization baseline: immutable action pins, least-privilege workflow
  permissions, checkout credentials disabled unless a reviewed write step needs
  them, timeouts, repository-local tests, protected branches, vulnerability alerts,
  and automated security fixes.

## Completed remediation in PR #52

### 1. Separate secret material from ordinary configuration

- Only `env/enc/dev.env.enc` and `env/enc/prod.env.enc` are in the encrypted runtime
  configuration contract.
- Decrypted files remain under ignored `env/dec/` paths and are never committed.
- Non-secret topology inputs now use the `.properties` suffix rather than an `.env`
  suffix, so they no longer masquerade as secret-bearing environment files.
- Every tracked `topology.env` path and every tracked textual reference was migrated;
  the migration failed closed on rename collisions or remaining references.

### 2. Repair the keyless CI audit

- The secrets audit uses the reviewed `ores-sops` verifier rather than duplicating a
  weaker repository-local policy.
- Downloaded verifier material is pinned and integrity-checked before execution.
- External GitHub Actions in the changed workflow are pinned to immutable commit
  SHAs.
- The workflow exercises the exact development and production ciphertext paths.

### 3. Preserve behavior while changing file classification

The one-shot migration executed the repository's behavior and rendering gates before
committing:

```text
npm test
npm run check
npm run check:laptop
npm run check:vcluster
node tools/render-hetzner-e2e.mjs --check
git diff --check
```

The one-shot workflow deleted itself in the same successful commit, leaving no
permanent write-enabled migration automation behind.

## Findings and required follow-up

| ID | Severity | Finding | Status / required action |
|---|---:|---|---|
| FC-SEC-001 | High | Secret-shaped non-secret files caused the authoritative plaintext-env audit to fail and created an incentive to weaken the verifier. | **Fixed in PR #52.** Keep topology and other public configuration in explicitly non-secret formats. |
| FC-SEC-002 | High | The initial PR #52 migration changed only a subset of topology files and left stale readers. | **Fixed in PR #52.** The completed migration covers all tracked paths and references and runs the full topology gate. |
| FC-SEC-003 | High | Organization policy documents strong workflow controls, but the shared `.github` repository cannot inject or enforce them in sibling repositories. | Audit every active repository for explicit permissions, job timeouts, full-SHA action pins, `persist-credentials: false`, and branch/ruleset enforcement. Track closure under DEN-608 and DEN-4233. |
| FC-SEC-004 | High | Open dependency-update PRs include large runtime/action jumps and at least one malformed-looking digest-length change. Dependency freshness is not the same as a verified security fix. | Verify provenance, exact commit/digest shape, release notes, and tests before merging. Never bulk-merge solely because Dependabot opened a PR. |
| FC-SEC-005 | Medium | `fiducia-mcp-server.rs#35` and `fiducia-node-sidecar.rs#31` bake a cluster-specific OTLP collector address into application images. This is deployment configuration and creates a magic infrastructure string in the build artifact. | Remove the collector endpoint from Dockerfile `ENV`; inject it from deployment configuration. Keep non-secret runtime defaults documented and keep credentials only in encrypted/secret stores. |
| FC-SEC-006 | High | Authentication strict-mode and fallback removal remain open in DEN-78. | Require fail-closed production startup, audited issuer/audience checks, no legacy fallback, and boundary tests before production enablement. |
| FC-SEC-007 | High | The managed-service contract is blocked on missing production SLI/SLO evidence in DEN-1404. | Emit availability, latency, saturation, lock/lease correctness, and recovery evidence; bind remedies and support tiers only to measurable SLOs. |
| FC-SEC-008 | Medium | Rescue/WIP pull requests and old unfinished work remain distributed across repositories. | Reconcile under DEN-4134 and DEN-4233: merge only validated work, close superseded branches, and preserve ownership/evidence in Linear. |
| FC-SEC-009 | High | Quote, pre-interest, application, contract, support, and SLA/SLO intake are not yet one canonical versioned API/data contract. | Complete DEN-4058 and DEN-4014 with shared interfaces, validation, privacy/retention rules, idempotency, audit events, and a single quote/application lifecycle. |
| FC-SEC-010 | Medium | The available code-search result for an age private-key marker was incomplete, and the connector could not export Dependabot/security alerts. | An organization administrator must separately review GitHub secret scanning, push protection, private vulnerability reporting, code scanning, dependency alerts, rulesets, GitHub App scopes, and audit-log events. |

## Configuration classification

Use this classification consistently across repositories:

| Class | Examples | Storage and delivery |
|---|---|---|
| Secret | signing keys, database credentials, API tokens, webhook secrets, age identities | Encrypted `env/enc/<environment>.env.enc` at rest where repository storage is required; decrypt only to ignored `env/dec/` or deliver through the platform secret store. Never commit plaintext. |
| Deployment configuration | service URLs, collector endpoints, tenant IDs, feature flags, timeouts, limits | Runtime environment/flags generated from a centralized typed configuration map. Do not bake environment-specific values into binaries or images. |
| Public static configuration | topology labels, public hostnames, region catalogs, non-sensitive routing metadata | Typed checked-in formats such as `.properties`, JSON, YAML, CUE, or schema-backed manifests; avoid `.env` suffixes so security tooling can remain strict. |
| Code constant | protocol versions, invariant bounds, algorithmic defaults that do not vary by deploy | Named typed constants close to the owning domain module, with tests and documentation. |

Every executable should expose one authoritative typed map of supported flags and
environment variables, resolve it once at the process boundary, validate it, and pass
an immutable configuration object into the application. Libraries must not perform
ambient environment reads.

## Quote, interest, application, and managed-service security boundary

The launch workflow must use a versioned contract shared by the public web surfaces,
API servers, admin tools, and billing/support systems. At minimum it must provide:

- anonymous or authenticated pre-interest registration with explicit consent;
- an idempotent quote request and quote revision history;
- a full needs/application form with organization, technical, security, compliance,
  data, workload, migration, region, availability, support, procurement, legal, and
  billing requirements;
- B2B MSA/SOW/DPA/SLA selection and version acceptance records;
- selectable support tier, support hours, response targets, escalation contacts, and
  communication channels;
- requested SLOs, exclusions, maintenance windows, measurement source, error budget,
  service credits/remedies, RTO/RPO, and disaster-recovery expectations;
- privacy purpose, retention period, deletion/export workflow, and least-privilege
  access to application data;
- an append-only audit trail for consent, submissions, quote changes, approvals,
  contract versions, and administrator actions;
- abuse controls, rate limits, bot protection, CSRF protections where cookie auth is
  used, input bounds, file-type/size restrictions, malware scanning, and server-side
  validation against the shared schema.

Recommended public surfaces are `www`, `app`, `api`, `auth`, `org`, `user`, `admin`,
and `api-admin`, with purpose-specific routes or hosts for `interest`, `quote`,
`apply`, `contracts`, `support`, and `status`. Cloudflare configuration must be held in
`fiducia-infra`, reviewed through pull requests, and verified by DNS/TLS/HTTP probes;
no dashboard-only source of truth.

## Verification still required before merge

- All required PR checks must complete successfully on the final human/connector-
  authored head commit.
- Review threads must be resolved or explicitly dispositioned.
- The secrets audit must reject a deliberately introduced plaintext environment file
  in a test fixture and accept the exact encrypted development/production files.
- Rendered manifests must contain no plaintext secrets and no accidental deployment-
  specific values outside their intended runtime configuration source.
- The organization-level administrator checks in FC-SEC-010 must be recorded in
  Linear; they cannot be proven by repository commits alone.

## Residual-risk statement

This was a source/configuration and workflow review, not a dynamic penetration test,
cloud-account audit, production log review, container/image CVE scan, or complete git-
history secret scan. Findings are evidence-backed but not exhaustive. Production
launch remains blocked until authentication, SLO evidence, administrator security
settings, quote/application privacy controls, and end-to-end managed-service contract
acceptance are verified.
