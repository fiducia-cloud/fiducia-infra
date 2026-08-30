import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  authorizeApplicationSend,
  classifyInboundForAutomation,
  inferDeliveryState,
  makeIdempotencyKey,
  parseJsonStrict,
  qualifiesForQuota,
  summarizeQuota,
  validateApplicationLedger,
  validateMailPolicy,
} from './application-operations.mjs';

const ledger = parseJsonStrict(
  fs.readFileSync(new URL('../funding/application-ledger.json', import.meta.url), 'utf8'),
  'test application ledger',
);
const policy = parseJsonStrict(
  fs.readFileSync(new URL('../funding/mail-automation-policy.json', import.meta.url), 'utf8'),
  'test mail policy',
);

function clone(value) {
  return structuredClone(value);
}

function application(overrides = {}) {
  const base = {
    id: 'example-program-2026',
    organization: 'Example Organization',
    program: 'Example Program',
    cycle: '2026',
    quota_category: 'fundraising',
    intake_mode: 'portal',
    official_intake: {
      type: 'url',
      value: 'https://example.com/apply',
      verified_on: '2026-08-19',
    },
    sender: {
      address: 'hello@fiducia.cloud',
      authenticated_company_domain: true,
      human_approved: true,
    },
    idempotency_key: 'example-organization::example-program::2026::fundraising',
    status: 'submitted',
    evidence: [
      {
        type: 'portal_receipt',
        occurred_on: '2026-08-19',
        reference: 'portal:example:receipt-1',
      },
    ],
    attempts: [
      {
        kind: 'portal',
        occurred_on: '2026-08-19',
        endpoint: 'https://example.com/apply',
        outcome: 'portal_submitted',
        evidence_ref: 'portal:example:receipt-1',
      },
    ],
    manual_blockers: [],
    commercial_risks: {
      payment_method_required: false,
      overage_possible: false,
      marketing_rights: false,
      data_training_rights: false,
      accepted: false,
    },
    last_action_on: '2026-08-19',
  };
  return { ...base, ...overrides };
}

function completedLedger(applications) {
  const value = clone(ledger);
  value.migration = { status: 'complete', counting_enabled: true };
  value.applications = applications;
  return value;
}

test('committed ledger and mail policy are valid and counting is fail-closed', () => {
  const result = validateApplicationLedger(clone(ledger));
  validateMailPolicy(clone(policy));
  assert.equal(result.migration.counting_enabled, false);
  assert.throws(() => summarizeQuota(result), /counting is disabled/);
});

test('strict JSON parser rejects direct, escaped-equivalent, and nested duplicate keys', () => {
  assert.throws(() => parseJsonStrict('{"a":1,"a":2}', 'direct'), /duplicate object key/);
  assert.throws(() => parseJsonStrict('{"a":1,"\\u0061":2}', 'escaped'), /duplicate object key/);
  assert.throws(() => parseJsonStrict('{"outer":{"a":1,"a":2}}', 'nested'), /duplicate object key/);
});

test('idempotency key normalizes case, punctuation, and separators', () => {
  assert.equal(
    makeIdempotencyKey({
      organization: 'Example, Inc.',
      program: 'Startup / Credit Program',
      cycle: '2026 Cohort',
      quota_category: 'computing-credit',
    }),
    'example-inc::startup-credit-program::2026-cohort::computing-credit',
  );
});

test('portal receipt qualifies once after migration completes', () => {
  const item = application();
  assert.equal(qualifiesForQuota(item), true);
  const totals = summarizeQuota(completedLedger([item]));
  assert.deepEqual(totals, {
    fundraising: 1,
    'computing-credit': 0,
    'ai-credit': 0,
    speaking: 0,
  });
});

test('email sent without a formal intake acknowledgement stays provisional', () => {
  const evidence = [
    {
      type: 'email_sent',
      occurred_on: '2026-08-01',
      reference: 'gmail:message:sent-1',
    },
  ];
  assert.equal(inferDeliveryState(evidence), 'sent_provisional');
  const item = application({
    intake_mode: 'email',
    official_intake: {
      type: 'email',
      value: 'applications@example.com',
      verified_on: '2026-08-01',
    },
    status: 'sent_provisional',
    evidence,
    attempts: [
      {
        kind: 'email',
        occurred_on: '2026-08-01',
        endpoint: 'applications@example.com',
        outcome: 'sent_provisional',
        evidence_ref: 'gmail:message:sent-1',
      },
    ],
    last_action_on: '2026-08-01',
  });
  assert.equal(qualifiesForQuota(item), false);
  validateApplicationLedger(completedLedger([item]));
});

test('hard bounce remains non-qualifying and must not create a second application on reroute', () => {
  const bounced = application({
    intake_mode: 'email',
    official_intake: {
      type: 'email',
      value: 'applications@example.com',
      verified_on: '2026-08-01',
    },
    status: 'bounced',
    evidence: [
      {
        type: 'email_sent',
        occurred_on: '2026-08-01',
        reference: 'gmail:message:sent-1',
      },
      {
        type: 'hard_bounce',
        occurred_on: '2026-08-02',
        reference: 'gmail:dsn:bounce-1',
      },
    ],
    attempts: [
      {
        kind: 'email',
        occurred_on: '2026-08-01',
        endpoint: 'applications@example.com',
        outcome: 'sent_provisional',
        evidence_ref: 'gmail:message:sent-1',
      },
      {
        kind: 'email',
        occurred_on: '2026-08-02',
        endpoint: 'applications@example.com',
        outcome: 'hard_bounce',
        evidence_ref: 'gmail:dsn:bounce-1',
      },
    ],
    last_action_on: '2026-08-02',
  });
  assert.equal(qualifiesForQuota(bounced), false);
  validateApplicationLedger(completedLedger([bounced]));

  const duplicate = clone(bounced);
  duplicate.id = 'example-program-reroute';
  assert.throws(
    () => validateApplicationLedger(completedLedger([bounced, duplicate])),
    /duplicate application identity/,
  );
});

test('under-review, approval, and decision states require formal submission evidence', () => {
  const reviewOnly = application({
    status: 'under_review',
    evidence: [
      {
        type: 'provider_review_ack',
        occurred_on: '2026-08-19',
        reference: 'provider:example:review-1',
      },
    ],
    attempts: [
      {
        kind: 'portal',
        occurred_on: '2026-08-19',
        endpoint: 'https://example.com/apply',
        outcome: 'positive_ack',
        evidence_ref: 'provider:example:review-1',
      },
    ],
  });
  assert.equal(qualifiesForQuota(reviewOnly), false);
  assert.throws(
    () => validateApplicationLedger(completedLedger([reviewOnly])),
    /lacks formal submission evidence/,
  );

  const approved = application({
    status: 'approved',
    evidence: [
      application().evidence[0],
      {
        type: 'approval',
        occurred_on: '2026-08-20',
        reference: 'provider:example:approval-1',
      },
    ],
    attempts: application().attempts,
    last_action_on: '2026-08-20',
  });
  assert.equal(qualifiesForQuota(approved), true);
});

test('support inquiries and portal-required records never qualify', () => {
  for (const status of ['inquiry_sent', 'portal_required', 'blocked', 'closed_without_submission']) {
    const item = application({ status });
    assert.equal(qualifiesForQuota(item), false, status);
  }
});

test('email attempts require authenticated company sender and human approval', () => {
  const item = application({
    intake_mode: 'email',
    official_intake: {
      type: 'email',
      value: 'applications@example.com',
      verified_on: '2026-08-19',
    },
    sender: {
      address: 'hello@fiducia.cloud',
      authenticated_company_domain: false,
      human_approved: false,
    },
    status: 'sent_provisional',
    evidence: [
      {
        type: 'email_sent',
        occurred_on: '2026-08-19',
        reference: 'gmail:message:sent-2',
      },
    ],
    attempts: [
      {
        kind: 'email',
        occurred_on: '2026-08-19',
        endpoint: 'applications@example.com',
        outcome: 'sent_provisional',
        evidence_ref: 'gmail:message:sent-2',
      },
    ],
  });
  assert.throws(
    () => validateApplicationLedger(completedLedger([item])),
    /authenticated company-domain sender/,
  );
});

test('mail automation ignores machines and never auto-sends', () => {
  const cases = [
    [
      { from: 'Mailer-Daemon@example.com', subject: 'Delivery Status Notification', headers: {}, thread_allowlisted: true },
      'ignore_machine',
    ],
    [
      { from: 'human@example.com', subject: 'Hello', headers: { 'Auto-Submitted': 'auto-replied' }, thread_allowlisted: true },
      'ignore_machine',
    ],
    [
      { from: 'human@example.com', subject: 'Hello', headers: { Precedence: 'bulk' }, thread_allowlisted: true },
      'ignore_machine',
    ],
    [
      { from: 'human@example.com', subject: 'Hello', headers: { 'List-Id': 'list.example.com' }, thread_allowlisted: true },
      'ignore_machine',
    ],
    [
      { from: 'human@example.com', subject: 'Invoice due', headers: {}, thread_allowlisted: true },
      'manual_review',
    ],
    [
      { from: 'human@example.com', subject: 'Program update', headers: {}, thread_allowlisted: false },
      'manual_review',
    ],
    [
      { from: 'human@example.com', subject: 'Program update', headers: {}, thread_allowlisted: true },
      'draft_only',
    ],
  ];
  for (const [message, action] of cases) {
    assert.equal(classifyInboundForAutomation(message, policy).action, action);
  }
  assert.equal(policy.auto_send_enabled, false);
});

test('outbound authorization is denied by default and blocks duplicate identities', () => {
  const idempotencyKey = makeIdempotencyKey(application());
  const context = {
    automated: false,
    sender: 'hello@fiducia.cloud',
    human_approved: true,
    authenticated_company_sender: true,
    official_intake_verified: true,
    legal_facts_verified: true,
    idempotency_key: idempotencyKey,
  };
  assert.deepEqual(authorizeApplicationSend(context, policy, completedLedger([])), {
    authorized: true,
    reasons: [],
  });

  const withExisting = completedLedger([application()]);
  assert.deepEqual(
    authorizeApplicationSend({ ...context, automated: true }, policy, withExisting),
    {
      authorized: false,
      reasons: ['automated_send_forbidden', 'duplicate_application_identity'],
    },
  );
});

test('secret-bearing fields, signed URLs, and unknown fields fail closed', () => {
  const withSecret = clone(ledger);
  withSecret.private_api_key = 'not-allowed';
  assert.throws(() => validateApplicationLedger(withSecret), /missing or unknown fields|forbidden sensitive key/);

  const signed = application();
  signed.official_intake.value = 'https://example.com/apply?token=private';
  assert.throws(() => validateApplicationLedger(completedLedger([signed])), /signed or secret-bearing URL|query/);

  const unknown = application();
  unknown.unreviewed_fact = true;
  assert.throws(() => validateApplicationLedger(completedLedger([unknown])), /unknown field/);
});


function sendContext(overrides = {}) {
  return {
    automated: false,
    sender: 'hello@fiducia.cloud',
    human_approved: true,
    authenticated_company_sender: true,
    official_intake_verified: true,
    legal_facts_verified: true,
    idempotency_key: makeIdempotencyKey(application()),
    ...overrides,
  };
}

function sendDecision(context, history = completedLedger([])) {
  return authorizeApplicationSend(context, policy, history);
}

test('approval controls accept literal true only, never coercible values', () => {
  const controls = {
    human_approved: 'human_approval_required',
    authenticated_company_sender: 'company_sender_authentication_required',
    official_intake_verified: 'official_intake_verification_required',
    legal_facts_verified: 'fact_verification_required',
  };
  const invalid = [false, 'false', 'true', 1, 0, [], {}, new Boolean(true), null, undefined];
  for (const [field, reason] of Object.entries(controls)) {
    for (const value of invalid) {
      assert.deepEqual(sendDecision(sendContext({ [field]: value })), {
        authorized: false,
        reasons: [reason],
      }, field);
    }
  }
});

test('automation control requires explicit false rather than a falsy default', () => {
  for (const value of [true, 'false', '', 0, null, undefined, [], {}, new Boolean(false)]) {
    assert.deepEqual(sendDecision(sendContext({ automated: value })), {
      authorized: false,
      reasons: ['automated_send_forbidden'],
    });
  }
});

test('every required send-context field fails closed when omitted', () => {
  const reasons = {
    automated: 'automated_send_forbidden',
    sender: 'wrong_sender',
    human_approved: 'human_approval_required',
    authenticated_company_sender: 'company_sender_authentication_required',
    official_intake_verified: 'official_intake_verification_required',
    legal_facts_verified: 'fact_verification_required',
    idempotency_key: 'invalid_application_identity',
  };
  for (const [field, reason] of Object.entries(reasons)) {
    const context = Object.fromEntries(Object.entries(sendContext()).filter(([key]) => key !== field));
    assert.deepEqual(sendDecision(context), { authorized: false, reasons: [reason] });
  }
});

test('sender identity is exact and never inferred from aliases or display names', () => {
  for (const sender of ['personal@example.com', 'HELLO@fiducia.cloud', ' hello@fiducia.cloud', 'Alex <hello@fiducia.cloud>']) {
    assert.deepEqual(sendDecision(sendContext({ sender })), {
      authorized: false,
      reasons: ['wrong_sender'],
    });
  }
});

test('send identity requires four bounded nonempty canonical parts and a real quota category', () => {
  const invalid = [
    undefined, null, '', 1, {}, [],
    'organization::program::cycle',
    'organization::program::cycle::fundraising::extra',
    '::program::cycle::fundraising',
    'organization::::cycle::fundraising',
    'Organization::program::cycle::fundraising',
    'organization::program::cycle::other',
    'organization::program::cycle::fundraising\n',
    'organization::program::cycle::fundraising ',
    'organization::program::cy\u200bcle::fundraising',
    `${'a'.repeat(161)}::program::cycle::fundraising`,
    'organization::program::cycle::fundraising'.repeat(30),
  ];
  for (const idempotency_key of invalid) {
    assert.deepEqual(sendDecision(sendContext({ idempotency_key })), {
      authorized: false,
      reasons: ['invalid_application_identity'],
    });
  }
});

test('all supported quota categories and maximum-size identity parts remain usable', () => {
  for (const quota_category of ['fundraising', 'computing-credit', 'ai-credit', 'speaking']) {
    const idempotency_key = makeIdempotencyKey({
      organization: 'a'.repeat(160),
      program: 'b'.repeat(160),
      cycle: 'c'.repeat(160),
      quota_category,
    });
    assert.deepEqual(sendDecision(sendContext({ idempotency_key })), { authorized: true, reasons: [] });
  }
});

test('identity builder rejects components that normalize to empty and unknown categories', () => {
  for (const field of ['organization', 'program', 'cycle']) {
    for (const value of ['!!!', '---', '🎛']) {
      assert.throws(() => makeIdempotencyKey({ ...application(), [field]: value }), /non-empty canonical identity/);
    }
  }
  assert.throws(() => makeIdempotencyKey({ ...application(), quota_category: 'partnership' }), /supported quota category/);
});

test('unreconciled committed history cannot authorize a new application', () => {
  assert.equal(ledger.migration.status, 'required');
  assert.deepEqual(sendDecision(sendContext(), ledger), {
    authorized: false,
    reasons: ['application_history_reconciliation_required'],
  });
  assert.equal(ledger.migration.counting_enabled, false);
});

test('null, arrays, primitives, and class instances produce a bounded denial', () => {
  class Context {}
  for (const value of [null, undefined, true, 1, 'context', [], new Context(), new Date(0)]) {
    assert.deepEqual(sendDecision(value), { authorized: false, reasons: ['invalid_send_context'] });
  }
});

test('unknown, symbol, and hidden send controls are rejected without echoing their contents', () => {
  const marker = 'PRIVATE_SENTINEL_DO_NOT_ECHO';
  const unknown = { ...sendContext(), [marker]: marker };
  const symbol = { ...sendContext(), [Symbol(marker)]: true };
  const hidden = sendContext();
  Object.defineProperty(hidden, 'human_approved', { enumerable: false });
  for (const context of [unknown, symbol, hidden]) {
    const result = sendDecision(context);
    assert.deepEqual(result, { authorized: false, reasons: ['invalid_send_context'] });
    assert(!JSON.stringify(result).includes(marker));
  }
});

test('approval accessors and inherited controls are rejected without executing getters', () => {
  let reads = 0;
  const context = sendContext();
  Object.defineProperty(context, 'human_approved', {
    enumerable: true,
    get() { reads += 1; return true; },
  });
  assert.deepEqual(sendDecision(context), { authorized: false, reasons: ['invalid_send_context'] });
  assert.equal(reads, 0);
  assert.deepEqual(sendDecision(Object.create(sendContext())), {
    authorized: false,
    reasons: ['invalid_send_context'],
  });
});

test('null-prototype contexts with explicit data controls are valid inputs', () => {
  const context = Object.assign(Object.create(null), sendContext());
  assert.deepEqual(sendDecision(context), { authorized: true, reasons: [] });
});

test('all recorded opportunity identities block duplicates independent of submission status', () => {
  for (const status of ['discovered', 'inquiry_sent', 'portal_required', 'blocked', 'submitted', 'closed_without_submission']) {
    const history = completedLedger([application({ status })]);
    assert.deepEqual(sendDecision(sendContext(), history), {
      authorized: false,
      reasons: ['duplicate_application_identity'],
    });
  }
});

test('preflight is deterministic and does not mutate frozen context, policy, or history', () => {
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  const context = freeze(sendContext({ automated: true, human_approved: false }));
  const frozenPolicy = freeze(clone(policy));
  const history = freeze(completedLedger([application()]));
  const before = JSON.stringify({ context, frozenPolicy, history });
  const expected = {
    authorized: false,
    reasons: ['automated_send_forbidden', 'human_approval_required', 'duplicate_application_identity'],
  };
  for (let repetition = 0; repetition < 3; repetition += 1) {
    assert.deepEqual(authorizeApplicationSend(context, frozenPolicy, history), expected);
  }
  assert.equal(JSON.stringify({ context, frozenPolicy, history }), before);
});

test('malformed trusted policy or inconsistent history is rejected rather than auto-enabled', () => {
  const unsafePolicy = clone(policy);
  unsafePolicy.auto_send_enabled = true;
  assert.throws(() => authorizeApplicationSend(sendContext(), unsafePolicy, completedLedger([])), /must remain false/);
  const unsafeHistory = clone(ledger);
  unsafeHistory.migration.counting_enabled = true;
  assert.throws(() => sendDecision(sendContext(), unsafeHistory), /counting must remain disabled/);
});
