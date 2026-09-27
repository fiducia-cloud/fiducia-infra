// ores-err-trace — independently authored TypeSpec authority.
// Peer: ../json-schema/contract.schema.json. Neither file is generated from the other.

import "@typespec/json-schema";

using TypeSpec.JsonSchema;

@doc("Cross-runtime error fingerprint, persistence, and coordination contracts.")
namespace Ores.ErrTrace;

@doc("Fingerprint algorithm/policy selected by a caller.")
enum FingerprintPolicy {
  preferredV1: "v1",
  ddNextCompatV2: "dd-next-compat-v2",
}

@doc("Normalized error occurrence accepted from ores-otel or another producer.")
@extension("dependentRequired", #{ otel_span_id: #["otel_trace_id"] })
model ErrorEvent {
  @minLength(1)
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
  @pattern("^ores-trace-[A-Za-z0-9_-]{12,64}$")
  parent_trace_id?: string;
  @pattern("^[0-9a-f]{32}$")
  otel_trace_id?: string;
  @pattern("^[0-9a-f]{16}$")
  otel_span_id?: string;
  severity?: string;
  runtime?: string;
  source?: string;
  routine_id?: string;
  file_name?: string;
}

@doc("Fingerprint output carried across runtime and database boundaries.")
model FingerprintEnvelope {
  policy: FingerprintPolicy;
  @pattern("^[0-9a-f]{64}$|^dd-next-compat-v2:[0-9a-f]{64}$")
  fingerprint: string;
  @minLength(1)
  service: string;
}

@doc("Result of atomically recording an occurrence using PostgreSQL unique-index/upsert semantics.")
model DedupeRecordResult {
  @minLength(1)
  id: string;
  policy: FingerprintPolicy;
  fingerprint: string;
  occurrence_count: int64;
  inserted: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

@doc("Operations that may need ores-locks-and-leases. record_occurrence intentionally does not.")
enum CoordinationOperation {
  recordOccurrence: "record_occurrence",
  reconcileFingerprintAlias: "reconcile_fingerprint_alias",
  compactOccurrenceHistory: "compact_occurrence_history",
  emitSingletonIssue: "emit_singleton_issue",
  resolveOnce: "resolve_once",
}

@doc("Decision boundary between database atomicity and distributed coordination.")
model CoordinationIntent {
  operation: CoordinationOperation;
  requires_lock: boolean;
  @maxLength(512)
  lock_key?: string;
}
