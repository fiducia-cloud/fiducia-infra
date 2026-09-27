import gleam/option.{None, Some}
import gleam/list
import gleam/string
import gleeunit
import gleeunit/should
import ores_err_trace

pub fn fingerprint_v1_parity_test() {
  let base = ores_err_trace.new_error_event("api")
  let event = ores_err_trace.ErrorEvent(
    ..base,
    exception_type: Some("DbError"),
    message: Some("user 123456 failed 550e8400-e29b-41d4-a716-446655440000"),
    top_frame: Some("src/db.rs:123:45"),
    operation: Some("POST /users/:id"),
  )
  ores_err_trace.fingerprint(event)
  |> should.equal("1e2b57e748fec5876089424b64262899703db3df6ce62b6fb5416c0d7c239652")
}

pub fn preferred_fingerprint_ignores_correlation_metadata_test() {
  let base = ores_err_trace.new_error_event("api")
  let a = ores_err_trace.ErrorEvent(
    ..base,
    exception_type: Some("DbError"),
    message: Some("failed id 123456"),
    top_frame: Some("db.gleam:10:2"),
    operation: Some("worker"),
    trace_id: Some("ores-trace-a"),
    parent_trace_id: Some("ores-trace-ParentTraceA12"),
    otel_trace_id: Some("11111111111111111111111111111111"),
    otel_span_id: Some("1111111111111111"),
    release_sha: Some("aaa"),
  )
  let b = ores_err_trace.ErrorEvent(
    ..a,
    trace_id: Some("ores-trace-b"),
    parent_trace_id: Some("ores-trace-ParentTraceB12"),
    otel_trace_id: Some("22222222222222222222222222222222"),
    otel_span_id: Some("2222222222222222"),
    release_sha: Some("bbb"),
  )
  ores_err_trace.fingerprint(a)
  |> should.equal(ores_err_trace.fingerprint(b))
}

pub fn contract_dto_surface_test() {
  let event = ores_err_trace.new_error_event("API Service")
  let envelope = ores_err_trace.fingerprint_envelope(event, ores_err_trace.PreferredV1)
  envelope.policy |> should.equal(ores_err_trace.PreferredV1)
  envelope.service |> should.equal("api service")

  let result = ores_err_trace.DedupeRecordResult(
    id: "row-1",
    policy: ores_err_trace.PreferredV1,
    fingerprint: envelope.fingerprint,
    occurrence_count: 1,
    inserted: True,
    first_seen_at: "2026-09-15T12:00:00Z",
    last_seen_at: "2026-09-15T12:00:00Z",
  )
  result.inserted |> should.equal(True)

  let hot = ores_err_trace.coordination_intent(
    ores_err_trace.RecordOccurrence,
    "api",
    envelope.fingerprint,
  )
  hot.requires_lock |> should.equal(False)
  hot.lock_key |> should.equal(None)

  let singleton = ores_err_trace.coordination_intent(
    ores_err_trace.EmitSingletonIssue,
    "api",
    envelope.fingerprint,
  )
  singleton.requires_lock |> should.equal(True)
  case singleton.lock_key {
    Some(key) -> {
      let within_limit = string.length(key) <= 512
      within_limit |> should.equal(True)
    }
    None -> should.fail()
  }
}

pub fn dd_next_normalization_redacts_legacy_and_ore_volatility_test() {
  let a = "boom dd-trace-abc ddl-routine-def a@example.com 2026-09-15T10:11:12Z requestId:req-a 12345678901"
  let b = "boom ores-trace-xyz ddl-routine-ghi b@example.org 2025-01-01T00:00:00Z requestId:req-b 99999999999"
  ores_err_trace.normalize_dd_next_text(a)
  |> should.equal(ores_err_trace.normalize_dd_next_text(b))
}

pub fn dd_next_normalization_truncates_by_unicode_code_point_test() {
  ores_err_trace.normalize_dd_next_text(string.repeat("é", 2001))
  |> should.equal(string.repeat("é", 2000))
}

pub fn dd_next_compat_ignores_blank_error_list_entries_test() {
  let a = ores_err_trace.DdNextCompatEvent(
    environment: "prod",
    release_sha: "",
    error_code: "E1",
    error_type: "database",
    severity: "database",
    runtime: "nodejs",
    source: "",
    routine_id: "",
    repository: "",
    file_name: "",
    message: "",
    error_list: ["   ", "\t", "boom requestId:req-a"],
  )
  let b = ores_err_trace.DdNextCompatEvent(
    ..a,
    error_list: ["boom requestId:req-b"],
  )
  ores_err_trace.dd_next_compat_fingerprint(a)
  |> should.equal(ores_err_trace.dd_next_compat_fingerprint(b))
}

pub fn dd_next_compat_is_commit_scoped_test() {
  let a = ores_err_trace.DdNextCompatEvent(
    environment: "prod",
    release_sha: "aaa",
    error_code: "DB_TIMEOUT",
    error_type: "database",
    severity: "error",
    runtime: "nodejs",
    source: "dd-nodejs-log",
    routine_id: "ddl-routine-query",
    repository: "dd-next-1",
    file_name: "db.ts",
    message: "query failed requestId:req-a",
    error_list: [],
  )
  let b = ores_err_trace.DdNextCompatEvent(
    ..a,
    release_sha: "bbb",
  )
  ores_err_trace.dd_next_compat_fingerprint(a)
  |> should.not_equal(ores_err_trace.dd_next_compat_fingerprint(b))
}

pub fn dd_next_compat_ignores_legacy_and_ore_trace_volatility_test() {
  let a = ores_err_trace.DdNextCompatEvent(
    environment: "prod",
    release_sha: "aaa",
    error_code: "E1",
    error_type: "database",
    severity: "error",
    runtime: "nodejs",
    source: "dd-nodejs-log",
    routine_id: "",
    repository: "dd-next-1",
    file_name: "db.ts",
    message: "boom dd-trace-one requestId:req-a",
    error_list: [],
  )
  let b = ores_err_trace.DdNextCompatEvent(
    ..a,
    message: "boom ores-trace-two requestId:req-b",
  )
  ores_err_trace.dd_next_compat_fingerprint(a)
  |> should.equal(ores_err_trace.dd_next_compat_fingerprint(b))
}

pub fn coordination_policy_test() {
  ores_err_trace.requires_coordination(ores_err_trace.RecordOccurrence)
  |> should.equal(False)
  ores_err_trace.requires_coordination(ores_err_trace.ReconcileFingerprintAlias)
  |> should.equal(True)
  ores_err_trace.requires_coordination(ores_err_trace.CompactOccurrenceHistory)
  |> should.equal(True)
  ores_err_trace.requires_coordination(ores_err_trace.EmitSingletonIssue)
  |> should.equal(True)
  ores_err_trace.requires_coordination(ores_err_trace.ResolveOnce)
  |> should.equal(True)

  ores_err_trace.lock_key_for_fingerprint(string.repeat("🙂", 1000), string.repeat("f", 64))
  |> string.to_graphemes
  |> list.length
  |> fn(length) { length <= 512 }
  |> should.equal(True)
}


pub fn main() {
  gleeunit.main()
}
