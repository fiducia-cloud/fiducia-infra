# Database infrastructure isolation tests

Tracks DEN-3146 and the three separate canonical, auth, and admin private areas
required in each organization's Neon and Supabase infrastructure.

Run `npm ci --ignore-scripts && npm test` from this directory. These are offline
schema, policy, and adversarial tests. GitHub Actions needs no provider credentials,
does not deploy anything, and never resumes a database. A green offline check
does **not** certify that the real infrastructure is isolated. Tests use explicit
`checks/*.spec.mjs` paths so a parent repository's bare `node --test` does not
accidentally discover this independently installed package.

## Organization contract

`contract.json` records the intended owner, the six provider project identities,
the seven-platform mapping, and three distinct VPC/security-group/workload/credential
boundaries. It uses IDs observed in the September 4, 2026 inventory; they are a
baseline, not fresh evidence. Missing configuration is explicitly `null`.
The schema rejects unknown fields, including accidental credential fields.

Keep only secret **references** in this file. Never commit connection strings,
passwords, tokens, raw provider responses, cloud state, or probe environment files.
The canonical source is ORESoftware/k8s-cluster-e2e's `infra-isolation/` folder.
A vendored copy includes `provenance.json` identifying the source commit and hashes.
Org-specific contracts are intentionally outside the common source digest.

## Configuration acceptance

Set `INFRA_SNAPSHOT_FILE` to a fresh, sanitized JSON capture from trusted provider
and AWS administration tools, then run `npm run test:acceptance`. It exits 0 for
pass, 1 for policy failure, and 2 for blocked/missing evidence. The checked-in
unprovisioned contract currently makes acceptance fail closed.

The capture shape is demonstrated by `checks/fixtures.mjs`; fixture values are
synthetic and must never be used as operational evidence. Required fields:

- Envelope: schemaVersion 1, githubOrg, contractDigest (SHA-256 from `digest` in
  policy.mjs), observedAt (UTC ISO timestamp), collectionComplete, errors.
- areas: actual role, vpcId, region, sourceSecurityGroup, workloadIdentity,
  credentialRef for all three areas, exactly matching the intended contract.
- projects: provider, role, projectId, orgId, region, endpointIds, publicBlocked,
  publicServicesBlocked, status (paused/active), autoResume, allowedVpcEndpointIds.
- endpoints: endpointId, vpcId, region, allowedSourceSecurityGroups, allowedPorts,
  publicCidrs, projectIds. Include every regional endpoint service required by
  the provider in endpointIds; each endpoint belongs exclusively to one role's
  project. Only that role's source security group and database ports are allowed.
- crossAreaRoutes: identifiers of any cross-role or foreign-organization paths
  found in route tables, peering, transit gateways, shared endpoints/resource
  shares, proxies, or shared hosts. Acceptance requires an empty list.

Complete pagination and verify every provider response before marking collection
complete. Provider errors, expired credentials, and unknown checks must produce
errors/incomplete collection, never optimistic booleans. Capture evidence after
applying the configuration and within five minutes of acceptance. The checker
rejects drift, stale captures, wrong organizations, public access, shared areas,
wrong endpoint associations, and auto-resume in a paused fleet.

This is a validator and probe harness, **not an AWS/provider inventory collector**.
A trusted operator must collect and authenticate evidence. It cannot establish
truth from self-asserted JSON or independently attest a runner's VPC identity.
Verify runtime identity and VPC placement through the cloud control plane before
using the capture. Evidence must be kept outside Git in the approved audit store.

## Live network acceptance

Do not run while these projects are required to remain paused. Only after the
owner authorizes resumption, update expectedState to active and complete the
private network contract. Deploy five controlled probe runners: canonical, auth,
admin, public, and a genuinely foreign organization's private VPC. Each must
probe the exact same six project targets in one coordinated capture window.

On each runner supply these environment variables through the approved secret
channel; no custom CLI flags or argv credentials are accepted:

- INFRA_LIVE=1 and INFRA_RESUME_AUTHORIZED=1 are explicit operator gates.
- INFRA_SOURCE is canonical/auth/admin/public/foreign; INFRA_SOURCE_VPC_ID is
  cloud-verified placement (use a distinct public-runner identifier for public).
- INFRA_RUN_ID is the same unique capture ID on all five runners.
- INFRA_TARGETS_FILE is a private JSON array of six objects containing provider,
  role, host and port. Use the correct project endpoint DNS names, and 5432 or
  6543. Independently verify their DNS/resource association; do not use proxies
  that could route to a different database.
- INFRA_CONTROL_HOST is an approved, non-target TCP/443 baseline host reachable
  from that runner, used to detect a disconnected runner.
- Matching-role credentials are NEON_<ROLE>_DATABASE_URL and
  SUPABASE_<ROLE>_DATABASE_URL. They must be read-only probe users, delivered
  through environment secrets only. Optional INFRA_CA_FILE supplies trusted CA
  material. TLS certificate verification is mandatory; URL TLS overrides are
  rejected except sslmode=verify-full.

Run `node probe.mjs` and collect its sanitized JSON output outside Git. It runs
only SELECT 1 for allowed connections. A successful TCP connection to a forbidden
target fails even if authentication would reject it. DNS and authentication
errors are inconclusive. A timeout is only a candidate denial: acceptance also
requires positive SQL controls to the same target from its own role and a
reachable baseline on every runner.

Combine the five batch objects into one JSON array, set INFRA_PROBES_FILE and
INFRA_SNAPSHOT_FILE, and run `INFRA_ACCEPTANCE_MODE=network npm run test:acceptance`.
All 30 observations, matching contract digests, source placement, run IDs, and
fresh timestamps are mandatory. Only the six matching-role SQL observations may
succeed; the other 24 must deny access.

## Provider constraints this does not bypass

Neon compute endpoint IDs (`ep-...`) are not AWS VPC endpoint IDs (`vpce-...`).
Neon suspension alone can wake on traffic; a paused inventory must also prove
compute is disabled. Private networking requires the provider's eligible plan
and project endpoint restrictions, plus public-connection blocking.

Supabase PrivateLink covers Postgres/pooler access. Its Auth, REST/Data API,
Storage, Realtime, and Functions surfaces require separate access controls.
Do not set publicServicesBlocked=true merely because Postgres is restricted.
Team/Enterprise entitlement and regional AWS networking are prerequisites;
paid Supabase projects cannot be paused. Those constraints remain blockers.

A VPC is regional. Projects in different AWS regions cannot share a literal
single VPC. Resolve the current Neon/Supabase region mismatch through an approved
migration or an explicitly reviewed extension of this contract before acceptance.

Three VPCs and credentials cannot prevent an authorized shared administrator or
a compromised shared host from bridging them. Separate workload execution,
IAM, secrets, routing, and operator access are part of the captured evidence.
