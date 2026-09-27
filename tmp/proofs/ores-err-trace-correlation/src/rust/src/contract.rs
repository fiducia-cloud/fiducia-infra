use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

use crate::{
    dd_next_compat_fingerprint, fingerprint, lock_key_for_fingerprint, requires_coordination,
    CoordinationOperation, ErrorEvent,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FingerprintPolicy {
    #[serde(rename = "v1")]
    PreferredV1,
    #[serde(rename = "dd-next-compat-v2")]
    DdNextCompatV2,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FingerprintEnvelope {
    pub policy: FingerprintPolicy,
    pub fingerprint: String,
    pub service: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DedupeRecordResult {
    pub id: String,
    pub policy: FingerprintPolicy,
    pub fingerprint: String,
    pub occurrence_count: i64,
    pub inserted: bool,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoordinationIntent {
    pub operation: CoordinationOperation,
    pub requires_lock: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_key: Option<String>,
}

impl Serialize for CoordinationOperation {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(match self {
            CoordinationOperation::RecordOccurrence => "record_occurrence",
            CoordinationOperation::ReconcileFingerprintAlias => "reconcile_fingerprint_alias",
            CoordinationOperation::CompactOccurrenceHistory => "compact_occurrence_history",
            CoordinationOperation::EmitSingletonIssue => "emit_singleton_issue",
            CoordinationOperation::ResolveOnce => "resolve_once",
        })
    }
}

impl<'de> Deserialize<'de> for CoordinationOperation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "record_occurrence" => Ok(CoordinationOperation::RecordOccurrence),
            "reconcile_fingerprint_alias" => Ok(CoordinationOperation::ReconcileFingerprintAlias),
            "compact_occurrence_history" => Ok(CoordinationOperation::CompactOccurrenceHistory),
            "emit_singleton_issue" => Ok(CoordinationOperation::EmitSingletonIssue),
            "resolve_once" => Ok(CoordinationOperation::ResolveOnce),
            _ => Err(de::Error::unknown_variant(
                &value,
                &[
                    "record_occurrence",
                    "reconcile_fingerprint_alias",
                    "compact_occurrence_history",
                    "emit_singleton_issue",
                    "resolve_once",
                ],
            )),
        }
    }
}

pub fn fingerprint_envelope(event: &ErrorEvent, policy: FingerprintPolicy) -> FingerprintEnvelope {
    let fingerprint = match policy {
        FingerprintPolicy::PreferredV1 => fingerprint(event),
        FingerprintPolicy::DdNextCompatV2 => dd_next_compat_fingerprint(event),
    };
    FingerprintEnvelope {
        policy,
        fingerprint,
        service: event
            .service
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase(),
    }
}

pub fn coordination_intent(
    operation: CoordinationOperation,
    service: &str,
    fingerprint: &str,
) -> CoordinationIntent {
    let requires_lock = requires_coordination(operation);
    CoordinationIntent {
        operation,
        requires_lock,
        lock_key: requires_lock.then(|| lock_key_for_fingerprint(service, fingerprint)),
    }
}
