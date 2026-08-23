#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUOTA_CATEGORIES = new Set([
  'fundraising',
  'computing-credit',
  'ai-credit',
  'speaking',
]);

export const APPLICATION_STATUSES = new Set([
  'discovered',
  'inquiry_sent',
  'portal_required',
  'sent_provisional',
  'submitted',
  'under_review',
  'approved',
  'declined',
  'ineligible',
  'blocked',
  'waitlisted',
  'bounced',
  'withdrawn',
  'closed_after_submission',
  'closed_without_submission',
]);

export const QUALIFYING_STATUSES = new Set([
  'submitted',
  'under_review',
  'approved',
  'declined',
  'ineligible',
  'waitlisted',
  'closed_after_submission',
]);

const INTAKE_MODES = new Set(['email', 'portal', 'referral', 'hybrid']);
const INTAKE_TYPES = new Set(['email', 'url']);
const EVIDENCE_TYPES = new Set([
  'email_sent',
  'hard_bounce',
  'positive_delivery_ack',
  'formal_email_intake_ack',
  'portal_receipt',
  'provider_review_ack',
  'approval',
  'decision',
  'withdrawal',
  'closure',
  'official_terms',
]);
const ATTEMPT_KINDS = new Set(['email', 'portal', 'referral']);
const ATTEMPT_OUTCOMES = new Set([
  'sent_provisional',
  'hard_bounce',
  'positive_ack',
  'portal_submitted',
  'rerouted',
  'no_action',
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECRET_VALUE_PATTERN = /(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const FORBIDDEN_KEY_PATTERN = /(?:^|_)(?:password|passwd|secret|otp|api_?key|access_?token|refresh_?token|recovery_?code|card_number|bank_account|routing_number|tax_id)(?:$|_)/i;
const APPLICATION_KEYS = new Set([
  'id',
  'organization',
  'program',
  'cycle',
  'quota_category',
  'intake_mode',
  'official_intake',
  'sender',
  'idempotency_key',
  'status',
  'evidence',
  'attempts',
  'manual_blockers',
  'commercial_risks',
  'last_action_on',
  'next_action_on',
]);
const REQUIRED_APPLICATION_KEYS = [
  'id',
  'organization',
  'program',
  'cycle',
  'quota_category',
  'intake_mode',
  'official_intake',
  'sender',
  'idempotency_key',
  'status',
  'evidence',
  'attempts',
  'manual_blockers',
  'commercial_risks',
  'last_action_on',
];
const COMMERCIAL_RISK_KEYS = [
  'payment_method_required',
  'overage_possible',
  'marketing_rights',
  'data_training_rights',
  'accepted',
];

function exactKeys(value, expected, location) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${location}: expected object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${location}: missing or unknown fields`);
}

function permittedKeys(value, allowed, required, location) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${location}: expected object`);
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${location}.${key}: unknown field`);
  }
  for (const key of required) {
    assert(Object.hasOwn(value, key), `${location}.${key}: required`);
  }
}

function validateDate(value, location) {
  assert(typeof value === 'string' && DATE_PATTERN.test(value), `${location}: expected YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  assert(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value), `${location}: invalid date`);
}

function validateTrimmed(value, location, max = 240) {
  assert(typeof value === 'string', `${location}: expected string`);
  assert(value.trim() === value && value.length > 0 && value.length <= max, `${location}: expected trimmed non-empty string up to ${max} characters`);
}

function validateStringArray(value, location, { allowEmpty = false } = {}) {
  assert(Array.isArray(value), `${location}: expected array`);
  if (!allowEmpty) assert(value.length > 0, `${location}: expected non-empty array`);
  const seen = new Set();
  value.forEach((entry, index) => {
    validateTrimmed(entry, `${location}[${index}]`);
    assert(!seen.has(entry), `${location}: duplicate value ${entry}`);
    seen.add(entry);
  });
}

function walkForForbiddenData(value, location = '$') {
  if (typeof value === 'string') {
    assert(!SECRET_VALUE_PATTERN.test(value), `${location}: credential-shaped value is forbidden`);
    assert(!/[?&](?:token|sig|signature|key|code)=/i.test(value), `${location}: signed or secret-bearing URL is forbidden`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkForForbiddenData(entry, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert(!FORBIDDEN_KEY_PATTERN.test(key), `${location}.${key}: forbidden sensitive key`);
      walkForForbiddenData(child, `${location}.${key}`);
    }
  }
}

export function parseJsonStrict(text, label = 'JSON') {
  assert.equal(typeof text, 'string', `${label}: expected string`);
  let index = 0;

  function fail(message) {
    throw new SyntaxError(`${label}: ${message} at character ${index}`);
  }
  function whitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  }
  function stringValue() {
    const start = index;
    if (text[index] !== '"') fail('expected string');
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (character === '\\') {
        index += 1;
        if (index >= text.length) fail('unterminated escape sequence');
        const escape = text[index];
        if (escape === 'u') {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid Unicode escape');
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) fail('invalid escape sequence');
        index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail('unescaped control character');
      index += 1;
    }
    fail('unterminated string');
  }
  function primitive() {
    const remaining = text.slice(index);
    for (const literal of ['true', 'false', 'null']) {
      if (remaining.startsWith(literal)) {
        index += literal.length;
        return;
      }
    }
    const number = remaining.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) fail('invalid value');
    index += number[0].length;
  }
  function array() {
    index += 1;
    whitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    while (index < text.length) {
      value();
      whitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      if (text[index] !== ',') fail('expected comma or closing bracket');
      index += 1;
      whitespace();
    }
    fail('unterminated array');
  }
  function object() {
    index += 1;
    whitespace();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    const keys = new Set();
    while (index < text.length) {
      if (text[index] !== '"') fail('expected object key');
      const key = stringValue();
      if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      whitespace();
      if (text[index] !== ':') fail('expected colon');
      index += 1;
      value();
      whitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      if (text[index] !== ',') fail('expected comma or closing brace');
      index += 1;
      whitespace();
    }
    fail('unterminated object');
  }
  function value() {
    whitespace();
    const character = text[index];
    if (character === '{') return object();
    if (character === '[') return array();
    if (character === '"') {
      stringValue();
      return;
    }
    primitive();
  }

  value();
  whitespace();
  if (index !== text.length) fail('trailing content');
  return JSON.parse(text);
}

function slug(value) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function makeIdempotencyKey({ organization, program, cycle, quota_category }) {
  for (const [name, value] of Object.entries({ organization, program, cycle, quota_category })) {
    validateTrimmed(value, `idempotency.${name}`, 160);
  }
  return [organization, program, cycle, quota_category].map(slug).join('::');
}

function evidenceTypes(application) {
  return new Set(application.evidence.map((entry) => entry.type));
}

function hasSubmissionEvidence(types) {
  return types.has('portal_receipt') || types.has('formal_email_intake_ack');
}

export function qualifiesForQuota(application) {
  if (!QUALIFYING_STATUSES.has(application.status)) return false;
  const types = evidenceTypes(application);
  if (application.status === 'submitted') return hasSubmissionEvidence(types);
  if (application.status === 'under_review') return hasSubmissionEvidence(types) && types.has('provider_review_ack');
  if (application.status === 'approved') return hasSubmissionEvidence(types) && types.has('approval');
  if (['declined', 'ineligible', 'waitlisted'].includes(application.status)) {
    return hasSubmissionEvidence(types) && types.has('decision');
  }
  if (application.status === 'closed_after_submission') {
    return hasSubmissionEvidence(types) && types.has('closure');
  }
  return false;
}

export function inferDeliveryState(evidence) {
  assert(Array.isArray(evidence), 'evidence: expected array');
  const ordered = [...evidence].sort((left, right) => left.occurred_on.localeCompare(right.occurred_on));
  let state = 'not_sent';
  for (const entry of ordered) {
    if (entry.type === 'email_sent') state = 'sent_provisional';
    if (entry.type === 'hard_bounce') state = 'bounced';
    if (['positive_delivery_ack', 'formal_email_intake_ack', 'portal_receipt', 'provider_review_ack'].includes(entry.type)) {
      state = 'confirmed';
    }
  }
  return state;
}

function validateEvidence(entries, location) {
  assert(Array.isArray(entries), `${location}: expected array`);
  const references = new Set();
  let previousDate = null;
  entries.forEach((entry, index) => {
    const itemLocation = `${location}[${index}]`;
    exactKeys(entry, ['type', 'occurred_on', 'reference'], itemLocation);
    assert(EVIDENCE_TYPES.has(entry.type), `${itemLocation}.type: unsupported evidence type ${entry.type}`);
    validateDate(entry.occurred_on, `${itemLocation}.occurred_on`);
    validateTrimmed(entry.reference, `${itemLocation}.reference`, 200);
    assert(/^(?:gmail|outlook|portal|provider|github|linear):[A-Za-z0-9._:-]+$/.test(entry.reference), `${itemLocation}.reference: expected bounded opaque reference`);
    assert(!references.has(entry.reference), `${location}: duplicate evidence reference ${entry.reference}`);
    references.add(entry.reference);
    if (previousDate) assert(entry.occurred_on >= previousDate, `${itemLocation}.occurred_on: evidence must be chronological`);
    previousDate = entry.occurred_on;
  });
}

function validateAttempts(entries, evidenceReferences, location) {
  assert(Array.isArray(entries), `${location}: expected array`);
  let previousDate = null;
  entries.forEach((entry, index) => {
    const itemLocation = `${location}[${index}]`;
    exactKeys(entry, ['kind', 'occurred_on', 'endpoint', 'outcome', 'evidence_ref'], itemLocation);
    assert(ATTEMPT_KINDS.has(entry.kind), `${itemLocation}.kind: unsupported attempt kind`);
    validateDate(entry.occurred_on, `${itemLocation}.occurred_on`);
    validateTrimmed(entry.endpoint, `${itemLocation}.endpoint`, 240);
    assert(ATTEMPT_OUTCOMES.has(entry.outcome), `${itemLocation}.outcome: unsupported attempt outcome`);
    assert(evidenceReferences.has(entry.evidence_ref), `${itemLocation}.evidence_ref: missing evidence`);
    if (previousDate) assert(entry.occurred_on >= previousDate, `${itemLocation}.occurred_on: attempts must be chronological`);
    previousDate = entry.occurred_on;
  });
}

function validateOfficialIntake(value, location) {
  exactKeys(value, ['type', 'value', 'verified_on'], location);
  assert(INTAKE_TYPES.has(value.type), `${location}.type: unsupported intake type`);
  validateDate(value.verified_on, `${location}.verified_on`);
  validateTrimmed(value.value, `${location}.value`, 240);
  if (value.type === 'email') {
    assert(EMAIL_PATTERN.test(value.value), `${location}.value: invalid email address`);
  } else {
    const url = new URL(value.value);
    assert(url.protocol === 'https:', `${location}.value: HTTPS is required`);
    assert(!url.username && !url.password && !url.search && !url.hash, `${location}.value: credentials, query, and fragment are forbidden`);
  }
}

function validateSender(value, location) {
  exactKeys(value, ['address', 'authenticated_company_domain', 'human_approved'], location);
  assert(value.address === 'hello@fiducia.cloud', `${location}.address: expected hello@fiducia.cloud`);
  assert(typeof value.authenticated_company_domain === 'boolean', `${location}.authenticated_company_domain: expected boolean`);
  assert(typeof value.human_approved === 'boolean', `${location}.human_approved: expected boolean`);
}

function validateCommercialRisks(value, location) {
  exactKeys(value, COMMERCIAL_RISK_KEYS, location);
  for (const key of COMMERCIAL_RISK_KEYS) {
    assert(typeof value[key] === 'boolean', `${location}.${key}: expected boolean`);
  }
  if (value.accepted) {
    assert(value.payment_method_required || value.overage_possible || value.marketing_rights || value.data_training_rights, `${location}.accepted: no recorded risk requires acceptance`);
  }
}

export function validateApplicationLedger(ledger) {
  exactKeys(ledger, ['schema_version', 'updated_on', 'company', 'migration', 'counting_policy', 'applications'], '$');
  walkForForbiddenData(ledger);
  assert.equal(ledger.schema_version, 1, '$.schema_version: expected 1');
  validateDate(ledger.updated_on, '$.updated_on');

  exactKeys(ledger.company, ['name', 'official_contact', 'website', 'github', 'linkedin'], '$.company');
  assert.equal(ledger.company.name, 'Fiducia Cloud', '$.company.name: expected Fiducia Cloud');
  assert.equal(ledger.company.official_contact, 'hello@fiducia.cloud', '$.company.official_contact: expected company contact');
  for (const field of ['website', 'github', 'linkedin']) {
    const url = new URL(ledger.company[field]);
    assert.equal(url.protocol, 'https:', `$.company.${field}: HTTPS is required`);
  }

  exactKeys(ledger.migration, ['status', 'counting_enabled'], '$.migration');
  assert(['required', 'complete'].includes(ledger.migration.status), '$.migration.status: unsupported value');
  assert.equal(typeof ledger.migration.counting_enabled, 'boolean', '$.migration.counting_enabled: expected boolean');
  assert.equal(ledger.migration.counting_enabled, ledger.migration.status === 'complete', '$.migration: counting must remain disabled until migration is complete');

  exactKeys(
    ledger.counting_policy,
    [
      'quota_categories',
      'qualifying_statuses',
      'delivery_reconciliation_hours',
      'email_sent_alone_qualifies',
      'absence_of_bounce_qualifies',
      'reroute_creates_new_application',
      'support_inquiry_qualifies',
      'portal_required_qualifies',
    ],
    '$.counting_policy',
  );
  assert.deepEqual(new Set(ledger.counting_policy.quota_categories), QUOTA_CATEGORIES, '$.counting_policy.quota_categories: exact categories required');
  assert.deepEqual(new Set(ledger.counting_policy.qualifying_statuses), QUALIFYING_STATUSES, '$.counting_policy.qualifying_statuses: exact statuses required');
  assert(Number.isSafeInteger(ledger.counting_policy.delivery_reconciliation_hours) && ledger.counting_policy.delivery_reconciliation_hours >= 24, '$.counting_policy.delivery_reconciliation_hours: expected at least 24 hours');
  for (const field of ['email_sent_alone_qualifies', 'absence_of_bounce_qualifies', 'reroute_creates_new_application', 'support_inquiry_qualifies', 'portal_required_qualifies']) {
    assert.equal(ledger.counting_policy[field], false, `$.counting_policy.${field}: must remain false`);
  }

  assert(Array.isArray(ledger.applications), '$.applications: expected array');
  const ids = new Set();
  const idempotencyKeys = new Set();
  ledger.applications.forEach((application, index) => {
    const location = `$.applications[${index}]`;
    permittedKeys(application, APPLICATION_KEYS, REQUIRED_APPLICATION_KEYS, location);
    assert(ID_PATTERN.test(application.id), `${location}.id: expected lowercase kebab-case`);
    assert(!ids.has(application.id), `${location}.id: duplicate application id`);
    ids.add(application.id);
    for (const field of ['organization', 'program', 'cycle']) validateTrimmed(application[field], `${location}.${field}`, 160);
    assert(QUOTA_CATEGORIES.has(application.quota_category), `${location}.quota_category: unsupported category`);
    assert(INTAKE_MODES.has(application.intake_mode), `${location}.intake_mode: unsupported mode`);
    validateOfficialIntake(application.official_intake, `${location}.official_intake`);
    validateSender(application.sender, `${location}.sender`);
    assert(APPLICATION_STATUSES.has(application.status), `${location}.status: unsupported status`);
    validateDate(application.last_action_on, `${location}.last_action_on`);
    if (application.next_action_on !== undefined) {
      validateDate(application.next_action_on, `${location}.next_action_on`);
      assert(application.next_action_on >= application.last_action_on, `${location}.next_action_on: cannot precede last_action_on`);
    }
    validateStringArray(application.manual_blockers, `${location}.manual_blockers`, { allowEmpty: true });
    validateCommercialRisks(application.commercial_risks, `${location}.commercial_risks`);
    validateEvidence(application.evidence, `${location}.evidence`);
    const references = new Set(application.evidence.map((entry) => entry.reference));
    validateAttempts(application.attempts, references, `${location}.attempts`);

    const expectedKey = makeIdempotencyKey(application);
    assert.equal(application.idempotency_key, expectedKey, `${location}.idempotency_key: does not match normalized identity`);
    assert(!idempotencyKeys.has(expectedKey), `${location}.idempotency_key: duplicate application identity`);
    idempotencyKeys.add(expectedKey);

    const delivery = inferDeliveryState(application.evidence);
    if (application.status === 'sent_provisional') assert.equal(delivery, 'sent_provisional', `${location}.status: provisional send requires only provisional delivery evidence`);
    if (application.status === 'bounced') assert.equal(delivery, 'bounced', `${location}.status: bounced status requires terminal hard-bounce evidence`);
    if (QUALIFYING_STATUSES.has(application.status)) {
      assert(qualifiesForQuota(application), `${location}.status: qualifying status lacks formal submission evidence`);
    }
    if (application.attempts.some((attempt) => attempt.kind === 'email' && attempt.outcome !== 'no_action')) {
      assert(application.sender.authenticated_company_domain, `${location}.sender: email attempts require authenticated company-domain sender`);
      assert(application.sender.human_approved, `${location}.sender: email attempts require human approval`);
    }
  });
  return ledger;
}

export function summarizeQuota(ledger) {
  validateApplicationLedger(ledger);
  assert.equal(ledger.migration.counting_enabled, true, 'quota counting is disabled until legacy history migration is complete');
  const totals = Object.fromEntries([...QUOTA_CATEGORIES].map((category) => [category, 0]));
  for (const application of ledger.applications) {
    if (qualifiesForQuota(application)) totals[application.quota_category] += 1;
  }
  return totals;
}

export function validateMailPolicy(policy) {
  exactKeys(
    policy,
    [
      'schema_version',
      'auto_send_enabled',
      'company_sender',
      'mode',
      'blocked_local_parts',
      'blocked_precedence',
      'blocked_auto_submitted_values',
      'blocked_content_types',
      'manual_review_subject_terms',
      'required_send_controls',
    ],
    '$mail_policy',
  );
  assert.equal(policy.schema_version, 1, '$mail_policy.schema_version: expected 1');
  assert.equal(policy.auto_send_enabled, false, '$mail_policy.auto_send_enabled: must remain false');
  assert.equal(policy.company_sender, 'hello@fiducia.cloud', '$mail_policy.company_sender: expected company address');
  assert.equal(policy.mode, 'allowlisted_threads_human_review_only', '$mail_policy.mode: unexpected mode');
  for (const field of ['blocked_local_parts', 'blocked_precedence', 'blocked_auto_submitted_values', 'blocked_content_types', 'manual_review_subject_terms']) {
    validateStringArray(policy[field], `$mail_policy.${field}`);
    assert.deepEqual(policy[field], policy[field].map((value) => value.toLowerCase()), `$mail_policy.${field}: values must be lowercase`);
  }
  exactKeys(
    policy.required_send_controls,
    ['human_approved', 'authenticated_company_sender', 'official_intake_verified', 'idempotency_key_unique', 'legal_facts_verified'],
    '$mail_policy.required_send_controls',
  );
  for (const [key, value] of Object.entries(policy.required_send_controls)) {
    assert.equal(value, true, `$mail_policy.required_send_controls.${key}: must remain true`);
  }
  walkForForbiddenData(policy, '$mail_policy');
  return policy;
}

function addressLocalPart(address) {
  const match = String(address ?? '').trim().toLowerCase().match(/<?([^<>\s]+@[^<>\s]+)>?$/);
  return match ? match[1].split('@', 1)[0] : '';
}

export function classifyInboundForAutomation(message, policy) {
  validateMailPolicy(policy);
  const headers = Object.fromEntries(
    Object.entries(message.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value).trim().toLowerCase()]),
  );
  const localPart = addressLocalPart(message.from);
  const contentType = String(message.content_type ?? headers['content-type'] ?? '').toLowerCase();
  const subject = String(message.subject ?? '').toLowerCase();

  if (policy.blocked_local_parts.some((value) => localPart === value || localPart.startsWith(`${value}+`))) {
    return { action: 'ignore_machine', reason: 'blocked_sender_local_part' };
  }
  const autoSubmitted = headers['auto-submitted'];
  if (autoSubmitted && autoSubmitted !== 'no') return { action: 'ignore_machine', reason: 'auto_submitted' };
  if (policy.blocked_precedence.includes(headers.precedence)) return { action: 'ignore_machine', reason: 'bulk_precedence' };
  if (headers['list-id'] || headers['list-unsubscribe']) return { action: 'ignore_machine', reason: 'mailing_list' };
  if (policy.blocked_content_types.some((value) => contentType.includes(value))) {
    return { action: 'ignore_machine', reason: 'machine_content_type' };
  }
  if (policy.manual_review_subject_terms.some((value) => subject.includes(value))) {
    return { action: 'manual_review', reason: 'sensitive_or_bulk_subject' };
  }
  if (!message.thread_allowlisted) return { action: 'manual_review', reason: 'thread_not_allowlisted' };
  return { action: 'draft_only', reason: 'allowlisted_human_thread' };
}

export function authorizeApplicationSend(context, policy, ledger) {
  validateMailPolicy(policy);
  validateApplicationLedger(ledger);
  const reasons = [];
  if (context.automated) reasons.push('automated_send_forbidden');
  if (context.sender !== policy.company_sender) reasons.push('wrong_sender');
  if (!context.human_approved) reasons.push('human_approval_required');
  if (!context.authenticated_company_sender) reasons.push('company_sender_authentication_required');
  if (!context.official_intake_verified) reasons.push('official_intake_verification_required');
  if (!context.legal_facts_verified) reasons.push('fact_verification_required');
  if (ledger.applications.some((entry) => entry.idempotency_key === context.idempotency_key)) {
    reasons.push('duplicate_application_identity');
  }
  return { authorized: reasons.length === 0, reasons };
}

export function loadApplicationOperations(ledgerPath, policyPath) {
  const ledger = validateApplicationLedger(
    parseJsonStrict(fs.readFileSync(ledgerPath, 'utf8'), 'application ledger'),
  );
  const policy = validateMailPolicy(
    parseJsonStrict(fs.readFileSync(policyPath, 'utf8'), 'mail automation policy'),
  );
  return { ledger, policy };
}

const currentFile = fileURLToPath(import.meta.url);
const isCli = process.argv[1] && path.resolve(process.argv[1]) === currentFile;
if (isCli) {
  const ledgerPath = path.resolve(process.argv[2] ?? 'funding/application-ledger.json');
  const policyPath = path.resolve(process.argv[3] ?? 'funding/mail-automation-policy.json');
  const { ledger } = loadApplicationOperations(ledgerPath, policyPath);
  const state = ledger.migration.counting_enabled ? 'enabled' : 'disabled-pending-migration';
  console.log(`Validated ${ledger.applications.length} application records; quota counting is ${state}`);
}
