import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { snapshotFiles, validateSnapshot, validateTarget } from './validate-funding-candidates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_FILE = path.join(ROOT, 'funding', 'candidates-2026-08-07.json');
const currentRaw = fs.readFileSync(CURRENT_FILE, 'utf8');
const current = JSON.parse(currentRaw);

function clone(value = current) {
  return structuredClone(value);
}

function rejects(mutator, pattern) {
  const candidate = clone();
  mutator(candidate);
  assert.throws(() => validateSnapshot(candidate, JSON.stringify(candidate)), pattern);
}

test('current snapshot is valid', () => {
  assert.equal(validateSnapshot(current, currentRaw), current);
});

test('directory target validates every committed snapshot', () => {
  const result = validateTarget(path.join(ROOT, 'funding'));
  assert.equal(result.files.length, 1);
  assert.equal(result.candidates, current.candidates.length);
});

test('snapshot discovery rejects empty directories', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fiducia-candidates-'));
  assert.throws(() => snapshotFiles(directory), /no candidate snapshots found/);
});

test('rejects unknown top-level fields', () => {
  rejects((value) => { value.private_notes = 'no'; }, /unexpected keys/);
});

test('rejects unknown candidate fields', () => {
  rejects((value) => { value.candidates[0].account_id = 'private'; }, /unexpected keys/);
});

test('rejects unsorted candidate ids', () => {
  rejects((value) => { value.candidates.reverse(); }, /sorted by id/);
});

test('rejects duplicate candidate ids', () => {
  rejects((value) => { value.candidates[1].id = value.candidates[0].id; }, /duplicate id/);
});

test('rejects duplicate candidate names', () => {
  rejects((value) => { value.candidates[1].name = value.candidates[0].name; }, /duplicate name/);
});

test('rejects unsorted categories', () => {
  rejects((value) => { value.candidates[0].categories.reverse(); }, /categories must be sorted/);
});

test('rejects duplicate categories', () => {
  rejects((value) => { value.candidates[0].categories[1] = value.candidates[0].categories[0]; }, /duplicate category/);
});

test('rejects unsupported application states in discovery snapshots', () => {
  rejects((value) => { value.candidates[0].status = 'submitted'; }, /unsupported discovery status/);
});

test('rejects evidence dates after snapshot verification', () => {
  rejects((value) => { value.candidates[0].evidence_observed_on = '2026-08-08'; }, /cannot be after/);
});

test('rejects unknown evidence types', () => {
  rejects((value) => { value.candidates[0].evidence_type = 'mailbox_body'; }, /unsupported evidence type/);
});

test('rejects official URLs with query strings', () => {
  rejects((value) => { value.candidates[0].official_url = 'https://example.com/apply?token=secret'; }, /query strings/);
});

test('rejects credentialed official URLs', () => {
  rejects((value) => { value.candidates[0].official_url = 'https://user:password@example.com/'; }, /credentialed URL|embedded credentials/);
});

test('rejects IP-literal official URLs', () => {
  rejects((value) => { value.candidates[0].official_url = 'https://127.0.0.1/'; }, /IP-literal/);
});

test('rejects credential-shaped material', () => {
  rejects((value) => { value.candidates[0].evidence = 'ghp_123456789012345678901234567890123456'; }, /GitHub token/);
});

test('rejects email addresses and mailbox excerpts', () => {
  rejects((value) => { value.candidates[0].evidence = 'Subject: reply from person@example.com'; }, /mailbox header|email address/);
});

test('rejects multiline evidence', () => {
  rejects((value) => { value.candidates[0].evidence = 'line one\nline two'; }, /multiline/);
});

test('requires explicit Alex approval', () => {
  rejects((value) => { value.candidates[0].approval_gate = 'Final review is required.'; }, /Alex approval/);
});

test('requires exact public scope', () => {
  rejects((value) => { value.scope = 'Public data.'; }, /exact public non-attestation/);
});
