# Fiducia funding and application operations

This directory stores public, non-secret metadata for investor, accelerator, cloud,
AI-model, database, Kubernetes-hosting, source-control, developer-platform, and
speaking opportunities relevant to Fiducia Cloud.

Two records have intentionally different meanings:

- `providers.json` is a discovery and routing catalog. It prevents duplicate research,
  records official program routes, and maps opportunities to concrete workloads. It is
  **not** a quota ledger.
- `application-ledger.json` is the only machine-readable source allowed to produce
  application totals. It remains fail-closed with counting disabled until historical
  correspondence is migrated into receipt-backed records.

## Files

- `providers.json` — discovery and provider-state catalog; non-authoritative for quotas.
- `application-ledger.json` — de-duplicated, evidence-backed application state.
- `mail-automation-policy.json` — deny-by-default inbound and outbound mail policy.
- `AUDIT.md` — security and integrity findings plus the evidence model.
- `../tools/validate-funding.mjs` — deterministic provider-catalog validator.
- `../tools/validate-funding.test.mjs` — provider-catalog regression tests.
- `../tools/application-operations.mjs` — strict application and mail-policy engine.
- `../tools/application-operations.test.mjs` — hostile state, evidence, duplicate, and
  mail-automation tests.

## Validate

```sh
node tools/validate-funding.mjs
node --test tools/validate-funding.test.mjs
node tools/application-operations.mjs
node --test tools/application-operations.test.mjs
```

GitHub Actions runs all validators and tests whenever funding metadata, policy, or
workflow code changes.

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
- API keys, access tokens, refresh tokens, or recovery codes;
- card, bank, routing, tax, or private billing data;
- private application links containing signed tokens;
- unredacted email bodies, private account IDs, or confidential investor feedback.

The validators reject common secret-bearing keys and values, but validation is not a
substitute for review.

## Evidence rules

- Use only verified official intake routes and canonical HTTPS URLs.
- Keep action dates tied to real outreach, portal, provider, or decision events.
- Keep next actions explicit so stale records remain visible.
- Record private account, identity, legal, billing, marketing, and data-use prerequisites
  as manual blockers without publishing their sensitive values.
- Never infer incorporation, legal entity, funding, revenue, customers, traction,
  headcount, location, valuation, or financing terms.
- Never mark an email delivered solely because no immediate bounce appeared.
- Never derive quota totals from the discovery catalog or sent-message volume.

## Architecture mapping

Provider entries retain `workload_fit` so requests remain grounded in Fiducia's real
infrastructure:

- multi-provider Kubernetes and failure-domain testing;
- sharded Raft consensus and multi-region failover;
- managed Postgres and distributed-SQL evaluation;
- model inference, coding assistance, and agent orchestration;
- observability, security validation, storage, and CI capacity.

Linear operations: `DEN-812`. Earlier catalog work: `DEN-519`.
