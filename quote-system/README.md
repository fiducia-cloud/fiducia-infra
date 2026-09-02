# Fiducia commercial intake, quote, contract, and service-level boundary

This directory is the infrastructure-facing contract for Fiducia pre-interest registration, the full B2B application, versioned quotes, contract acceptance, support plans, and SLA/SLO selection.

It intentionally contains **no production Cloudflare account ID, zone ID, hostname, route, origin, token, or secret**. Those values are supplied by the reviewed Fiducia environment configuration in this repository. Reusable Cloudflare modules may come from `ORESoftware/cloudflare-infra`, but concrete Fiducia bindings remain owned here.

## Standard host roles

The route template uses `${FIDUCIA_ZONE_APEX}` and named origin inputs. Deployment must resolve the apex from encrypted environment configuration; code must not guess it.

| Host role | Purpose | Cache policy |
| --- | --- | --- |
| `app.${FIDUCIA_ZONE_APEX}` | Public pre-interest, application, quote, and contract UI | no-store for authenticated/private responses |
| `api.${FIDUCIA_ZONE_APEX}` | Public write API | no-store |
| `admin.${FIDUCIA_ZONE_APEX}` | Staff qualification, solutioning, pricing, legal, and provisioning UI | no-store |
| `api-admin.${FIDUCIA_ZONE_APEX}` | Privileged staff API with separate audience and role checks | no-store |
| `auth.${FIDUCIA_ZONE_APEX}` | Shared-auth entry point | provider-defined, never cache credentials |
| `user.${FIDUCIA_ZONE_APEX}` | User profile/account surface | no-store |
| `org.${FIDUCIA_ZONE_APEX}` | Organization/tenant administration | no-store |
| `status.${FIDUCIA_ZONE_APEX}` | Customer-visible availability, incident, and maintenance status | public cache with bounded TTL |

Cloudflare policy must include strict TLS, origin authentication, managed WAF rules, bounded bodies, Turnstile for anonymous intake, per-IP/email/domain/tenant rate limits, no-cache rules for PII and legal/commercial documents, security headers, health-aware origin pools, and explicit `/healthz` and `/readyz` checks.

## Lifecycle

```text
interest_draft
  -> email_verification_pending
  -> interest_verified
  -> qualified | declined | needs_information
  -> application_draft
  -> application_submitted
  -> security_review
  -> solution_design
  -> pricing_review
  -> quote_issued
  -> legal_procurement
  -> signed
  -> provisioning
  -> active
```

Side and terminal states are `withdrawn`, `expired`, `superseded`, `declined`, and `needs_information`. Transitions are append-only audit events with actor, tenant, request/idempotency identifier, timestamp, reason code, prior version, and resulting version. No state update may erase the previous application, quote, SLA, support-plan, or contract version.

## Contract layers

- `contracts/commercial-intake.schema.json` is the JSON Schema Draft 2020-12 interchange contract.
- `contracts/main.tsp` is the TypeSpec source for HTTP/API code generation and cross-language clients.
- `db/0001_commercial_intake.sql` defines tenant-scoped PostgreSQL records that can be mapped through Diesel and SeaORM.
- `cloudflare/routes.template.json` defines host roles and security intent without concrete infrastructure bindings.
- `examples/` contains non-secret fixtures.
- `tests/test_contracts.py` performs dependency-free structural, example, state-machine, arithmetic, and security-policy checks.

The TypeSpec and JSON Schema contracts are complementary. TypeSpec owns service/operation generation; JSON Schema owns portable payload validation and fixtures. Protobuf may be added for trusted internal transport, but it must not replace the public TypeSpec/JSON Schema boundary.

## Public API responsibilities

- create and verify pre-interest registrations;
- create/resume/update/submit/withdraw a full application;
- create bounded signed attachment-upload sessions and complete malware-scanned uploads;
- read issued quote versions and their line-item arithmetic;
- accept or decline the exact quote version;
- initiate contract-signature handoff and read signature status.

Every write requires an idempotency key and optimistic version/ETag check. Anonymous responses use opaque identifiers, reveal no tenant enumeration data, and never expose administrative status notes.

## Administrative API responsibilities

- qualify/decline/request information;
- assign business, technical, security, legal, procurement, billing, and executive owners;
- record security/compliance review and solution architecture;
- create, approve, issue, expire, and supersede quote versions;
- select versioned support and SLA policies;
- advance legal/procurement and provisioning state.

Admin endpoints use a distinct authentication audience and explicit tenant-scoped roles. Public API credentials cannot authorize admin operations.

## Data and privacy controls

- tenant/RLS isolation for every business record;
- field-level encryption for sensitive legal, security, and application data;
- no PII, secret, document body, signature token, or contract text in logs/traces;
- bounded signed uploads with extension/MIME/size allowlists, hash verification, and malware scanning;
- configurable retention, withdrawal, deletion, legal-hold, and data-subject request handling;
- consent and privacy-policy version evidence;
- immutable content hashes and supersession links for quotes/contracts;
- separate service identities and least-privilege database roles;
- retry-safe notifications with a dead-letter path.

## SLA versus SLO

Internal SLOs are engineering objectives. Customer-facing SLAs are contractual commitments. They must be versioned separately even when an SLA is derived from an SLO.

An SLA policy defines measurement source/window, availability formula, latency/error commitments, P1-P4 definitions, initial response/update/mitigation/restoration targets, RTO/RPO, maintenance treatment, exclusions, incident communication, service-credit formula/cap, claim window, and governing contract version.

A quote references immutable support-plan and SLA-policy versions. Acceptance binds their hashes with the exact quote/order-form/contract versions and signer evidence.

## Security-test invariants

The dependency-free contract oracle distinguishes data-bearing endpoints from schema and role identifiers. Example-host checks inspect explicit hostname/domain fields, email domains, and absolute-URL hosts; strings such as schema names are not treated as DNS. The Cloudflare contract is instead checked against the exact placeholder host set above.

Credential-shape regexes are assembled from non-signature source fragments. They still recognize complete private-key and age-identity shapes at runtime, while preventing repository-wide secret scanners from mistaking the test oracle itself for a credential.

Lifecycle assertions validate reachability, closed terminal states, duplicate-free edges, and the presence of exactly one `provisioning -> active` transition. Array ordering is not used as a semantic substitute for the declared state graph.

## Release gate

This directory is a contract and infrastructure boundary, not proof that production DNS or services are active. Activation requires:

1. confirmed Fiducia apex and Cloudflare account/zone ownership;
2. generated server/client contracts reviewed against this source;
3. PostgreSQL migration and tenant policies in an isolated environment;
4. public/admin API and UI implementations;
5. Cloudflare preview validation;
6. an end-to-end canary from pre-interest through a signed test order;
7. explicit approval before production DNS changes.
