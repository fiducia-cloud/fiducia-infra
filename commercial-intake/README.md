# Fiducia commercial-intake host contract

This directory declares the customer-acquisition host and route contract for quote requests, pre-interest registration, detailed enterprise applications, support qualification, and B2B contracting review.

The declaration is **not** evidence that DNS, Cloudflare proxying, an origin deployment, or the private intake migration is active. `activation.enabled` stays `false` until every gate in `host-contract.json` has independent evidence.

## Canonical surfaces

| Host | Responsibility |
| --- | --- |
| `auth.fiducia.cloud` | Shared authentication authority |
| `org.fiducia.cloud` | Organization administration surface |
| `user.fiducia.cloud` | Customer quote, interest, application, support, and contract pages |
| `api.fiducia.cloud` | Protected public JSON submission API |
| `admin.fiducia.cloud` | Human operational and commercial review console |
| `api-admin.fiducia.cloud` | Privileged administrative write API |
| `app.fiducia.cloud` | One-way compatibility redirect to `user.fiducia.cloud` |

## Activation order

1. Merge and pin the `commercial-intake-v1` interfaces.
2. Review the private append-only migration and service-role-only RPC.
3. Capture database backup/rollback evidence and apply the migration from a clean reviewed revision.
4. Deploy immutable web and API revisions with no production credentials in source control.
5. Prove `/healthz`, `/readyz`, `/version`, and valid origin TLS directly against each origin.
6. Apply the Cloudflare declaration through an authorized connection while customer/API proxying remains disabled.
7. Run synthetic `example.test` route, CORS, CSP, security-header, rate-limit, idempotency, redirect, and persistence canaries.
8. Obtain human privacy, retention, support, B2B contract, and SLA/SLO review.
9. Enable proxying one host at a time, beginning with the read-only customer page and ending with protected submission traffic.

## Rollback

DNS/proxy rollback returns customer and API records to the last known-good origin or disables the affected record. Application rollback deploys the previous immutable revision. Database rollback is forward-only: preserve append-only submissions and deploy a compensating migration rather than deleting or rewriting customer records.

## Contract boundary

The intake system records requested terms. It does not accept a customer MSA, create a service credit, guarantee availability, reserve capacity, or establish a support entitlement. Only a signed order form following technical, security, support, commercial, and legal review can do that.

Tracking authority: `DEN-1390`.
