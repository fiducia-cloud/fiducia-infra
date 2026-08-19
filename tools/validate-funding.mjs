#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonStrict } from './application-operations.mjs';

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
const SECRET_VALUE_PATTERN = /(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROOT_KEYS = ['schema_version', 'updated_on', 'company', 'providers'];
const COMPANY_KEYS = ['name', 'official_contact', 'website', 'github'];
const PROVIDER_ALLOWED_KEYS = new Set([
  'id',
  'name',
  'categories',
  'official_url',
  'application_mode',
  'company_email_required',
  'status',
  'last_action_on',
  'next_action_on',
  'blocker',
  'workload_fit',
]);
const PROVIDER_REQUIRED_KEYS = [
  'id',
  'name',
  'categories',
  'official_url',
  'application_mode',
  'company_email_required',
  'status',
  'workload_fit',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, location) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${location}: expected object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${location}: missing or unknown fields`);
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

function walkForForbiddenData(value, location = '$') {
  if (typeof value === 'string') {
    assert(!SECRET_VALUE_PATTERN.test(value), `${location}: credential-shaped values are forbidden`);
    assert(!/[?&](?:token|sig|signature|key|code)=/i.test(value), `${location}: signed or secret-bearing URLs are forbidden`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkForForbiddenData(entry, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert(!FORBIDDEN_KEY_PATTERN.test(key), `${location}.${key}: secret-bearing keys are forbidden`);
      walkForForbiddenData(child, `${location}.${key}`);
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
  exactKeys(catalog, ROOT_KEYS, '$');
  walkForForbiddenData(catalog);

  assert(catalog.schema_version === 1, '$.schema_version: expected 1');
  validateDate(catalog.updated_on, '$.updated_on');

  exactKeys(catalog.company, COMPANY_KEYS, '$.company');
  assert(catalog.company.name === 'Fiducia Cloud', '$.company.name: expected Fiducia Cloud');
  assert(catalog.company.official_contact === 'hello@fiducia.cloud', '$.company.official_contact: expected hello@fiducia.cloud');

  for (const field of ['website', 'github']) {
    assert(typeof catalog.company[field] === 'string', `$.company.${field}: expected string`);
    const url = new URL(catalog.company[field]);
    assert(url.protocol === 'https:', `$.company.${field}: HTTPS is required`);
    assert(!url.username && !url.password && !url.search && !url.hash, `$.company.${field}: credentials, query, and fragment are forbidden`);
  }

  assert(Array.isArray(catalog.providers) && catalog.providers.length > 0, '$.providers: expected non-empty array');

  const ids = new Set();
  const names = new Set();

  catalog.providers.forEach((provider, index) => {
    const location = `$.providers[${index}]`;
    permittedKeys(provider, PROVIDER_ALLOWED_KEYS, PROVIDER_REQUIRED_KEYS, location);

    assert(typeof provider.id === 'string' && PROVIDER_ID_PATTERN.test(provider.id), `${location}.id: expected lowercase kebab-case`);
    assert(!ids.has(provider.id), `${location}.id: duplicate provider id ${provider.id}`);
    ids.add(provider.id);

    assert(typeof provider.name === 'string' && provider.name.trim() === provider.name && provider.name.length > 0, `${location}.name: expected trimmed non-empty string`);
    assert(!names.has(provider.name.toLowerCase()), `${location}.name: duplicate provider name ${provider.name}`);
    names.add(provider.name.toLowerCase());

    validateStringArray(provider.categories, `${location}.categories`);
    validateStringArray(provider.workload_fit, `${location}.workload_fit`);

    assert(typeof provider.official_url === 'string', `${location}.official_url: expected string`);
    const officialUrl = new URL(provider.official_url);
    assert(officialUrl.protocol === 'https:', `${location}.official_url: HTTPS is required`);
    assert(!officialUrl.username && !officialUrl.password && !officialUrl.search && !officialUrl.hash, `${location}.official_url: credentials, query, and fragment are forbidden`);

    assert(ALLOWED_APPLICATION_MODES.has(provider.application_mode), `${location}.application_mode: unsupported value ${provider.application_mode}`);
    assert(typeof provider.company_email_required === 'boolean', `${location}.company_email_required: expected boolean`);
    assert(ALLOWED_STATUSES.has(provider.status), `${location}.status: unsupported value ${provider.status}`);

    if (provider.last_action_on !== undefined) validateDate(provider.last_action_on, `${location}.last_action_on`);
    if (provider.next_action_on !== undefined) validateDate(provider.next_action_on, `${location}.next_action_on`);
    if (provider.last_action_on && provider.next_action_on) {
      assert(provider.next_action_on >= provider.last_action_on, `${location}.next_action_on: cannot precede last_action_on`);
    }

    if (['inquiry_sent', 'submitted', 'under_review', 'approved', 'declined', 'ineligible', 'waitlisted', 'closed'].includes(provider.status)) {
      assert(Boolean(provider.last_action_on), `${location}.last_action_on: required for status ${provider.status}`);
    }

    if (['blocked', 'portal_required'].includes(provider.status)) {
      assert(typeof provider.blocker === 'string' && provider.blocker.trim() === provider.blocker && provider.blocker.length > 0, `${location}.blocker: required for status ${provider.status}`);
    } else {
      assert(provider.blocker === undefined, `${location}.blocker: allowed only for blocked or portal_required status`);
    }
  });

  return catalog;
}

export function loadAndValidateCatalog(catalogPath) {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  return validateCatalog(parseJsonStrict(raw, 'funding provider catalog'));
}

const currentFile = fileURLToPath(import.meta.url);
const isCli = process.argv[1] && path.resolve(process.argv[1]) === currentFile;

if (isCli) {
  const catalogPath = path.resolve(process.argv[2] ?? 'funding/providers.json');
  const catalog = loadAndValidateCatalog(catalogPath);
  console.log(`Validated ${catalog.providers.length} funding and credit providers from ${catalogPath}`);
}
