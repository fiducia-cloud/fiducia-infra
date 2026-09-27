use ores_err_trace::{fingerprint, ErrorEvent};

#[test]
fn fingerprint_v1_parity() {
    let event = ErrorEvent {
        service: "api".into(),
        exception_type: Some("DbError".into()),
        message: Some("user 123456 failed 550e8400-e29b-41d4-a716-446655440000".into()),
        top_frame: Some("src/db.rs:123:45".into()),
        operation: Some("POST /users/:id".into()),
        ..Default::default()
    };
    assert_eq!(
        fingerprint(&event),
        "1e2b57e748fec5876089424b64262899703db3df6ce62b6fb5416c0d7c239652"
    );
}
