#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_STATUS = new Set(['discovered', 'portal_required']);
const FORBIDDEN = [
  /ghp_[A-Za-z0-9_-]{8,}/,
  /lin_api_[A-Za-z0-9_-]{8,}/,
  /cfat_[A-Za-z0-9_-]{8,}/,
  /sk-[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateCandidate(candidate, index, ids) {
  const where = `$.candidates[${index}]`;
  assert(candidate && typeof candidate === 'object' && !Array.isArray(candidate), `${where}: expected object`);
  assert(typeof candidate.id === 'string' && ID_PATTERN.test(candidate.id), `${where}.id: expected lowercase kebab-case`);
  assert(!ids.has(candidate.id), `${where}.id: duplicate id ${candidate.id}`);
  ids.add(candidate.id);
  assert(typeof candidate.name === 'string' && candidate.name.trim().length > 0, `${where}.name: required`);
  assert(Array.isArray(candidate.categories) && candidate.categories.length > 0, `${where}.categories: required`);
  assert(ALLOWED_STATUS.has(candidate.status), `${where}.status: only discovered or portal_required allowed in discovery snapshots`);
  assert(typeof candidate.official_url === 'string' && new URL(candidate.official_url).protocol === 'https:', `${where}.official_url: HTTPS required`);
  for (const field of ['evidence', 'next_action', 'approval_gate']) {
    assert(typeof candidate[field] === 'string' && candidate[field].trim().length > 0, `${where}.${field}: required`);
  }
}

export function validateSnapshot(snapshot, rawText = JSON.stringify(snapshot)) {
  assert(snapshot?.schema_version === 1, '$.schema_version: expected 1');
  assert(typeof snapshot.verified_on === 'string' && DATE_PATTERN.test(snapshot.verified_on), '$.verified_on: expected YYYY-MM-DD');
  assert(typeof snapshot.scope === 'string' && snapshot.scope.includes('does not assert company eligibility'), '$.scope: missing non-attestation boundary');
  assert(Array.isArray(snapshot.candidates) && snapshot.candidates.length > 0, '$.candidates: expected non-empty array');
  for (const pattern of FORBIDDEN) {
    assert(!pattern.test(rawText), '$: credential-shaped material is forbidden');
  }
  const ids = new Set();
  snapshot.candidates.forEach((candidate, index) => validateCandidate(candidate, index, ids));
  return snapshot;
}

function main() {
  const file = path.resolve(process.argv[2] ?? 'funding/candidates-2026-08-07.json');
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  validateSnapshot(parsed, raw);
  console.log(`Validated ${parsed.candidates.length} opportunity candidates from ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
