#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SNAPSHOT_FILENAME_PATTERN = /^candidates-(\d{4}-\d{2}-\d{2})\.json$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLIC_SCOPE = 'Public, non-sensitive opportunity discovery only. This file does not assert company eligibility, submission, acceptance, or contractual commitment.';
const ALLOWED_STATUS = new Set(['discovered', 'portal_required']);
const ALLOWED_EVIDENCE_TYPE = new Set(['official_web', 'bounded_human_reply']);
const TOP_LEVEL_KEYS = ['candidates', 'schema_version', 'scope', 'verified_on'];
const CANDIDATE_KEYS = [
  'approval_gate',
  'categories',
  'evidence',
  'evidence_observed_on',
  'evidence_type',
  'id',
  'name',
  'next_action',
  'official_url',
  'status',
];

const FORBIDDEN = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['Linear token', /\blin_api_[A-Za-z0-9]{20,}\b/],
  ['Cloudflare token', /\bcfat_[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['credentialed URL', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ['mailbox header', /^(?:From|To|Cc|Bcc|Subject|Message-ID|Return-Path|Received):/m],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  [
    'secret assignment',
    /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\b\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{12,}/i,
  ],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, where) {
  const actual = Object.keys(value).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${where}: unexpected keys; expected ${expected.join(', ')}, got ${actual.join(', ')}`);
}

function validateDate(value, where) {
  assert(typeof value === 'string' && DATE_PATTERN.test(value), `${where}: expected YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  assert(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value), `${where}: invalid calendar date`);
}

function validateBoundedString(value, where, maxLength) {
  assert(typeof value === 'string', `${where}: expected string`);
  assert(value.trim() === value && value.length > 0, `${where}: expected trimmed non-empty string`);
  assert(value.length <= maxLength, `${where}: exceeds ${maxLength} characters`);
  assert(!/[\r\n\0]/.test(value), `${where}: control or multiline content is forbidden`);
}

function validateOfficialUrl(value, where) {
  validateBoundedString(value, where, 512);
  const url = new URL(value);
  assert(url.protocol === 'https:', `${where}: HTTPS is required`);
  assert(url.username === '' && url.password === '', `${where}: embedded credentials are forbidden`);
  assert(url.search === '' && url.hash === '', `${where}: query strings and fragments are forbidden`);
  assert(url.port === '', `${where}: non-default ports are forbidden`);
  assert(url.hostname.includes('.') && !url.hostname.endsWith('.local') && url.hostname !== 'localhost', `${where}: public hostname required`);
  assert(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname), `${where}: IP-literal hosts are forbidden`);
}

function validateCategories(categories, where) {
  assert(Array.isArray(categories) && categories.length > 0, `${where}: expected non-empty array`);
  const seen = new Set();
  for (let index = 0; index < categories.length; index += 1) {
    const category = categories[index];
    assert(typeof category === 'string' && CATEGORY_PATTERN.test(category), `${where}[${index}]: expected lowercase kebab-case`);
    assert(!seen.has(category), `${where}: duplicate category ${category}`);
    seen.add(category);
  }
  const sorted = [...categories].sort();
  assert(JSON.stringify(categories) === JSON.stringify(sorted), `${where}: categories must be sorted`);
}

function validateCandidate(candidate, index, ids, names, verifiedOn) {
  const where = `$.candidates[${index}]`;
  assert(candidate && typeof candidate === 'object' && !Array.isArray(candidate), `${where}: expected object`);
  exactKeys(candidate, CANDIDATE_KEYS, where);

  assert(typeof candidate.id === 'string' && ID_PATTERN.test(candidate.id), `${where}.id: expected lowercase kebab-case`);
  assert(!ids.has(candidate.id), `${where}.id: duplicate id ${candidate.id}`);
  ids.add(candidate.id);

  validateBoundedString(candidate.name, `${where}.name`, 160);
  assert(!names.has(candidate.name), `${where}.name: duplicate name ${candidate.name}`);
  names.add(candidate.name);

  validateOfficialUrl(candidate.official_url, `${where}.official_url`);
  validateCategories(candidate.categories, `${where}.categories`);
  assert(ALLOWED_STATUS.has(candidate.status), `${where}.status: unsupported discovery status ${candidate.status}`);
  assert(ALLOWED_EVIDENCE_TYPE.has(candidate.evidence_type), `${where}.evidence_type: unsupported evidence type ${candidate.evidence_type}`);
  validateDate(candidate.evidence_observed_on, `${where}.evidence_observed_on`);
  assert(candidate.evidence_observed_on <= verifiedOn, `${where}.evidence_observed_on: cannot be after snapshot verified_on`);
  validateBoundedString(candidate.evidence, `${where}.evidence`, 600);
  validateBoundedString(candidate.next_action, `${where}.next_action`, 600);
  validateBoundedString(candidate.approval_gate, `${where}.approval_gate`, 600);
  assert(candidate.approval_gate.includes('Alex approval'), `${where}.approval_gate: must retain explicit Alex approval`);
}

export function validateSnapshot(snapshot, rawText = JSON.stringify(snapshot)) {
  assert(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot), '$: expected object');
  exactKeys(snapshot, TOP_LEVEL_KEYS, '$');
  assert(snapshot.schema_version === 2, '$.schema_version: expected 2');
  validateDate(snapshot.verified_on, '$.verified_on');
  assert(snapshot.scope === PUBLIC_SCOPE, '$.scope: exact public non-attestation boundary required');
  assert(Array.isArray(snapshot.candidates) && snapshot.candidates.length > 0, '$.candidates: expected non-empty array');

  for (const [name, pattern] of FORBIDDEN) {
    assert(!pattern.test(rawText), `$: forbidden ${name} material found`);
  }

  const ids = new Set();
  const names = new Set();
  snapshot.candidates.forEach((candidate, index) => validateCandidate(candidate, index, ids, names, snapshot.verified_on));
  const sortedIds = [...ids].sort();
  const actualIds = snapshot.candidates.map((candidate) => candidate.id);
  assert(JSON.stringify(actualIds) === JSON.stringify(sortedIds), '$.candidates: candidates must be sorted by id');
  return snapshot;
}

function snapshotDateFromPath(file) {
  const match = path.basename(file).match(SNAPSHOT_FILENAME_PATTERN);
  assert(match, `${file}: filename must match candidates-YYYY-MM-DD.json`);
  return match[1];
}

function assertRegularSnapshot(file) {
  const stat = fs.lstatSync(file);
  assert(!stat.isSymbolicLink(), `${file}: snapshot symlinks are forbidden`);
  assert(stat.isFile(), `${file}: expected regular snapshot file`);
  snapshotDateFromPath(file);
}

export function snapshotFiles(target = 'funding') {
  const resolved = path.resolve(target);
  const stat = fs.lstatSync(resolved);
  assert(!stat.isSymbolicLink(), `${target}: symlinks are forbidden`);
  if (stat.isFile()) {
    assertRegularSnapshot(resolved);
    return [resolved];
  }
  assert(stat.isDirectory(), `${target}: expected file or directory`);
  const files = fs.readdirSync(resolved)
    .filter((name) => SNAPSHOT_FILENAME_PATTERN.test(name))
    .sort()
    .map((name) => path.join(resolved, name));
  assert(files.length > 0, `${target}: no candidate snapshots found`);
  files.forEach(assertRegularSnapshot);
  return files;
}

export function validateTarget(target = 'funding') {
  const files = snapshotFiles(target);
  let candidates = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    validateSnapshot(parsed, raw);
    const filenameDate = snapshotDateFromPath(file);
    assert(filenameDate === parsed.verified_on, `${file}: filename date ${filenameDate} must match verified_on ${parsed.verified_on}`);
    candidates += parsed.candidates.length;
  }
  return { files, candidates };
}

function main() {
  const target = process.argv[2] ?? 'funding';
  const result = validateTarget(target);
  console.log(`Validated ${result.candidates} opportunity candidates across ${result.files.length} snapshot file(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
