import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateCatalog } from './validate-funding.mjs';

const validCatalog = JSON.parse(fs.readFileSync(new URL('../funding/providers.json', import.meta.url), 'utf8'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('the committed provider catalog is valid', () => {
  const result = validateCatalog(clone(validCatalog));
  assert.equal(result.company.official_contact, 'hello@fiducia.cloud');
  assert.ok(result.providers.length >= 10);
});

test('duplicate provider ids fail validation', () => {
  const catalog = clone(validCatalog);
  catalog.providers.push(clone(catalog.providers[0]));
  assert.throws(() => validateCatalog(catalog), /duplicate provider id/);
});

test('secret-bearing keys fail validation at any depth', () => {
  const catalog = clone(validCatalog);
  catalog.providers[0].private_api_key = 'must-not-be-committed';
  assert.throws(() => validateCatalog(catalog), /secret-bearing keys are forbidden/);
});

test('non-HTTPS official URLs fail validation', () => {
  const catalog = clone(validCatalog);
  catalog.providers[0].official_url = 'http://example.com';
  assert.throws(() => validateCatalog(catalog), /HTTPS is required/);
});

test('blocked entries require a human-readable blocker', () => {
  const catalog = clone(validCatalog);
  catalog.providers[0].status = 'blocked';
  delete catalog.providers[0].blocker;
  assert.throws(() => validateCatalog(catalog), /blocker: required/);
});

test('action dates cannot move backwards', () => {
  const catalog = clone(validCatalog);
  catalog.providers[0].last_action_on = '2026-08-01';
  catalog.providers[0].next_action_on = '2026-07-31';
  assert.throws(() => validateCatalog(catalog), /cannot precede last_action_on/);
});
