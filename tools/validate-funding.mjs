#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_STATUSES = new Set([
  'discovered',
  'inquiry_sent',
  'portal_required',
  'submitted',
  'under_review',
  'approved',
  'declined',
  'ineligible',
  'blocked',
  'waitlisted',
  'closed',
]);

export const ALLOWED_APPLICATION_MODES = new Set([
  'email',
  'portal',
  'referral',
  'hybrid',
  'program',
]);

const FORBIDDEN_KEY_PATTERN = /(?:^|_)(?:password|passwd|secret|otp|api_?key|access_?token|refresh_?token|recovery_?code|card|payment)(?:$|_)/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function walkForForbiddenKeys(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkForForbiddenKeys(entry, `${location}[${index}]`));
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert(!FORBIDDEN_KEY_PATTERN.test(key), `${location}.${key}: secret-bearing keys are forbidden`);
      walkForForbiddenKeys(child, `${location}.${key}`);
    }
  }
}

function validateDate(value, location) {
  assert(typeof value === 'string' && DATE_PATTERN.test(value), `${location}: expected YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  assert(!Number.isNaN(parsed.valueOf()), `${location}: invalid calendar date`);
  assert(parsed.toISOString().startsWith(value), `${location}: invalid calendar date`);
}

function validateStringArray(value, location) {
  assert(Array.isArray(value) && value.length > 0, `${location}: expected a non-empty array`);
  const seen = new Set();
  value.forEach((entry, index) => {
    assert(typeof entry === 'string' && entry.trim() === entry && entry.length > 0, `${location}[${index}]: expected a trimmed non-empty string`);
    assert(!seen.has(entry), `${location}: duplicate value ${entry}`);
    seen.add(entry);
  });
}

export function validateCatalog(catalog) {
  assert(catalog && typeof catalog === 'object' && !Array.isArray(catalog), '$: expected object');
  walkForForbiddenKeys(catalog);

  assert(catalog.schema_version === 1, '$.schema_version: expected 1');
  validateDate(catalog.updated_on, '$.updated_on');

  assert(catalog.company && typeof catalog.company === 'object', '$.company: expected object');
  assert(catalog.company.name === 'Fiducia Cloud', '$.company.name: expected Fiducia Cloud');
  assert(catalog.company.official_contact === 'hello@fiducia.cloud', '$.company.official_contact: expected hello@fiducia.cloud');

  for (const field of ['website', 'github']) {
    assert(typeof catalog.company[field] === 'string', `$.company.${field}: expected string`);
    const url = new URL(catalog.company[field]);
    assert(url.protocol === 'https:', `$.company.${field}: HTTPS is required`);
  }

  assert(Array.isArray(catalog.providers) && catalog.providers.length > 0, '$.providers: expected non-empty array');

  const ids = new Set();
  const names = new Set();

  catalog.providers.forEach((provider, index) => {
    const location = `$.providers[${index}]`;
    assert(provider && typeof provider === 'object' && !Array.isArray(provider), `${location}: expected object`);

    assert(typeof provider.id === 'string' && PROVIDER_ID_PATTERN.test(provider.id), `${location}.id: expected lowercase kebab-case`);
    assert(!ids.has(provider.id), `${location}.id: duplicate provider id ${provider.id}`);
    ids.add(provider.id);

    assert(typeof provider.name === 'string' && provider.name.trim() === provider.name && provider.name.length > 0, `${location}.name: expected trimmed non-empty string`);
    assert(!names.has(provider.name), `${location}.name: duplicate provider name ${provider.name}`);
    names.add(provider.name);

    validateStringArray(provider.categories, `${location}.categories`);
    validateStringArray(provider.workload_fit, `${location}.workload_fit`);

    assert(typeof provider.official_url === 'string', `${location}.official_url: expected string`);
    const officialUrl = new URL(provider.official_url);
    assert(officialUrl.protocol === 'https:', `${location}.official_url: HTTPS is required`);

    assert(ALLOWED_APPLICATION_MODES.has(provider.application_mode), `${location}.application_mode: unsupported value ${provider.application_mode}`);
    assert(typeof provider.company_email_required === 'boolean', `${location}.company_email_required: expected boolean`);
    assert(ALLOWED_STATUSES.has(provider.status), `${location}.status: unsupported value ${provider.status}`);

    if (provider.last_action_on !== undefined) {
      validateDate(provider.last_action_on, `${location}.last_action_on`);
    }
    if (provider.next_action_on !== undefined) {
      validateDate(provider.next_action_on, `${location}.next_action_on`);
    }
    if (provider.last_action_on && provider.next_action_on) {
      assert(provider.next_action_on >= provider.last_action_on, `${location}.next_action_on: cannot precede last_action_on`);
    }

    if (['inquiry_sent', 'submitted', 'under_review', 'approved', 'declined', 'ineligible', 'waitlisted', 'closed'].includes(provider.status)) {
      assert(Boolean(provider.last_action_on), `${location}.last_action_on: required for status ${provider.status}`);
    }

    if (['blocked', 'portal_required'].includes(provider.status)) {
      assert(typeof provider.blocker === 'string' && provider.blocker.trim().length > 0, `${location}.blocker: required for status ${provider.status}`);
    }
  });

  return catalog;
}

export function loadAndValidateCatalog(catalogPath) {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  return validateCatalog(JSON.parse(raw));
}

const currentFile = fileURLToPath(import.meta.url);
const isCli = process.argv[1] && path.resolve(process.argv[1]) === currentFile;

if (isCli) {
  const catalogPath = path.resolve(process.argv[2] ?? 'funding/providers.json');
  const catalog = loadAndValidateCatalog(catalogPath);
  console.log(`Validated ${catalog.providers.length} funding and credit providers from ${catalogPath}`);
}
