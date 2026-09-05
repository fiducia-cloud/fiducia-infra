#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isIP } from 'node:net';
import { parseJsonStrict } from './application-operations.mjs';
import { pathToFileURL } from 'node:url';

const MAX_SNAPSHOT_BYTES = 1_000_000;
const MAX_CANDIDATES = 256;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'arpa', 'test', 'invalid', 'example', 'onion', 'alt'];

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
  ['mailbox header', /^(?:From|To|Cc|Bcc|Subject|Message-ID|Return-Path|Received):/im],
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
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${where}: missing or unexpected keys`);
}

function rejectSensitiveText(value, where) {
  for (const [name, pattern] of FORBIDDEN) {
    assert(!pattern.test(value), `${where}: forbidden ${name} material found`);
  }
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
  assert(!UNSAFE_TEXT.test(value), `${where}: control or multiline content is forbidden`);
  // Scan actual decoded field values, never only a caller-supplied JSON string.
  rejectSensitiveText(value, where);
}

function validateOfficialUrl(value, where) {
  validateBoundedString(value, where, 512);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${where}: invalid public URL`);
  }
  assert(url.protocol === 'https:', `${where}: HTTPS is required`);
  assert(url.username === '' && url.password === '', `${where}: embedded credentials are forbidden`);
  assert(url.search === '' && url.hash === '', `${where}: query strings and fragments are forbidden`);
  assert(url.port === '', `${where}: non-default ports are forbidden`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  assert(isIP(host) === 0, `${where}: IP-literal hosts are forbidden`);
  assert(host.includes('.') && !host.endsWith('.'), `${where}: public hostname required`);
  assert(!PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)), `${where}: public hostname required`);
  assert(value.startsWith('https://') && url.href === value && !value.includes('\\'), `${where}: canonical HTTPS URL required`);
  // Percent-encoded path values must not conceal credentials or control text.
  let decodedPath = url.pathname;
  for (let depth = 0; depth < 4 && /%[0-9a-f]{2}/i.test(decodedPath); depth += 1) {
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {
      throw new Error(`${where}: invalid path encoding`);
    }
    assert(!UNSAFE_TEXT.test(decodedPath), `${where}: encoded control content is forbidden`);
    rejectSensitiveText(decodedPath, where);
  }
  assert(!/%[0-9a-f]{2}/i.test(decodedPath), `${where}: excessive path encoding`);
}

function validateCategories(categories, where) {
  assert(Array.isArray(categories) && categories.length > 0, `${where}: expected non-empty array`);
  assert(categories.length <= 16, `${where}: too many categories`);
  const seen = new Set();
  for (let index = 0; index < categories.length; index += 1) {
    const category = categories[index];
    validateBoundedString(category, `${where}[${index}]`, 64);
    assert(typeof category === 'string' && CATEGORY_PATTERN.test(category), `${where}[${index}]: expected lowercase kebab-case`);
    assert(!seen.has(category), `${where}: duplicate category`);
    seen.add(category);
  }
  const sorted = [...categories].sort();
  assert(JSON.stringify(categories) === JSON.stringify(sorted), `${where}: categories must be sorted`);
}

function validateCandidate(candidate, index, ids, names, verifiedOn) {
  const where = `$.candidates[${index}]`;
  assert(candidate && typeof candidate === 'object' && !Array.isArray(candidate), `${where}: expected object`);
  exactKeys(candidate, CANDIDATE_KEYS, where);

  validateBoundedString(candidate.id, `${where}.id`, 160);
  assert(typeof candidate.id === 'string' && ID_PATTERN.test(candidate.id), `${where}.id: expected lowercase kebab-case`);
  assert(!ids.has(candidate.id), `${where}.id: duplicate id`);
  ids.add(candidate.id);

  validateBoundedString(candidate.name, `${where}.name`, 160);
  assert(!names.has(candidate.name), `${where}.name: duplicate name`);
  names.add(candidate.name);

  validateOfficialUrl(candidate.official_url, `${where}.official_url`);
  validateCategories(candidate.categories, `${where}.categories`);
  assert(ALLOWED_STATUS.has(candidate.status), `${where}.status: unsupported discovery status`);
  assert(ALLOWED_EVIDENCE_TYPE.has(candidate.evidence_type), `${where}.evidence_type: unsupported evidence type`);
  validateDate(candidate.evidence_observed_on, `${where}.evidence_observed_on`);
  assert(candidate.evidence_observed_on <= verifiedOn, `${where}.evidence_observed_on: cannot be after snapshot verified_on`);
  validateBoundedString(candidate.evidence, `${where}.evidence`, 600);
  validateBoundedString(candidate.next_action, `${where}.next_action`, 600);
  validateBoundedString(candidate.approval_gate, `${where}.approval_gate`, 600);
  assert(candidate.approval_gate.includes('Alex approval'), `${where}.approval_gate: must retain explicit Alex approval`);
}

export function validateSnapshot(snapshot, rawText) {
  assert(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot), '$: expected object');
  exactKeys(snapshot, TOP_LEVEL_KEYS, '$');
  assert(snapshot.schema_version === 2, '$.schema_version: expected 2');
  validateDate(snapshot.verified_on, '$.verified_on');
  assert(snapshot.scope === PUBLIC_SCOPE, '$.scope: exact public non-attestation boundary required');
  assert(Array.isArray(snapshot.candidates) && snapshot.candidates.length > 0, '$.candidates: expected non-empty array');

  assert(snapshot.candidates.length <= MAX_CANDIDATES, '$.candidates: too many candidates');
  // Optional source text is supplementary. Empty or sanitized text cannot bypass
  // the decoded-field checks below, and callers need not serialize the object.
  if (rawText !== undefined) {
    assert(typeof rawText === 'string', '$: rawText must be a string');
    assert(Buffer.byteLength(rawText, 'utf8') <= MAX_SNAPSHOT_BYTES, '$: snapshot exceeds byte limit');
    rejectSensitiveText(rawText, '$');
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
  assert(match, '$snapshot.path: filename must match candidates-YYYY-MM-DD.json');
  return match[1];
}

function assertRegularSnapshot(file) {
  const stat = fs.lstatSync(file);
  assert(!stat.isSymbolicLink(), '$snapshot.path: snapshot symlinks are forbidden');
  assert(stat.isFile(), '$snapshot.path: expected regular snapshot file');
  assert(stat.size <= MAX_SNAPSHOT_BYTES, '$snapshot: snapshot exceeds byte limit');
  snapshotDateFromPath(file);
}

export function snapshotFiles(target = 'funding') {
  const resolved = path.resolve(target);
  const stat = fs.lstatSync(resolved);
  assert(!stat.isSymbolicLink(), '$snapshot.path: symlinks are forbidden');
  if (stat.isFile()) {
    assertRegularSnapshot(resolved);
    return [resolved];
  }
  assert(stat.isDirectory(), '$snapshot.path: expected file or directory');
  const files = fs.readdirSync(resolved)
    .filter((name) => name.startsWith('candidates-'))
    .sort()
    .map((name) => path.join(resolved, name));
  assert(files.length > 0, '$snapshot.path: no candidate snapshots found');
  files.forEach(assertRegularSnapshot);
  return files;
}

export function validateTarget(target = 'funding') {
  const files = snapshotFiles(target);
  let candidates = 0;
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    assert(bytes.length <= MAX_SNAPSHOT_BYTES, '$snapshot: snapshot exceeds byte limit');
    let raw;
    let parsed;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      parsed = parseJsonStrict(raw, 'candidate snapshot');
    } catch {
      // Parser diagnostics can contain input keys or fragments. Do not echo them.
      throw new Error('$snapshot: invalid or ambiguous JSON / UTF-8');
    }
    validateSnapshot(parsed, raw);
    const filenameDate = snapshotDateFromPath(file);
    assert(filenameDate === parsed.verified_on, '$snapshot.path: filename date must match verified_on');
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
  } catch {
    // Filesystem errors can echo an untrusted path. Keep public CI logs redacted.
    console.error('ERROR: candidate snapshot validation failed; inspect the input locally');
    process.exitCode = 1;
  }
}
