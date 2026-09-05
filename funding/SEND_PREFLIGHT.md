# Application-send preflight boundary

Tracking: DEN-812. This strengthens the existing effect-free preflight without
adding a sender, a provider integration, or another application ledger.

## Deny by default

`authorizeApplicationSend` accepts a plain data object with seven known controls:
`automated`, `sender`, `human_approved`, `authenticated_company_sender`,
`official_intake_verified`, `legal_facts_verified`, and `idempotency_key`.
Unknown, symbol, accessor, hidden, inherited, array, and non-object contexts are
rejected. Ordinary and null-prototype data objects are supported. Callers must
supply parsed trusted data, not live executable objects or proxies.

Only literal `automated: false` is allowed. Each positive assertion must be
literal `true`; strings such as `"false"`, numeric flags, truthy objects, and
missing controls cannot grant authority. The sender must match the policy's
company sender exactly. This preflight does not inspect OAuth state or infer
sender identity from To/Cc, routing, delivery, or historical sends.

The idempotency key must contain four nonempty canonical kebab-case components:
organization, program, cycle, and one supported quota category. Components are
bounded to 160 characters. The key builder rejects components that normalize to
empty and unsupported quota categories. Existing normalized identities remain
stable; it does not invent legal company names or verify external identity.

Duplicate checking is meaningful only after legacy application history has been
reconciled. Preflight denies a send while `migration.status` is not `complete` or
`migration.counting_enabled` is not true. The committed ledger remains
`required`/false. **This change does not complete migration or enable counting.**
Every existing matching opportunity identity continues to block a new send,
regardless of its status; updates and reroutes require the existing reconciliation
path rather than creating duplicate applications.

## Approval and concurrency limits

`authorized: true` means only that these local preflight assertions passed. It is
**not** proof of human approval, a final submission authorization, a durable claim,
a reservation, or an exactly-once execution guarantee. It never accepts program
terms, commercial risks, data use, publicity, travel, pricing, or billing.

An executor must separately verify the complete exact application revision and
Alex's approval of that revision; clear every legal, identity, publicity, data-use,
and payment handoff; verify the current authenticated sender and official intake;
then acquire the private control plane's fenced, revision-bound submission claim.
It must record a durable receipt or enter reconciliation on an ambiguous outcome.
Concurrent callers cannot use this pure function as their sole deduplication lock.
Any changed packet or terms must invalidate the corresponding prior approval.

## Compatibility and validation

Malformed contexts return a bounded `invalid_send_context` denial. Missing or
invalid controls produce deterministic reason codes; invalid trusted policy or
ledger data still throws rather than being treated as a valid configuration.
No function mutates the supplied context, policy, or ledger.

The positive unit fixture explicitly uses synthetic reconciled history. A new
negative test preserves the real committed incomplete-history boundary; this is
not a change to a provider record or an assertion that migration has occurred.

```sh
node tools/application-operations.mjs
node --test tools/application-operations.test.mjs tools/validate-funding-candidates.test.mjs
```

Tests cover strict booleans, all missing controls, exact sender identity, malformed
or oversized keys, empty normalization, every quota category, incomplete history,
unknown/hidden/inherited/accessor contexts, duplicate identities, frozen inputs,
deterministic denials, and unchanged disabled automation policy. The existing
funding CI already runs these source and test paths.
