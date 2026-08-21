# Application operations security and integrity audit

Date: 2026-08-19

## Findings addressed

1. **Discovery and quota evidence were conflated.** The provider catalog is useful for opportunity routing, but it is not a receipt-backed application ledger and must not be used to publish quota totals.
2. **Sent mail was treated as delivery.** A message with no immediate delivery-status notification can still bounce later. Email-send evidence now remains provisional until a positive provider or formal-intake acknowledgement exists.
3. **Reroutes could inflate totals.** A bounced address and its alternative route now share one normalized application identity. A second record with the same organization, program, cycle, and quota category is rejected.
4. **Support inquiries could be counted as applications.** Inquiry, portal-required, blocked, provisional, bounced, withdrawn, and closed-without-submission states never qualify.
5. **Formal states lacked formal evidence.** Submitted, under-review, approved, decision, and closed-after-submission states require bounded opaque evidence references and the appropriate receipt/acknowledgement/decision sequence.
6. **Mailbox automation was over-broad.** The policy now ignores machine senders, auto-submitted mail, list/bulk mail, and delivery reports; routes billing/security/survey/newsletter subjects to manual review; and never permits automatic sending.
7. **Sender and fact controls were prose-only.** Email attempts require authenticated `hello@fiducia.cloud` and human approval. New outbound authorization also requires verified official intake, unique idempotency identity, and verified application facts.
8. **JSON and metadata schemas were permissive.** The ledger, policy, applications, attempts, evidence, sender, commercial-risk, and counting-policy objects are exact and duplicate-key-free.
9. **Sensitive material could leak into the repository.** Credential-shaped values, sensitive key names, and signed/query-bearing intake URLs are rejected.
10. **Legacy totals were not reproducible from the repository.** Quota counting is disabled until historical correspondence is normalized into the ledger with evidence. The previous reported floors remain historical statements, not machine-certified totals.

## Evidence model

Quota qualification requires one application identity and formal evidence:

- `submitted`: portal receipt or formal email-intake acknowledgement;
- `under_review`: formal submission evidence plus provider review acknowledgement;
- `approved`: formal submission evidence plus approval;
- `declined`, `ineligible`, or `waitlisted`: formal submission evidence plus provider decision;
- `closed_after_submission`: formal submission evidence plus closure.

An email-send event, silence after sending, a support ticket, or a portal handoff is insufficient.

## Residual work

Historical Gmail, Outlook, and Linear records must be migrated conservatively. Each organization/program/cycle/category identity should have one ledger row, chronological attempts, and opaque references to the underlying evidence. Unknown legal, funding, revenue, customer, traction, location, headcount, billing, marketing, and data-use facts remain manual blockers rather than inferred values.
