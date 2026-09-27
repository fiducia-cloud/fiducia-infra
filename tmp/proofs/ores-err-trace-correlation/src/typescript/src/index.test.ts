import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coordinationIntent,
  ddNextCompatFingerprint,
  fingerprint,
  fingerprintEnvelope,
  lockKeyForFingerprint,
  normalizeDdNextText,
  requiresCoordination,
} from './index.ts';

const expected = '1e2b57e748fec5876089424b64262899703db3df6ce62b6fb5416c0d7c239652';

test('fingerprint v1 parity', () => {
  assert.equal(fingerprint({
    service: 'api',
    exception_type: 'DbError',
    message: 'user 123456 failed 550e8400-e29b-41d4-a716-446655440000',
    top_frame: 'src/db.rs:123:45',
    operation: 'POST /users/:id',
  }), expected);
});

test('public contract DTO builders preserve policy boundaries', () => {
  const event = {
    service: ' API   Service ',
    exception_type: 'DbError',
    message: 'boom requestId:req-a',
    environment: 'prod',
    runtime: 'nodejs',
  };
  const preferred = fingerprintEnvelope(event, 'v1');
  assert.equal(preferred.service, 'api service');
  assert.equal(preferred.policy, 'v1');
  assert.equal(preferred.fingerprint.length, 64);

  const compat = fingerprintEnvelope(event, 'dd-next-compat-v2');
  assert.equal(compat.policy, 'dd-next-compat-v2');
  assert.match(compat.fingerprint, /^dd-next-compat-v2:[0-9a-f]{64}$/u);

  assert.deepEqual(coordinationIntent('record_occurrence', event.service, preferred.fingerprint), {
    operation: 'record_occurrence',
    requires_lock: false,
  });
  const singleton = coordinationIntent('emit_singleton_issue', event.service, preferred.fingerprint);
  assert.equal(singleton.requires_lock, true);
  assert.ok(singleton.lock_key);
  assert.ok(Array.from(singleton.lock_key ?? '').length <= 512);

  assert.throws(
    () => fingerprintEnvelope(event, 'invalid-policy' as never),
    /unsupported fingerprint policy/u,
  );
  assert.throws(
    () => coordinationIntent('invalid-operation' as never, event.service, preferred.fingerprint),
    /unsupported coordination operation/u,
  );
});

test('occurrence metadata does not change preferred v1 fingerprint', () => {
  const base = { service: 'api', exception_type: 'DbError', message: 'failed id 123456', top_frame: 'src/db.rs:10:2', operation: 'worker' };
  assert.equal(
    fingerprint({
      ...base,
      trace_id: 'ores-trace-a',
      parent_trace_id: 'ores-trace-ParentTraceA12',
      otel_trace_id: '11111111111111111111111111111111',
      otel_span_id: '1111111111111111',
      release_sha: 'aaa',
    }),
    fingerprint({
      ...base,
      trace_id: 'ores-trace-b',
      parent_trace_id: 'ores-trace-ParentTraceB12',
      otel_trace_id: '22222222222222222222222222222222',
      otel_span_id: '2222222222222222',
      release_sha: 'bbb',
    }),
  );
});

test('dd-next compatible normalization redacts legacy and ORE volatile identifiers', () => {
  const a = 'boom dd-trace-abc ddl-routine-def user@example.com 2026-09-15T10:11:12.123Z requestId:req-a 550e8400-e29b-41d4-a716-446655440000 12345678901';
  const b = 'boom ores-trace-xyz ddl-routine-ghi other@example.org 2024-01-01T00:00:00Z requestId:req-b d9428888-122b-11e1-b85c-61cd3cbb3210 99999999999';
  assert.equal(normalizeDdNextText(a), normalizeDdNextText(b));
});

test('dd-next compatible normalization truncates params tail', () => {
  assert.equal(normalizeDdNextText('db failed params: {"password":"secret"}'), 'db failed params:<redacted>');
});

test('dd-next compatibility truncates by Unicode code point', () => {
  const normalized = normalizeDdNextText('é'.repeat(2001));
  assert.equal(Array.from(normalized).length, 2000);
  assert.equal(normalized, 'é'.repeat(2000));
});

test('dd-next compatibility ignores blank error-list entries before fallback selection', () => {
  const base = { service: 'api', environment: 'prod', error_code: 'E1', error_type: 'database', runtime: 'nodejs' };
  assert.equal(
    ddNextCompatFingerprint({ ...base, error_list: ['   ', '\t', 'boom requestId:req-a'] }),
    ddNextCompatFingerprint({ ...base, error_list: ['boom requestId:req-b'] }),
  );
});

test('dd-next compatibility deliberately scopes fingerprint by release/commit', () => {
  const base = {
    service: 'api', environment: 'prod', error_code: 'DB_TIMEOUT', error_type: 'database',
    message: 'query failed requestId:req-a', runtime: 'nodejs', source: 'dd-nodejs-log',
    routine_id: 'ddl-routine-query', repository: 'dd-next-1', file_name: 'db.ts',
  };
  assert.notEqual(
    ddNextCompatFingerprint({ ...base, release_sha: 'aaaaaaaa' }),
    ddNextCompatFingerprint({ ...base, release_sha: 'bbbbbbbb' }),
  );
});

test('dd-next compatible fingerprint ignores legacy/ORE trace request/session volatility in message', () => {
  const base = { service: 'api', environment: 'prod', error_code: 'E1', error_type: 'database', runtime: 'nodejs' };
  assert.equal(
    ddNextCompatFingerprint({ ...base, message: 'boom dd-trace-one requestId:req-a' }),
    ddNextCompatFingerprint({ ...base, message: 'boom ores-trace-two requestId:req-b' }),
  );
});

test('locking policy uses database atomicity for hot-path occurrence records', () => {
  assert.equal(requiresCoordination('record_occurrence'), false);
  assert.equal(requiresCoordination('emit_singleton_issue'), true);
  assert.equal(requiresCoordination('reconcile_fingerprint_alias'), true);
  assert.equal(requiresCoordination('compact_occurrence_history'), true);
  assert.equal(requiresCoordination('resolve_once'), true);
  assert.match(lockKeyForFingerprint('API Service', 'abc123'), /^oresoftware\/err-trace\/fingerprint:api service:abc123$/);
  assert.ok(lockKeyForFingerprint('x'.repeat(1000), 'f'.repeat(64)).length <= 512);
  assert.ok(Array.from(lockKeyForFingerprint('🙂'.repeat(1000), 'f'.repeat(64))).length <= 512);
});
