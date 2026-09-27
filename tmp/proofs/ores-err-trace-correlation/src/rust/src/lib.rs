use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod contract;
pub use contract::{
    coordination_intent, fingerprint_envelope, CoordinationIntent, DedupeRecordResult,
    FingerprintEnvelope, FingerprintPolicy,
};

pub const FINGERPRINT_VERSION: &str = "v1";
pub const DD_NEXT_COMPAT_VERSION: &str = "dd-next-compat-v2";
const PREFIX: &str = "ores-err-trace:v1";
const DD_PREFIX: &str = "ores-err-trace:dd-next-compat-v2";
const SEP: char = '\u{001f}';

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ErrorEvent {
    pub service: String,
    pub exception_type: Option<String>,
    pub error_type: Option<String>,
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub error_list: Option<Vec<String>>,
    pub top_frame: Option<String>,
    pub operation: Option<String>,
    pub repository: Option<String>,
    pub environment: Option<String>,
    pub release_sha: Option<String>,
    pub trace_id: Option<String>,
    pub parent_trace_id: Option<String>,
    pub otel_trace_id: Option<String>,
    pub otel_span_id: Option<String>,
    pub severity: Option<String>,
    pub runtime: Option<String>,
    pub source: Option<String>,
    pub routine_id: Option<String>,
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FingerprintedEvent {
    pub fingerprint_version: String,
    pub fingerprint: String,
    pub service: String,
    pub exception_type: String,
    pub normalized_message: String,
    pub normalized_top_frame: String,
    pub operation: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoordinationOperation {
    RecordOccurrence,
    ReconcileFingerprintAlias,
    CompactOccurrenceHistory,
    EmitSingletonIssue,
    ResolveOnce,
}

fn collapse_ws(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn safe_field(input: &str) -> String {
    input.replace(SEP, "<sep>")
}

pub fn normalize_message(input: &str) -> String {
    let mut s = collapse_ws(input.trim());
    let uuid = Regex::new(
        r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
    )
    .unwrap();
    let hex = Regex::new(r"(?i)\b0x[0-9a-f]+\b").unwrap();
    let long_num = Regex::new(r"\b\d{4,}\b").unwrap();
    s = uuid.replace_all(&s, "<uuid>").into_owned();
    s = hex.replace_all(&s, "<hex>").into_owned();
    long_num.replace_all(&s, "<n>").into_owned()
}

pub fn normalize_dd_next_text(input: &str) -> String {
    let mut s = input.to_string();
    let replacements = [
        (r"(?is)params:\s*[\s\S]*$", "params:<redacted>"),
        (r"\b(?:dd|ores)-trace-[A-Za-z0-9_-]+\b", "<trace-id>"),
        (r"\bddl-routine-[A-Za-z0-9_-]+\b", "<routine-id>"),
        (
            r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
            "<uuid>",
        ),
        (r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "<email>"),
        (
            r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b",
            "<iso-timestamp>",
        ),
        (
            r#""(traceId|requestId|browserSessionId|hashcode|canonicalHashcode|incomingHashcode)"\s*:\s*"[^"]*""#,
            r#""$1":"<redacted>""#,
        ),
        (
            r"(?i)\b(reqId|requestId|browserSessionId):[A-Za-z0-9_-]+\b",
            "$1:<id>",
        ),
        (r"\b\d{10,}\b", "<long-number>"),
    ];
    for (pattern, replacement) in replacements {
        let re = Regex::new(pattern).unwrap();
        s = re.replace_all(&s, replacement).into_owned();
    }
    collapse_ws(&s).chars().take(2000).collect()
}

pub fn normalize_frame(input: &str) -> String {
    let s = normalize_message(input);
    let line_col = Regex::new(r":\d+(?::\d+)?\)?$").unwrap();
    line_col.replace(&s, "").trim().to_string()
}

fn ident(input: Option<&str>) -> String {
    collapse_ws(input.unwrap_or_default().trim()).to_lowercase()
}

pub fn canonical_key(event: &ErrorEvent) -> String {
    let exception = event
        .exception_type
        .as_deref()
        .or(event.error_type.as_deref());
    [
        PREFIX.to_string(),
        ident(Some(&event.service)),
        ident(exception),
        normalize_message(event.message.as_deref().unwrap_or_default()),
        normalize_frame(event.top_frame.as_deref().unwrap_or_default()),
        ident(event.operation.as_deref()),
    ]
    .map(|v| safe_field(&v))
    .join(&SEP.to_string())
}

pub fn fingerprint(event: &ErrorEvent) -> String {
    let digest = Sha256::digest(canonical_key(event).as_bytes());
    format!("{digest:x}")
}

pub fn dd_next_compat_canonical_key(event: &ErrorEvent) -> String {
    let normalized_list = event
        .error_list
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|s| !s.trim().is_empty())
        .take(3)
        .map(|s| normalize_dd_next_text(s))
        .collect::<Vec<_>>();
    let error_type = event
        .error_type
        .as_deref()
        .or(event.exception_type.as_deref())
        .unwrap_or("unknown");
    let fallback_message = normalized_list
        .first()
        .map(String::as_str)
        .unwrap_or("unknown-error");
    let mut parts = vec![
        DD_PREFIX.to_string(),
        ident(Some(event.environment.as_deref().unwrap_or("unknown-env"))),
        event.release_sha.clone().unwrap_or_default(),
        event
            .error_code
            .clone()
            .unwrap_or_else(|| "DEFAULT".to_string()),
        error_type.to_string(),
        event
            .severity
            .clone()
            .unwrap_or_else(|| error_type.to_string()),
        event
            .runtime
            .clone()
            .unwrap_or_else(|| "unknown-runtime".to_string()),
        event.source.clone().unwrap_or_default(),
        event.routine_id.clone().unwrap_or_default(),
        event.repository.clone().unwrap_or_default(),
        event.file_name.clone().unwrap_or_default(),
        normalize_dd_next_text(event.message.as_deref().unwrap_or(fallback_message)),
    ];
    parts.extend(normalized_list);
    parts
        .into_iter()
        .map(|v| safe_field(&v))
        .collect::<Vec<_>>()
        .join(&SEP.to_string())
}

pub fn dd_next_compat_fingerprint(event: &ErrorEvent) -> String {
    let digest = Sha256::digest(dd_next_compat_canonical_key(event).as_bytes());
    format!("{DD_NEXT_COMPAT_VERSION}:{digest:x}")
}

pub fn lock_key_for_fingerprint(service: &str, fingerprint: &str) -> String {
    let key = format!(
        "oresoftware/err-trace/fingerprint:{}:{}",
        ident(Some(service)),
        fingerprint
    );
    key.chars().take(512).collect()
}

pub fn requires_coordination(operation: CoordinationOperation) -> bool {
    operation != CoordinationOperation::RecordOccurrence
}

pub fn enrich(event: &ErrorEvent) -> FingerprintedEvent {
    FingerprintedEvent {
        fingerprint_version: FINGERPRINT_VERSION.to_string(),
        fingerprint: fingerprint(event),
        service: ident(Some(&event.service)),
        exception_type: ident(
            event
                .exception_type
                .as_deref()
                .or(event.error_type.as_deref()),
        ),
        normalized_message: normalize_message(event.message.as_deref().unwrap_or_default()),
        normalized_top_frame: normalize_frame(event.top_frame.as_deref().unwrap_or_default()),
        operation: ident(event.operation.as_deref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ErrorEvent {
        ErrorEvent {
            service: "api".into(),
            exception_type: Some("DbError".into()),
            message: Some("user 123456 failed 550e8400-e29b-41d4-a716-446655440000".into()),
            top_frame: Some("src/db.rs:123:45".into()),
            operation: Some("POST /users/:id".into()),
            ..Default::default()
        }
    }

    #[test]
    fn volatile_values_do_not_change_fingerprint() {
        let mut a = base();
        let mut b = a.clone();
        b.message = Some("user 987654 failed d9428888-122b-11e1-b85c-61cd3cbb3210".into());
        b.top_frame = Some("src/db.rs:999:2".into());
        a.trace_id = Some("ores-trace-a".into());
        b.trace_id = Some("ores-trace-b".into());
        a.parent_trace_id = Some("ores-trace-parent-a".into());
        b.parent_trace_id = Some("ores-trace-parent-b".into());
        a.otel_trace_id = Some("11111111111111111111111111111111".into());
        b.otel_trace_id = Some("22222222222222222222222222222222".into());
        a.otel_span_id = Some("1111111111111111".into());
        b.otel_span_id = Some("2222222222222222".into());
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn dd_next_normalization_redacts_legacy_and_ore_volatile_values() {
        let a = "boom dd-trace-abc ddl-routine-def a@example.com 2026-09-15T10:11:12Z requestId:req-a 12345678901";
        let b = "boom ores-trace-xyz ddl-routine-ghi b@example.org 2025-01-01T00:00:00Z requestId:req-b 99999999999";
        assert_eq!(normalize_dd_next_text(a), normalize_dd_next_text(b));
    }

    #[test]
    fn dd_next_compat_is_commit_scoped() {
        let mut a = base();
        a.environment = Some("prod".into());
        a.error_code = Some("DB_TIMEOUT".into());
        a.error_type = Some("database".into());
        a.runtime = Some("nodejs".into());
        a.release_sha = Some("aaa".into());
        let mut b = a.clone();
        b.release_sha = Some("bbb".into());
        assert_ne!(
            dd_next_compat_fingerprint(&a),
            dd_next_compat_fingerprint(&b)
        );
    }

    #[test]
    fn dd_next_compat_ignores_legacy_and_ore_trace_volatility() {
        let mut a = base();
        a.environment = Some("prod".into());
        a.error_code = Some("E1".into());
        a.error_type = Some("database".into());
        a.runtime = Some("nodejs".into());
        a.message = Some("boom dd-trace-one requestId:req-a".into());
        let mut b = a.clone();
        b.message = Some("boom ores-trace-two requestId:req-b".into());
        assert_eq!(
            dd_next_compat_fingerprint(&a),
            dd_next_compat_fingerprint(&b)
        );
    }

    #[test]
    fn locking_policy_avoids_hot_path_lock() {
        assert!(!requires_coordination(
            CoordinationOperation::RecordOccurrence
        ));
        for op in [
            CoordinationOperation::ReconcileFingerprintAlias,
            CoordinationOperation::CompactOccurrenceHistory,
            CoordinationOperation::EmitSingletonIssue,
            CoordinationOperation::ResolveOnce,
        ] {
            assert!(requires_coordination(op));
        }
        assert!(lock_key_for_fingerprint("API Service", "abc")
            .starts_with("oresoftware/err-trace/fingerprint:api service:abc"));
        assert!(
            lock_key_for_fingerprint(&"x".repeat(1000), &"f".repeat(64))
                .chars()
                .count()
                <= 512
        );
    }
}
