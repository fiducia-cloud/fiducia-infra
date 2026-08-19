# Fiducia funding and credit catalog

This directory tracks public, non-secret metadata for investor, accelerator, cloud,
AI-model, database, Kubernetes-hosting, source-control, and developer-platform
programs relevant to Fiducia Cloud.

The catalog exists to prevent duplicate outreach, distinguish email inquiries from
completed portal applications, and map requested credits to concrete Fiducia
workloads.

## Ownership

- `providers.json` is the canonical public provider and application-state catalog.
- `candidates-YYYY-MM-DD.json` files are immutable-in-meaning discovery snapshots
  containing bounded official-source or human-routing evidence.
- `fiducia-cloud/.github` owns the public opportunity-operations policy; it must not
  duplicate provider-specific values, dates, or application states.
- The approved private application control plane owns mailbox evidence, portal-only
  answers, exact-revision approvals, provider receipts, and reconciliation state.
- Linear owns priority, assignee, blockers, approval state, and acceptance criteria.

## Files

- `providers.json` — canonical provider and application-state catalog.
- `candidates-YYYY-MM-DD.json` — dated, public-safe discovery snapshots using schema v2.
- `../tools/validate-funding.mjs` — deterministic provider-catalog validator and CLI.
- `../tools/validate-funding.test.mjs` — provider-catalog regression tests.
- `../tools/validate-funding-candidates.mjs` — exact-schema snapshot validator; a
  directory argument validates every committed snapshot.
- `../tools/validate-funding-candidates.test.mjs` — adversarial snapshot tests.

## Validate

```sh
node tools/validate-funding.mjs
node tools/validate-funding-candidates.mjs funding
node --test tools/validate-funding.test.mjs tools/validate-funding-candidates.test.mjs
```

The GitHub Actions workflow runs all commands when the catalog, snapshots,
validators, tests, or workflow change.

## Provider status meanings

| Status | Meaning |
| --- | --- |
| `discovered` | Official program found; no outreach or form submission yet. |
| `inquiry_sent` | An email or support inquiry was sent; this is **not** a formal portal submission. |
| `portal_required` | The provider requires authenticated form completion, verification, billing setup, or legal acceptance. |
| `submitted` | The official application or portal form was completed and durable evidence exists. |
| `under_review` | The provider acknowledged review by a human or program workflow. |
| `approved` | Credits, investment, or program access were approved. |
| `declined` | The provider declined the request. |
| `ineligible` | Published or confirmed eligibility rules are not met. |
| `blocked` | A prerequisite outside repository code must be resolved. |
| `waitlisted` | The provider recorded interest but the program is not currently available. |
| `closed` | No further action is planned. |

Candidate snapshots intentionally permit only `discovered` and `portal_required`.
They are discovery evidence, not a second application ledger.

## Candidate snapshot schema v2

Each snapshot has exactly four top-level fields: `schema_version`, `verified_on`,
`scope`, and `candidates`. Each candidate has an exact, closed field set including:

- sorted, unique `id`, `name`, and `categories`;
- one public HTTPS `official_url` without credentials, query parameters, fragments,
  custom ports, local hosts, or IP literals;
- bounded `status`, `evidence_type`, `evidence_observed_on`, `evidence`,
  `next_action`, and `approval_gate` fields;
- an evidence date no later than the snapshot verification date; and
- an approval gate that explicitly retains Alex approval.

Supported evidence types are:

- `official_web` — bounded facts from an official public program page;
- `bounded_human_reply` — a short outcome/routing summary from human correspondence,
  without copying the email body, sender/recipient addresses, or message headers.

Snapshots are regular files, not symlinks. Their names must match
`candidates-YYYY-MM-DD.json`, and the filename date must equal `verified_on`.
Snapshots are sorted by candidate ID; categories are sorted and unique. Unknown
fields fail closed so private account identifiers or future unreviewed semantics
cannot silently enter the public format.

## Safe update rules

Never commit:

- passwords or passphrases;
- OTP or MFA codes;
- API keys, access tokens, refresh tokens, recovery codes, or private keys;
- card, bank, routing, tax, or private billing data;
- private application links containing signed tokens or account identifiers;
- email addresses, mailbox bodies, recipient lists, copied headers, or confidential
  provider feedback;
- portal-only answers, legal attestations, identity documents, or unpublished
  funding, revenue, customer, performance, ownership, or eligibility facts.

The validators reject common credential patterns, unsafe URLs, secret-bearing key
names, and mailbox-shaped material, but validation is not a substitute for human
review.

## Evidence rules

- Use only official HTTPS program URLs.
- Keep `last_action_on` tied to a real outreach or portal event.
- Keep `next_action_on` explicit so stale applications are visible.
- Use `blocker` for private account, identity, legal, billing, or portal prerequisites
  without publishing their sensitive values.
- Do not mark a provider `submitted` merely because an email was sent.
- Do not infer sender authentication from To/Cc, forwarding, or lack of a bounce.
- Do not publish unverified funding, revenue, customer, performance, legal-entity,
  ownership, or eligibility claims.
- Do not reuse approval after an application revision changes.

## Architecture mapping

Each provider entry includes `workload_fit` so requests remain grounded in Fiducia's
real infrastructure:

- multi-provider Kubernetes and independent failure domains;
- sharded Raft consensus and multi-region failover testing;
- managed Postgres and distributed-SQL evaluation;
- model inference, coding assistance, and agent orchestration;
- observability, security validation, storage, and CI capacity.

Linear tracking: `DEN-519`, `DEN-812`, and `DEN-3789` under the shared
`fiducia-cloud` project.
