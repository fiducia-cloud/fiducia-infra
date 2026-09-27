import { createHash } from 'node:crypto';

export const FINGERPRINT_VERSION = 'v1';
export const DD_NEXT_COMPAT_VERSION = 'dd-next-compat-v2';
const PREFIX = 'ores-err-trace:v1';
const DD_PREFIX = 'ores-err-trace:dd-next-compat-v2';
const SEP = '\x1f';

export type FingerprintPolicy = 'v1' | 'dd-next-compat-v2';

export type ErrorEvent = {
  service: string;
  exception_type?: string;
  error_type?: string;
  error_code?: string;
  message?: string;
  error_list?: string[];
  top_frame?: string;
  operation?: string;
  repository?: string;
  environment?: string;
  release_sha?: string;
  trace_id?: string;
  parent_trace_id?: string;
  otel_trace_id?: string;
  otel_span_id?: string;
  severity?: string;
  runtime?: string;
  source?: string;
  routine_id?: string;
  file_name?: string;
};

export type FingerprintEnvelope = {
  policy: FingerprintPolicy;
  fingerprint: string;
  service: string;
};

export type DedupeRecordResult = {
  id: string;
  policy: FingerprintPolicy;
  fingerprint: string;
  occurrence_count: number;
  inserted: boolean;
  first_seen_at: string;
  last_seen_at: string;
};

export type CoordinationOperation =
  | 'record_occurrence'
  | 'reconcile_fingerprint_alias'
  | 'compact_occurrence_history'
  | 'emit_singleton_issue'
  | 'resolve_once';

export type CoordinationIntent = {
  operation: CoordinationOperation;
  requires_lock: boolean;
  lock_key?: string;
};

const fingerprintPolicies = new Set<FingerprintPolicy>(['v1', 'dd-next-compat-v2']);
const coordinationOperations = new Set<CoordinationOperation>([
  'record_occurrence',
  'reconcile_fingerprint_alias',
  'compact_occurrence_history',
  'emit_singleton_issue',
  'resolve_once',
]);

export function isFingerprintPolicy(value: unknown): value is FingerprintPolicy {
  return typeof value === 'string' && fingerprintPolicies.has(value as FingerprintPolicy);
}

export function isCoordinationOperation(value: unknown): value is CoordinationOperation {
  return typeof value === 'string' && coordinationOperations.has(value as CoordinationOperation);
}

const collapseWs = (s: string) => s.trim().split(/\s+/u).filter(Boolean).join(' ');
const ident = (s = '') => collapseWs(s).toLowerCase();
const field = (s = '') => s.replaceAll(SEP, '<sep>');
const truncateCodePoints = (s: string, max: number) => Array.from(s).slice(0, max).join('');

export function normalizeMessage(input = ''): string {
  return collapseWs(input)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/giu, '<hex>')
    .replace(/\b\d{4,}\b/gu, '<n>');
}

/** Mirrors the volatile-value stripping in dancing-dragons/dd-next-1's
 * ddl-error-dedupe-v2 while accepting both legacy dd-trace-* and ORE's
 * ores-trace-* namespace. ORE's wire canonicalization remains versioned here. */
export function normalizeDdNextText(input = ''): string {
  let s = String(input);
  s = s.replace(/params:\s*[\s\S]*$/iu, 'params:<redacted>');
  s = s.replace(/\b(?:dd|ores)-trace-[A-Za-z0-9_-]+\b/gu, '<trace-id>');
  s = s.replace(/\bddl-routine-[A-Za-z0-9_-]+\b/gu, '<routine-id>');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '<uuid>');
  s = s.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '<email>');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, '<iso-timestamp>');
  s = s.replace(/"(traceId|requestId|browserSessionId|hashcode|canonicalHashcode|incomingHashcode)"\s*:\s*"[^"]*"/gu, '"$1":"<redacted>"');
  s = s.replace(/\b(reqId|requestId|browserSessionId):[A-Za-z0-9_-]+\b/giu, '$1:<id>');
  s = s.replace(/\b\d{10,}\b/gu, '<long-number>');
  return truncateCodePoints(collapseWs(s), 2000);
}

export function normalizeFrame(input = ''): string {
  return normalizeMessage(input).replace(/:\d+(?::\d+)?\)?$/u, '').trim();
}

export function canonicalKey(event: ErrorEvent): string {
  return [
    PREFIX,
    ident(event.service),
    ident(event.exception_type ?? event.error_type),
    normalizeMessage(event.message),
    normalizeFrame(event.top_frame),
    ident(event.operation),
  ].map(field).join(SEP);
}

export function fingerprint(event: ErrorEvent): string {
  return createHash('sha256').update(canonicalKey(event), 'utf8').digest('hex');
}

export function ddNextCompatCanonicalKey(event: ErrorEvent): string {
  const normalizedList = (event.error_list ?? [])
    .filter((item) => item.trim().length > 0)
    .slice(0, 3)
    .map(normalizeDdNextText);
  return [
    DD_PREFIX,
    ident(event.environment ?? 'unknown-env'),
    event.release_sha ?? '',
    event.error_code ?? 'DEFAULT',
    event.error_type ?? event.exception_type ?? 'unknown',
    event.severity ?? event.error_type ?? event.exception_type ?? 'unknown',
    event.runtime ?? 'unknown-runtime',
    event.source ?? '',
    event.routine_id ?? '',
    event.repository ?? '',
    event.file_name ?? '',
    normalizeDdNextText(event.message ?? normalizedList[0] ?? 'unknown-error'),
    ...normalizedList,
  ].map(field).join(SEP);
}

export function ddNextCompatFingerprint(event: ErrorEvent): string {
  const digest = createHash('sha256').update(ddNextCompatCanonicalKey(event), 'utf8').digest('hex');
  return `${DD_NEXT_COMPAT_VERSION}:${digest}`;
}

export function fingerprintEnvelope(event: ErrorEvent, policy: FingerprintPolicy = 'v1'): FingerprintEnvelope {
  if (!isFingerprintPolicy(policy)) {
    throw new TypeError(`unsupported fingerprint policy: ${String(policy)}`);
  }
  return {
    policy,
    fingerprint: policy === 'v1' ? fingerprint(event) : ddNextCompatFingerprint(event),
    service: ident(event.service),
  };
}

export function lockKeyForFingerprint(service: string, value: string): string {
  return truncateCodePoints(`oresoftware/err-trace/fingerprint:${ident(service)}:${value}`, 512);
}

export function requiresCoordination(operation: CoordinationOperation): boolean {
  return operation !== 'record_occurrence';
}

export function coordinationIntent(
  operation: CoordinationOperation,
  service: string,
  value: string,
): CoordinationIntent {
  if (!isCoordinationOperation(operation)) {
    throw new TypeError(`unsupported coordination operation: ${String(operation)}`);
  }
  const requiresLock = requiresCoordination(operation);
  return requiresLock
    ? { operation, requires_lock: true, lock_key: lockKeyForFingerprint(service, value) }
    : { operation, requires_lock: false };
}

export function enrich(event: ErrorEvent) {
  return {
    ...event,
    fingerprint_version: FINGERPRINT_VERSION,
    fingerprint: fingerprint(event),
    service: ident(event.service),
    exception_type: ident(event.exception_type ?? event.error_type),
    normalized_message: normalizeMessage(event.message),
    normalized_top_frame: normalizeFrame(event.top_frame),
    operation: ident(event.operation),
  };
}
