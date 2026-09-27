import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

pub const fingerprint_version = "v1"
pub const dd_next_compat_version = "dd-next-compat-v2"
const prefix = "ores-err-trace:v1"
const dd_prefix = "ores-err-trace:dd-next-compat-v2"
const sep = "\u{001f}"

pub type FingerprintPolicy {
  PreferredV1
  DdNextCompatV2
}

pub type ErrorEvent {
  ErrorEvent(
    service: String,
    exception_type: Option(String),
    error_type: Option(String),
    error_code: Option(String),
    message: Option(String),
    error_list: Option(List(String)),
    top_frame: Option(String),
    operation: Option(String),
    repository: Option(String),
    environment: Option(String),
    release_sha: Option(String),
    trace_id: Option(String),
    parent_trace_id: Option(String),
    otel_trace_id: Option(String),
    otel_span_id: Option(String),
    severity: Option(String),
    runtime: Option(String),
    source: Option(String),
    routine_id: Option(String),
    file_name: Option(String),
  )
}

pub type FingerprintEnvelope {
  FingerprintEnvelope(
    policy: FingerprintPolicy,
    fingerprint: String,
    service: String,
  )
}

pub type DedupeRecordResult {
  DedupeRecordResult(
    id: String,
    policy: FingerprintPolicy,
    fingerprint: String,
    occurrence_count: Int,
    inserted: Bool,
    first_seen_at: String,
    last_seen_at: String,
  )
}

pub type DdNextCompatEvent {
  DdNextCompatEvent(
    environment: String,
    release_sha: String,
    error_code: String,
    error_type: String,
    severity: String,
    runtime: String,
    source: String,
    routine_id: String,
    repository: String,
    file_name: String,
    message: String,
    error_list: List(String),
  )
}

pub type CoordinationOperation {
  RecordOccurrence
  ReconcileFingerprintAlias
  CompactOccurrenceHistory
  EmitSingletonIssue
  ResolveOnce
}

pub type CoordinationIntent {
  CoordinationIntent(
    operation: CoordinationOperation,
    requires_lock: Bool,
    lock_key: Option(String),
  )
}

@external(erlang, "ores_err_trace_ffi", "normalize_message")
fn normalize_message_ffi(value: String) -> String

@external(erlang, "ores_err_trace_ffi", "normalize_dd_next_text")
fn normalize_dd_next_text_ffi(value: String) -> String

@external(erlang, "ores_err_trace_ffi", "normalize_frame")
fn normalize_frame_ffi(value: String) -> String

@external(erlang, "ores_err_trace_ffi", "normalize_ident")
fn normalize_ident_ffi(value: String) -> String

@external(erlang, "ores_err_trace_ffi", "sha256_hex")
fn sha256_hex(value: String) -> String

@external(erlang, "ores_err_trace_ffi", "join_fields")
fn join_fields(values: List(String)) -> String

@external(erlang, "ores_err_trace_ffi", "truncate_512")
fn truncate_512(value: String) -> String

fn optional_string(value: Option(String)) -> String {
  case value {
    Some(value) -> value
    None -> ""
  }
}

fn optional_string_or(value: Option(String), fallback: String) -> String {
  case value {
    Some(value) -> value
    None -> fallback
  }
}

fn optional_list(value: Option(List(String))) -> List(String) {
  case value {
    Some(value) -> value
    None -> []
  }
}

fn exception_name(event: ErrorEvent) -> String {
  case event.exception_type {
    Some(value) -> value
    None -> optional_string(event.error_type)
  }
}

fn dd_error_type(event: ErrorEvent) -> String {
  case event.error_type {
    Some(value) -> value
    None -> case event.exception_type {
      Some(value) -> value
      None -> "unknown"
    }
  }
}

fn to_dd_next_compat_event(event: ErrorEvent) -> DdNextCompatEvent {
  let error_type = dd_error_type(event)
  DdNextCompatEvent(
    environment: optional_string_or(event.environment, "unknown-env"),
    release_sha: optional_string(event.release_sha),
    error_code: optional_string_or(event.error_code, "DEFAULT"),
    error_type: error_type,
    severity: optional_string_or(event.severity, error_type),
    runtime: optional_string_or(event.runtime, "unknown-runtime"),
    source: optional_string(event.source),
    routine_id: optional_string(event.routine_id),
    repository: optional_string(event.repository),
    file_name: optional_string(event.file_name),
    message: optional_string(event.message),
    error_list: optional_list(event.error_list),
  )
}

pub fn new_error_event(service: String) -> ErrorEvent {
  ErrorEvent(
    service: service,
    exception_type: None,
    error_type: None,
    error_code: None,
    message: None,
    error_list: None,
    top_frame: None,
    operation: None,
    repository: None,
    environment: None,
    release_sha: None,
    trace_id: None,
    parent_trace_id: None,
    otel_trace_id: None,
    otel_span_id: None,
    severity: None,
    runtime: None,
    source: None,
    routine_id: None,
    file_name: None,
  )
}

pub fn fingerprint_policy_wire(policy: FingerprintPolicy) -> String {
  case policy {
    PreferredV1 -> "v1"
    DdNextCompatV2 -> "dd-next-compat-v2"
  }
}

pub fn normalize_message(value: String) -> String {
  normalize_message_ffi(value)
}

pub fn normalize_dd_next_text(value: String) -> String {
  normalize_dd_next_text_ffi(value)
}

pub fn normalize_frame(value: String) -> String {
  normalize_frame_ffi(value)
}

pub fn canonical_key(event: ErrorEvent) -> String {
  prefix
  <> sep <> normalize_ident_ffi(event.service)
  <> sep <> normalize_ident_ffi(exception_name(event))
  <> sep <> normalize_message(optional_string(event.message))
  <> sep <> normalize_frame(optional_string(event.top_frame))
  <> sep <> normalize_ident_ffi(optional_string(event.operation))
}

pub fn fingerprint(event: ErrorEvent) -> String {
  sha256_hex(canonical_key(event))
}

pub fn dd_next_compat_canonical_key(event: DdNextCompatEvent) -> String {
  let normalized_list =
    event.error_list
    |> list.filter(fn(value) { string.trim(value) != "" })
    |> list.take(3)
    |> list.map(normalize_dd_next_text)

  let normalized_message = case event.message {
    "" -> case normalized_list {
      [first, ..] -> first
      _ -> "unknown-error"
    }
    message -> normalize_dd_next_text(message)
  }

  list.append(
    [
      dd_prefix,
      normalize_ident_ffi(event.environment),
      event.release_sha,
      event.error_code,
      event.error_type,
      event.severity,
      event.runtime,
      event.source,
      event.routine_id,
      event.repository,
      event.file_name,
      normalized_message,
    ],
    normalized_list,
  )
  |> join_fields
}

pub fn dd_next_compat_fingerprint(event: DdNextCompatEvent) -> String {
  dd_next_compat_version <> ":" <> sha256_hex(dd_next_compat_canonical_key(event))
}

pub fn fingerprint_envelope(event: ErrorEvent, policy: FingerprintPolicy) -> FingerprintEnvelope {
  let value = case policy {
    PreferredV1 -> fingerprint(event)
    DdNextCompatV2 -> dd_next_compat_fingerprint(to_dd_next_compat_event(event))
  }
  FingerprintEnvelope(
    policy: policy,
    fingerprint: value,
    service: normalize_ident_ffi(event.service),
  )
}

pub fn lock_key_for_fingerprint(service: String, fingerprint: String) -> String {
  let key =
    "oresoftware/err-trace/fingerprint:"
    <> normalize_ident_ffi(service)
    <> ":"
    <> fingerprint
  truncate_512(key)
}

pub fn requires_coordination(operation: CoordinationOperation) -> Bool {
  case operation {
    RecordOccurrence -> False
    _ -> True
  }
}

pub fn coordination_intent(
  operation: CoordinationOperation,
  service: String,
  fingerprint: String,
) -> CoordinationIntent {
  let requires_lock = requires_coordination(operation)
  CoordinationIntent(
    operation: operation,
    requires_lock: requires_lock,
    lock_key: case requires_lock {
      True -> Some(lock_key_for_fingerprint(service, fingerprint))
      False -> None
    },
  )
}
