# Fiducia funding, candidate, and application operations

This directory stores public, non-secret metadata for investor, accelerator, cloud,
AI-model, database, Kubernetes-hosting, source-control, developer-platform, and
speaking opportunities relevant to Fiducia Cloud.

Three records have intentionally different meanings:

- `providers.json` is a discovery and routing catalog. It prevents duplicate research,
  records official program routes, and maps opportunities to concrete workloads. It is
  **not** a quota ledger.
- `candidates-YYYY-MM-DD.json` files are dated, public-safe discovery snapshots with
  bounded official-source or human-routing evidence. They permit only `discovered`
  and `portal_required` and never become a second application ledger.
- `application-ledger.json` is the only machine-readable source allowed to produce
  application totals. It remains fail-closed with counting disabled until historical
  correspondence is migrated into receipt-backed records.

## Ownership

- This repository owns the public provider catalog, candidate snapshots, and the
  evidence-backed application ledger and mail policy.
- `fiducia-cloud/.github` owns the public opportunity-operations contract; it must not
  duplicate provider-specific values, deadlines, or application states.
- The approved private application control plane owns mailbox evidence, portal-only
  answers, exact-revision approvals, provider receipts, and reconciliation state.
- Linear owns priority, assignee, blockers, approval state, and acceptance criteria.

## Files

- `providers.json` — discovery and provider-state catalog; non-authoritative for quotas.
- `candidates-YYYY-MM-DD.json` — dated public-safe discovery snapshots using schema v2.
- `application-ledger.json` — de-duplicated, evidence-backed application state.
- `mail-automation-policy.json` — deny-by-default inbound and outbound mail policy.
- `AUDIT.md` — security and integrity findings plus the evidence model.
- `../tools/validate-funding.mjs` — deterministic provider-catalog validator.
- `../tools/validate-funding.test.mjs` — provider-catalog regression tests.
- `../tools/validate-funding-candidates.mjs` — exact-schema snapshot validator; a
  directory argument validates every committed snapshot.
- `../tools/validate-funding-candidates.test.mjs` — adversarial snapshot tests.
- `../tools/application-operations.mjs` — strict application and mail-policy engine.
- `../tools/application-operations.test.mjs` — hostile state, evidence, duplicate, and
  mail-automation tests.

## Validate

```sh
node tools/validate-funding.mjs
node tools/validate-funding-candidates.mjs funding
node tools/application-operations.mjs
node --test \
  tools/validate-funding.test.mjs \
  tools/validate-funding-candidates.test.mjs \
  tools/application-operations.test.mjs
```

GitHub Actions runs all validators and tests whenever funding metadata, policy,
validators, tests, or workflow code changes.

## Provider-catalog status meanings

These statuses support discovery and follow-up routing. They do not independently
qualify an application for a quota.

| Status | Meaning |
| --- | --- |
| `discovered` | Official program found; no outreach or form submission yet. |
| `inquiry_sent` | An email or support inquiry was sent; this is **not** a formal submission. |
| `portal_required` | Authenticated form completion, verification, billing setup, or legal acceptance is required. |
| `submitted` | The catalog claims a formal submission; the application ledger must independently contain qualifying evidence before it is counted. |
| `under_review` | The provider acknowledged review; the application ledger must retain submission and review evidence. |
| `approved` | Credits, investment, or program access were approved. |
| `declined` | The provider declined the request. |
| `ineligible` | Published or confirmed eligibility rules are not met. |
| `blocked` | A prerequisite outside repository code must be resolved. |
| `waitlisted` | Interest was recorded but the program is not currently available. |
| `closed` | No further action is planned. |

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
- `bounded_human_reply` — a short outcome or routing summary from human
  correspondence, without copying an email body, sender or recipient address, or
  message header.

Snapshots are regular files, not symlinks. Their names must match
`candidates-YYYY-MM-DD.json`, and the filename date must equal `verified_on`.
Snapshots are sorted by candidate ID; categories are sorted and unique. Unknown
fields fail closed so private account identifiers or future unreviewed semantics
cannot silently enter the public format.

## Application evidence and counting

An application is identified by the normalized combination of organization, program,
cycle, and exactly one quota category. Bounces and reroutes remain attempts on that
one record; they never create additional applications.

A record can count only after migration is complete and formal evidence exists:

- `submitted` — portal receipt or formal email-intake acknowledgement;
- `under_review` — formal submission evidence plus provider review acknowledgement;
- `approved` — formal submission evidence plus approval;
- `declined`, `ineligible`, or `waitlisted` — formal submission evidence plus decision;
- `closed_after_submission` — formal submission evidence plus closure.

Sent mail, silence after sending, a support inquiry, an automated acknowledgement, a
portal handoff, or a hard bounce is insufficient. Opaque references may point to the
underlying mailbox, portal, provider, GitHub, or Linear evidence; raw private message
bodies do not belong in the repository.

## Mail automation boundary

Automatic sending is disabled. Inbound machine mail is ignored, including delivery
reports, auto-submitted messages, mailing-list traffic, and blocked sender local
parts. Billing, payment, security, verification, survey, newsletter, and unsubscribe
subjects always require manual review. An allowlisted human thread may produce a
draft only.

First-touch application sending requires all of the following:

- human approval;
- authenticated `hello@fiducia.cloud` sender identity;
- verified official intake route;
- unique normalized application identity;
- verified application facts.

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
names, and mailbox-shaped material, but validation is not a substitute for review.

## Evidence rules

- Use only verified official intake routes and canonical HTTPS URLs.
- Keep action dates tied to real outreach, portal, provider, or decision events.
- Keep next actions explicit so stale records remain visible.
- Record private account, identity, legal, billing, marketing, and data-use
  prerequisites as manual blockers without publishing their sensitive values.
- Never infer incorporation, legal entity, funding, revenue, customers, traction,
  headcount, location, valuation, ownership, eligibility, or financing terms.
- Never mark an email delivered solely because no immediate bounce appeared.
- Never derive quota totals from the discovery catalog, candidate snapshots, or
  sent-message volume.
- Do not infer sender authentication from To/Cc, forwarding, or lack of a bounce.
- Do not reuse approval after an application revision changes.

## Architecture mapping

Provider entries retain `workload_fit` so requests remain grounded in Fiducia's real
infrastructure:

- multi-provider Kubernetes and failure-domain testing;
- sharded Raft consensus and multi-region failover;
- managed Postgres and distributed-SQL evaluation;
- model inference, coding assistance, and agent orchestration;
- observability, security validation, storage, and CI capacity.

Linear operations: `DEN-3789`, `DEN-812`, and `DEN-519`.
