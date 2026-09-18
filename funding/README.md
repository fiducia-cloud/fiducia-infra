# Fiducia funding and credit catalog

This directory tracks public, non-secret metadata for investor, accelerator, cloud,
AI-model, database, Kubernetes-hosting, source-control, and developer-platform
programs relevant to Fiducia Cloud.

The catalog exists to prevent duplicate outreach, distinguish email inquiries from
completed portal applications, and map requested credits to concrete Fiducia
workloads.

## Files

- `providers.json` — canonical provider and application-state catalog.
- `../tools/validate-funding.mjs` — deterministic validator and CLI.
- `../tools/validate-funding.test.mjs` — regression tests for catalog invariants.

## Validate

```sh
node tools/validate-funding.mjs
node --test tools/validate-funding.test.mjs
```

The GitHub Actions workflow runs both commands when the catalog, validator, tests,
or workflow changes.

## Status meanings

| Status | Meaning |
| --- | --- |
| `discovered` | Official program found; no outreach or form submission yet. |
| `inquiry_sent` | An email or support inquiry was sent; this is **not** a formal portal submission. |
| `portal_required` | The provider requires authenticated form completion, verification, billing setup, or legal acceptance. |
| `submitted` | The official application or portal form was completed. |
| `under_review` | The provider acknowledged review by a human or program workflow. |
| `approved` | Credits, investment, or program access were approved. |
| `declined` | The provider declined the request. |
| `ineligible` | Published or confirmed eligibility rules are not met. |
| `blocked` | A prerequisite outside repository code must be resolved. |
| `waitlisted` | The provider recorded interest but the program is not currently available. |
| `closed` | No further action is planned. |

## Safe update rules

Never commit:

- passwords or passphrases;
- OTP or MFA codes;
- API keys, access tokens, refresh tokens, or recovery codes;
- card, bank, routing, tax, or private billing data;
- private application links containing signed tokens;
- unredacted email bodies, private account IDs, or confidential investor feedback.

The validator recursively rejects common secret-bearing key names, but validation
is not a substitute for review.

## Evidence rules

- Use only official HTTPS program URLs.
- Keep `last_action_on` tied to a real outreach or portal event.
- Keep `next_action_on` explicit so stale applications are visible.
- Use `blocker` for private account, identity, legal, billing, or portal prerequisites
  without publishing their sensitive values.
- Do not mark a provider `submitted` merely because an email was sent.
- Do not publish unverified funding, revenue, customer, performance, or eligibility
  claims.

## Architecture mapping

Each entry includes `workload_fit` so requests remain grounded in Fiducia's real
infrastructure:

- multi-provider Kubernetes across Hetzner, Vultr, and Civo-compatible failure domains;
- sharded Raft consensus and multi-region failover testing;
- managed Postgres and distributed-SQL evaluation;
- model inference, coding assistance, and agent orchestration;
- observability, security validation, storage, and CI capacity.

Linear tracking: `DEN-519` under the `github.com/fiducia-cloud` project.
