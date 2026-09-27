package errtrace

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestFingerprintV1Parity(t *testing.T) {
	e := ErrorEvent{
		Service:       "api",
		ExceptionType: "DbError",
		Message:       "user 123456 failed 550e8400-e29b-41d4-a716-446655440000",
		TopFrame:      "src/db.rs:123:45",
		Operation:     "POST /users/:id",
	}
	want := "1e2b57e748fec5876089424b64262899703db3df6ce62b6fb5416c0d7c239652"
	if got := Fingerprint(e); got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestPreferredFingerprintIgnoresOccurrenceMetadata(t *testing.T) {
	a := ErrorEvent{
		Service: "api", ExceptionType: "DbError", Message: "failed id 123456",
		TopFrame: "db.go:10:2", Operation: "worker", TraceID: "ores-trace-a",
		ParentTraceID: "ores-trace-ParentTraceA12",
		OTelTraceID: "11111111111111111111111111111111",
		OTelSpanID: "1111111111111111", ReleaseSHA: "aaa",
	}
	b := a
	b.TraceID = "ores-trace-b"
	b.ParentTraceID = "ores-trace-ParentTraceB12"
	b.OTelTraceID = "22222222222222222222222222222222"
	b.OTelSpanID = "2222222222222222"
	b.ReleaseSHA = "bbb"
	if Fingerprint(a) != Fingerprint(b) {
		t.Fatal("v1 must ignore trace/release/native OTel occurrence metadata")
	}
}

func TestDDNextNormalizationRedactsLegacyAndOREVolatileValues(t *testing.T) {
	a := "boom dd-trace-abc ddl-routine-def a@example.com 2026-09-15T10:11:12Z requestId:req-a 12345678901"
	b := "boom ores-trace-xyz ddl-routine-ghi b@example.org 2025-01-01T00:00:00Z requestId:req-b 99999999999"
	if NormalizeDDNextText(a) != NormalizeDDNextText(b) {
		t.Fatalf("normalizations differ: %q != %q", NormalizeDDNextText(a), NormalizeDDNextText(b))
	}
}

func TestDDNextNormalizationRedactsParamsTail(t *testing.T) {
	if got := NormalizeDDNextText(`db failed params: {"password":"secret"}`); got != "db failed params:<redacted>" {
		t.Fatalf("unexpected normalization: %q", got)
	}
}

func TestDDNextNormalizationTruncatesByUnicodeCodePoint(t *testing.T) {
	got := NormalizeDDNextText(strings.Repeat("é", 2001))
	if utf8.RuneCountInString(got) != 2000 {
		t.Fatalf("expected 2000 code points, got %d", utf8.RuneCountInString(got))
	}
	if got != strings.Repeat("é", 2000) {
		t.Fatal("unicode truncation changed normalized content")
	}
}

func TestDDNextCompatibilityIgnoresBlankErrorListEntries(t *testing.T) {
	base := ErrorEvent{Service: "api", Environment: "prod", ErrorCode: "E1", ErrorType: "database", Runtime: "nodejs"}
	a := base
	a.ErrorList = []string{"   ", "\t", "boom requestId:req-a"}
	b := base
	b.ErrorList = []string{"boom requestId:req-b"}
	if DDNextCompatFingerprint(a) != DDNextCompatFingerprint(b) {
		t.Fatal("blank error-list entries must not change fallback fingerprint selection")
	}
}

func TestDDNextCompatibilityIsCommitScoped(t *testing.T) {
	base := ErrorEvent{Service: "api", Environment: "prod", ErrorCode: "DB_TIMEOUT", ErrorType: "database", Message: "query failed", Runtime: "nodejs", Source: "dd-nodejs-log"}
	a := base
	a.ReleaseSHA = "aaa"
	b := base
	b.ReleaseSHA = "bbb"
	if DDNextCompatFingerprint(a) == DDNextCompatFingerprint(b) {
		t.Fatal("compat fingerprint must preserve dd-next commit scoping")
	}
}

func TestDDNextCompatibilityIgnoresTraceVolatility(t *testing.T) {
	base := ErrorEvent{Service: "api", Environment: "prod", ErrorCode: "E1", ErrorType: "database", Runtime: "nodejs"}
	a := base
	a.Message = "boom dd-trace-one requestId:req-a"
	b := base
	b.Message = "boom ores-trace-two requestId:req-b"
	if DDNextCompatFingerprint(a) != DDNextCompatFingerprint(b) {
		t.Fatal("legacy and ORE trace ids should normalize to the same compatibility fingerprint")
	}
}

func TestCoordinationPolicy(t *testing.T) {
	if RequiresCoordination(RecordOccurrence) {
		t.Fatal("single-row occurrence upsert must not require a distributed lock")
	}
	for _, op := range []CoordinationOperation{ReconcileFingerprintAlias, CompactOccurrenceHistory, EmitSingletonIssue, ResolveOnce} {
		if !RequiresCoordination(op) {
			t.Fatalf("%s should require coordination", op)
		}
	}
	if key := LockKeyForFingerprint("API Service", "abc"); !strings.HasPrefix(key, "oresoftware/err-trace/fingerprint:api service:abc") {
		t.Fatalf("bad lock key: %s", key)
	}
	if got := len([]rune(LockKeyForFingerprint(strings.Repeat("x", 1000), strings.Repeat("f", 64)))); got > 512 {
		t.Fatalf("lock key exceeded 512 characters: %d", got)
	}
	if got := len([]rune(LockKeyForFingerprint(strings.Repeat("🙂", 1000), strings.Repeat("f", 64)))); got > 512 {
		t.Fatalf("unicode lock key exceeded 512 characters: %d", got)
	}
}
