import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fiducia-candidates-'));
}

test('current snapshot is valid', () => {
  assert.equal(validateSnapshot(current, currentRaw), current);
});

test('directory target validates every committed snapshot', () => {
  const result = validateTarget(path.join(ROOT, 'funding'));
  const expectedFiles = snapshotFiles(path.join(ROOT, 'funding'));
  assert.deepEqual(result.files, expectedFiles);
  assert.equal(result.candidates, expectedFiles.reduce((total, file) => total + JSON.parse(fs.readFileSync(file, 'utf8')).candidates.length, 0));
});

test('snapshot discovery rejects empty directories', () => {
  const directory = temporaryDirectory();
  assert.throws(() => snapshotFiles(directory), /no candidate snapshots found/);
});

test('file targets require the dated snapshot filename convention', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'snapshot.json');
  fs.writeFileSync(file, currentRaw);
  assert.throws(() => validateTarget(file), /filename must match/);
});

test('filename date must match verified_on', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'candidates-2026-08-08.json');
  fs.writeFileSync(file, currentRaw);
  assert.throws(() => validateTarget(file), /must match verified_on/);
});

test('snapshot symlinks are rejected', { skip: process.platform === 'win32' }, () => {
  const directory = temporaryDirectory();
  const source = path.join(directory, 'source.json');
  const link = path.join(directory, 'candidates-2026-08-07.json');
  fs.writeFileSync(source, currentRaw);
  fs.symlinkSync(source, link);
  assert.throws(() => snapshotFiles(link), /symlinks are forbidden/);
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
  const fixture = 'gh' + 'p_' + ('1'.repeat(36));
  rejects((value) => { value.candidates[0].evidence = fixture; }, /GitHub token/);
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

// DEN-812: all values below are synthetic and assembled, never live secrets.
test('decoded values are checked even when source JSON uses Unicode escapes', () => {
  const fixtures = [
    ['gh' + 'p_' + '1'.repeat(36), /GitHub token/],
    ['lin' + '_api_' + '1'.repeat(30), /Linear token/],
    ['cf' + 'at_' + '1'.repeat(30), /Cloudflare token/],
    ['sk' + '-' + '1'.repeat(24), /OpenAI-style key/],
    ['xox' + 'b-' + '1'.repeat(24), /Slack token/],
    ['AK' + 'IA' + '1'.repeat(16), /AWS access key/],
    ['-'.repeat(5) + 'BEGIN PRIVATE KEY' + '-'.repeat(5), /private key/],
    ['person@example.com', /email address/],
  ];
  for (const [fixture, pattern] of fixtures) {
    const value = clone();
    value.candidates[0].evidence = fixture;
    const escaped = [...fixture].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const raw = JSON.stringify(value).replace(fixture, escaped);
    assert.throws(() => validateSnapshot(JSON.parse(raw), raw), pattern);
  }
});

test('rawText cannot substitute for or disable decoded-field checks', () => {
  const value = clone();
  value.candidates[0].evidence = 'gh' + 'p_' + '1'.repeat(36);
  for (const raw of ['', '{}', currentRaw, undefined]) {
    assert.throws(() => validateSnapshot(value, raw), /GitHub token/);
  }
  assert.throws(() => validateSnapshot(current, {}), /rawText must be a string/);
});

test('standalone case-insensitive mailbox headers fail without any email address', () => {
  for (const prefix of ['Subject:', 'from:', 'To:', 'CC:', 'Bcc:', 'Message-ID:', 'Return-Path:', 'Received:']) {
    rejects((value) => { value.candidates[0].evidence = `${prefix} restricted material`; }, /mailbox header/);
  }
});

test('every free-text candidate field is scanned after JSON decoding', () => {
  for (const field of ['name', 'evidence', 'next_action', 'approval_gate']) {
    const value = clone();
    value.candidates[0][field] = 'Alex approval: ' + 'cf' + 'at_' + '1'.repeat(30);
    assert.throws(() => validateSnapshot(value, ''), /Cloudflare token/);
  }
});

test('controls, bidirectional markers, zero-width text, and lone surrogates fail closed', () => {
  for (const control of ['\t', '\b', '\x1b', '\x7f', '\u0085', '\u200b', '\u202e', '\u2028', '\u2066', '\ud800']) {
    rejects((value) => { value.candidates[0].evidence = `before${control}after`; }, /control or multiline/);
  }
});

test('private and reserved DNS names and all IP literal forms are rejected', () => {
  for (const host of ['localhost.', 'service.local', 'service.internal', 'service.localhost', 'service.home.arpa', 'service.test', 'service.invalid', 'service.onion', '127.0.0.1', '2130706433', '0x7f000001', '[::1]', '[::ffff:127.0.0.1]']) {
    rejects((value) => { value.candidates[0].official_url = `https://${host}/`; }, /public hostname|IP-literal/);
  }
});

test('noncanonical URLs cannot hide port, authority, or parser normalization', () => {
  for (const url of ['https:example.com', 'https://EXAMPLE.com/', 'https://example.com:443/', 'https://example.com./', 'https://example.com/a/../b', 'https://example.com\\private']) {
    rejects((value) => { value.candidates[0].official_url = url; }, /canonical HTTPS|public hostname/);
  }
});

test('encoded URL paths cannot conceal credentials or controls', () => {
  const value = clone();
  const fixture = 'gh' + 'p_' + '1'.repeat(36);
  value.candidates[0].official_url = 'https://example.com/%2567' + fixture.slice(1);
  assert.throws(() => validateSnapshot(value), /GitHub token/);
  value.candidates[0].official_url = 'https://example.com/%0Aprivate';
  assert.throws(() => validateSnapshot(value), /encoded control/);
  value.candidates[0].official_url = 'https://example.com/%252525252567';
  assert.throws(() => validateSnapshot(value), /excessive path encoding/);
});

test('direct and escaped-equivalent duplicate JSON keys are rejected on ingestion', () => {
  const raws = [
    currentRaw.replace('"schema_version": 2', '"schema_version": 1, "schema_version": 2'),
    currentRaw.replace('"schema_version": 2', '"schema_version": 1, "\\u0073chema_version": 2'),
    currentRaw.replace('"status": "portal_required"', '"status": "submitted", "status": "portal_required"'),
  ];
  for (const raw of raws) {
    const file = path.join(temporaryDirectory(), 'candidates-2026-08-07.json');
    fs.writeFileSync(file, raw);
    assert.throws(() => validateTarget(file), /invalid or ambiguous JSON/);
  }
});

test('malformed candidate-looking filenames are not silently ignored', () => {
  const directory = temporaryDirectory();
  fs.writeFileSync(path.join(directory, 'candidates-2026-08-07.json'), currentRaw);
  fs.writeFileSync(path.join(directory, 'candidates-bad.json'), '{}');
  assert.throws(() => validateTarget(directory), /filename must match/);
});

test('directory ingestion rejects symlinked snapshots', { skip: process.platform === 'win32' }, () => {
  const directory = temporaryDirectory();
  const source = path.join(directory, 'source.json');
  fs.writeFileSync(source, currentRaw);
  fs.symlinkSync(source, path.join(directory, 'candidates-2026-08-07.json'));
  assert.throws(() => validateTarget(directory), /symlinks are forbidden/);
});

test('two snapshots are counted without a hardcoded single-file assumption', () => {
  const directory = temporaryDirectory();
  const next = { ...clone(), verified_on: '2026-08-08' };
  fs.writeFileSync(path.join(directory, 'candidates-2026-08-08.json'), JSON.stringify(next));
  fs.writeFileSync(path.join(directory, 'candidates-2026-08-07.json'), currentRaw);
  const result = validateTarget(directory);
  assert.deepEqual(result.files.map((file) => path.basename(file)), ['candidates-2026-08-07.json', 'candidates-2026-08-08.json']);
  assert.equal(result.candidates, 2 * current.candidates.length);
});

test('oversized and invalid UTF-8 files fail before JSON validation', () => {
  for (const bytes of [Buffer.alloc(1_000_001, 32), Buffer.from([0xff, 0xfe, 0xff])]) {
    const file = path.join(temporaryDirectory(), 'candidates-2026-08-07.json');
    fs.writeFileSync(file, bytes);
    assert.throws(() => validateTarget(file), /byte limit|UTF-8/);
  }
});

test('collection and identity sizes are bounded', () => {
  rejects((value) => { value.candidates = Array(257).fill(value.candidates[0]); }, /too many candidates/);
  rejects((value) => { value.candidates[0].categories = Array(17).fill('cloud'); }, /too many categories/);
  rejects((value) => { value.candidates[0].id = 'a'.repeat(161); }, /exceeds 160/);
  rejects((value) => { value.candidates[0].categories = ['a'.repeat(65)]; }, /exceeds 64/);
});

test('validation does not mutate public snapshot data', () => {
  const value = clone();
  const before = JSON.stringify(value);
  const freeze = (item) => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  };
  assert.equal(validateSnapshot(freeze(value)), value);
  assert.equal(JSON.stringify(value), before);
});

test('unknown fields and invalid states never appear in validation diagnostics', () => {
  for (const inject of [
    (value) => { value.candidates[0].PRIVATE_ONLY_MARKER = true; },
    (value) => { value.candidates[0].status = 'PRIVATE_ONLY_MARKER'; },
    (value) => { value.candidates[0].evidence_type = 'PRIVATE_ONLY_MARKER'; },
  ]) {
    const value = clone();
    inject(value);
    assert.throws(() => validateSnapshot(value), (error) => !error.message.includes('PRIVATE_ONLY_MARKER'));
  }
});

test('CLI diagnostics do not echo sensitive JSON keys, fragments, or filenames', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'candidates-2026-08-07.json');
  fs.writeFileSync(file, '{"PRIVATE_ONLY_MARKER":1,"PRIVATE_ONLY_MARKER":2}');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/validate-funding-candidates.mjs'), file], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /candidate snapshot validation failed/);
  assert(!result.stderr.includes('PRIVATE_ONLY_MARKER'));
  assert(!result.stderr.includes(file));
  assert.equal(result.stdout, '');
});
