use ores_err_trace::{
    coordination_intent, fingerprint_envelope, CoordinationOperation, DedupeRecordResult,
    ErrorEvent, FingerprintPolicy,
};
use serde_json::json;

#[test]
fn public_contract_surface_is_externally_usable() {
    let event = ErrorEvent {
        service: "api".into(),
        exception_type: Some("DbError".into()),
        message: Some("user 123456 failed 550e8400-e29b-41d4-a716-446655440000".into()),
        top_frame: Some("src/db.rs:123:45".into()),
        operation: Some("POST /users/:id".into()),
        ..Default::default()
    };

    let envelope = fingerprint_envelope(&event, FingerprintPolicy::PreferredV1);
    assert_eq!(
        envelope.fingerprint,
        "1e2b57e748fec5876089424b64262899703db3df6ce62b6fb5416c0d7c239652"
    );
    assert_eq!(envelope.service, "api");

    let result = DedupeRecordResult {
        id: "row-1".into(),
        policy: FingerprintPolicy::PreferredV1,
        fingerprint: envelope.fingerprint.clone(),
        occurrence_count: 1,
        inserted: true,
        first_seen_at: "2026-09-15T12:00:00Z".into(),
        last_seen_at: "2026-09-15T12:00:00Z".into(),
    };
    assert!(result.inserted);

    let hot = coordination_intent(
        CoordinationOperation::RecordOccurrence,
        &event.service,
        &envelope.fingerprint,
    );
    assert!(!hot.requires_lock);
    assert!(hot.lock_key.is_none());

    let singleton = coordination_intent(
        CoordinationOperation::EmitSingletonIssue,
        &event.service,
        &envelope.fingerprint,
    );
    assert!(singleton.requires_lock);
    assert!(
        singleton
            .lock_key
            .as_ref()
            .is_some_and(|key| key.chars().count() <= 512)
    );
}

#[test]
fn json_wire_values_match_peer_contracts() {
    let event = ErrorEvent {
        service: "api".into(),
        ..Default::default()
    };
    let envelope = fingerprint_envelope(&event, FingerprintPolicy::PreferredV1);
    let envelope_json = serde_json::to_value(&envelope).expect("serialize fingerprint envelope");
    assert_eq!(envelope_json["policy"], json!("v1"));
    assert_eq!(envelope_json["service"], json!("api"));

    let hot = coordination_intent(
        CoordinationOperation::RecordOccurrence,
        &event.service,
        &envelope.fingerprint,
    );
    assert_eq!(
        serde_json::to_value(&hot).expect("serialize coordination intent"),
        json!({
            "operation": "record_occurrence",
            "requires_lock": false
        })
    );

    let singleton = coordination_intent(
        CoordinationOperation::EmitSingletonIssue,
        &event.service,
        &envelope.fingerprint,
    );
    let singleton_json = serde_json::to_value(&singleton).expect("serialize singleton intent");
    assert_eq!(singleton_json["operation"], json!("emit_singleton_issue"));
    assert_eq!(singleton_json["requires_lock"], json!(true));
    assert!(singleton_json["lock_key"].as_str().is_some());
}
