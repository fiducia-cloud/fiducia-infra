package errtrace_test

import (
	"encoding/json"
	"testing"

	errtrace "github.com/ORESoftware/ores-err-trace/go"
)

func TestPublicContractSurfaceIsExternallyUsable(t *testing.T) {
	event := errtrace.ErrorEvent{
		Service:       "api",
		ExceptionType: "DbError",
		Message:       "user 123456 failed 550e8400-e29b-41d4-a716-446655440000",
		TopFrame:      "src/db.rs:123:45",
		Operation:     "POST /users/:id",
	}
	if got := errtrace.Fingerprint(event); got != "1e2b57e748fec5876089424b64262899703db3df6ce62b6fb5416c0d7c239652" {
		t.Fatalf("public fingerprint mismatch: %s", got)
	}

	envelope, err := errtrace.BuildFingerprintEnvelope(event, errtrace.FingerprintPolicyPreferredV1)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Policy != errtrace.FingerprintPolicyPreferredV1 || envelope.Service != "api" {
		t.Fatalf("unexpected public envelope: %#v", envelope)
	}
	if envelope.Fingerprint != errtrace.Fingerprint(event) {
		t.Fatal("public envelope fingerprint diverged from v1 fingerprint")
	}

	result := errtrace.DedupeRecordResult{
		ID:              "row-1",
		Policy:          errtrace.FingerprintPolicyPreferredV1,
		Fingerprint:     envelope.Fingerprint,
		OccurrenceCount: 1,
		Inserted:        true,
		FirstSeenAt:     "2026-09-15T12:00:00Z",
		LastSeenAt:      "2026-09-15T12:00:00Z",
	}
	if !result.Inserted {
		t.Fatal("public dedupe result must be constructible")
	}

	hot, err := errtrace.BuildCoordinationIntent(errtrace.RecordOccurrence, event.Service, envelope.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if hot.RequiresLock || hot.LockKey != "" {
		t.Fatalf("hot-path occurrence must remain lock-free: %#v", hot)
	}

	singleton, err := errtrace.BuildCoordinationIntent(errtrace.EmitSingletonIssue, event.Service, envelope.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if !singleton.RequiresLock || singleton.LockKey == "" {
		t.Fatalf("singleton external side effect must carry a lock key: %#v", singleton)
	}
}

func TestBuildersRejectInvalidStringBackedEnums(t *testing.T) {
	event := errtrace.ErrorEvent{Service: "api"}
	if errtrace.ValidFingerprintPolicy(errtrace.FingerprintPolicy("invalid")) {
		t.Fatal("invalid fingerprint policy unexpectedly admitted")
	}
	if _, err := errtrace.BuildFingerprintEnvelope(event, errtrace.FingerprintPolicy("invalid")); err == nil {
		t.Fatal("invalid fingerprint policy unexpectedly produced an envelope")
	}

	if errtrace.ValidCoordinationOperation(errtrace.CoordinationOperation("invalid")) {
		t.Fatal("invalid coordination operation unexpectedly admitted")
	}
	if _, err := errtrace.BuildCoordinationIntent(errtrace.CoordinationOperation("invalid"), "api", "abc"); err == nil {
		t.Fatal("invalid coordination operation unexpectedly produced an intent")
	}
}

func TestJSONWireValuesMatchPeerContracts(t *testing.T) {
	event := errtrace.ErrorEvent{Service: "api"}
	envelope, err := errtrace.BuildFingerprintEnvelope(event, errtrace.FingerprintPolicyPreferredV1)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	var envelopeJSON map[string]any
	if err := json.Unmarshal(payload, &envelopeJSON); err != nil {
		t.Fatal(err)
	}
	if envelopeJSON["policy"] != "v1" || envelopeJSON["service"] != "api" {
		t.Fatalf("unexpected envelope JSON: %s", payload)
	}

	hot, err := errtrace.BuildCoordinationIntent(errtrace.RecordOccurrence, "api", envelope.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	payload, err = json.Marshal(hot)
	if err != nil {
		t.Fatal(err)
	}
	var hotJSON map[string]any
	if err := json.Unmarshal(payload, &hotJSON); err != nil {
		t.Fatal(err)
	}
	if hotJSON["operation"] != "record_occurrence" || hotJSON["requires_lock"] != false {
		t.Fatalf("unexpected hot-path JSON: %s", payload)
	}
	if _, present := hotJSON["lock_key"]; present {
		t.Fatalf("lock_key must be omitted for lock-free occurrence path: %s", payload)
	}
}
