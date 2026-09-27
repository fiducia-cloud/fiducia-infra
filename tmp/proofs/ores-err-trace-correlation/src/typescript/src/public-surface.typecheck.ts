import {
  coordinationIntent,
  fingerprintEnvelope,
  type CoordinationIntent,
  type DedupeRecordResult,
  type ErrorEvent,
  type FingerprintEnvelope,
  type FingerprintPolicy,
} from './index.ts';

const event: ErrorEvent = {
  service: 'api',
  exception_type: 'DbError',
  message: 'boom',
  top_frame: 'src/db.ts:10:2',
  operation: 'worker',
  parent_trace_id: 'ores-trace-ParentTrace123',
  otel_trace_id: '11111111111111111111111111111111',
  otel_span_id: '1111111111111111',
};

const policy: FingerprintPolicy = 'v1';
const envelope: FingerprintEnvelope = fingerprintEnvelope(event, policy);

const result: DedupeRecordResult = {
  id: 'row-1',
  policy,
  fingerprint: envelope.fingerprint,
  occurrence_count: 1,
  inserted: true,
  first_seen_at: '2026-09-15T12:00:00Z',
  last_seen_at: '2026-09-15T12:00:00Z',
};

const hotPath: CoordinationIntent = coordinationIntent('record_occurrence', event.service, envelope.fingerprint);
const singleton: CoordinationIntent = coordinationIntent('emit_singleton_issue', event.service, envelope.fingerprint);

void result;
void hotPath;
void singleton;
