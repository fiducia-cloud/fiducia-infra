use ores_err_trace::{
    dd_next_compat_fingerprint, lock_key_for_fingerprint, normalize_dd_next_text, ErrorEvent,
};

fn base() -> ErrorEvent {
    ErrorEvent {
        service: "api".into(),
        environment: Some("prod".into()),
        error_code: Some("E1".into()),
        error_type: Some("database".into()),
        runtime: Some("nodejs".into()),
        ..Default::default()
    }
}

#[test]
fn dd_next_normalization_truncates_by_unicode_code_point() {
    let got = normalize_dd_next_text(&"é".repeat(2001));
    assert_eq!(got.chars().count(), 2000);
    assert_eq!(got, "é".repeat(2000));
}

#[test]
fn dd_next_compatibility_ignores_blank_error_list_entries() {
    let mut a = base();
    a.error_list = Some(vec![
        "   ".into(),
        "\t".into(),
        "boom requestId:req-a".into(),
    ]);
    let mut b = base();
    b.error_list = Some(vec!["boom requestId:req-b".into()]);
    assert_eq!(
        dd_next_compat_fingerprint(&a),
        dd_next_compat_fingerprint(&b)
    );
}

#[test]
fn lock_keys_are_bounded_by_unicode_code_points() {
    let key = lock_key_for_fingerprint(&"🙂".repeat(1000), &"f".repeat(64));
    assert!(key.chars().count() <= 512);
}
