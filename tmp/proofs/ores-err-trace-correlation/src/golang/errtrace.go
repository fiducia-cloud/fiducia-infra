package errtrace

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
)

const FingerprintVersion = "v1"
const DDNextCompatVersion = "dd-next-compat-v2"
const prefix = "ores-err-trace:v1"
const ddPrefix = "ores-err-trace:dd-next-compat-v2"
const sep = "\x1f"

type FingerprintPolicy string

const (
	FingerprintPolicyPreferredV1    FingerprintPolicy = "v1"
	FingerprintPolicyDDNextCompatV2 FingerprintPolicy = "dd-next-compat-v2"
)

// ErrorEvent is the public Go projection of the cross-runtime error event contract.
type ErrorEvent struct {
	Service       string   `json:"service"`
	ExceptionType string   `json:"exception_type,omitempty"`
	ErrorType     string   `json:"error_type,omitempty"`
	ErrorCode     string   `json:"error_code,omitempty"`
	Message       string   `json:"message,omitempty"`
	ErrorList     []string `json:"error_list,omitempty"`
	TopFrame      string   `json:"top_frame,omitempty"`
	Operation     string   `json:"operation,omitempty"`
	Repository    string   `json:"repository,omitempty"`
	Environment   string   `json:"environment,omitempty"`
	ReleaseSHA    string   `json:"release_sha,omitempty"`
	TraceID       string   `json:"trace_id,omitempty"`
	ParentTraceID string   `json:"parent_trace_id,omitempty"`
	OTelTraceID   string   `json:"otel_trace_id,omitempty"`
	OTelSpanID    string   `json:"otel_span_id,omitempty"`
	Severity      string   `json:"severity,omitempty"`
	Runtime       string   `json:"runtime,omitempty"`
	Source        string   `json:"source,omitempty"`
	RoutineID     string   `json:"routine_id,omitempty"`
	FileName      string   `json:"file_name,omitempty"`
}

type FingerprintEnvelope struct {
	Policy      FingerprintPolicy `json:"policy"`
	Fingerprint string            `json:"fingerprint"`
	Service     string            `json:"service"`
}

type DedupeRecordResult struct {
	ID              string            `json:"id"`
	Policy          FingerprintPolicy `json:"policy"`
	Fingerprint     string            `json:"fingerprint"`
	OccurrenceCount int64             `json:"occurrence_count"`
	Inserted        bool              `json:"inserted"`
	FirstSeenAt     string            `json:"first_seen_at"`
	LastSeenAt      string            `json:"last_seen_at"`
}

// CoordinationOperation describes whether an err-trace action needs cross-resource coordination.
type CoordinationOperation string

const (
	RecordOccurrence          CoordinationOperation = "record_occurrence"
	ReconcileFingerprintAlias CoordinationOperation = "reconcile_fingerprint_alias"
	CompactOccurrenceHistory  CoordinationOperation = "compact_occurrence_history"
	EmitSingletonIssue        CoordinationOperation = "emit_singleton_issue"
	ResolveOnce               CoordinationOperation = "resolve_once"
)

type CoordinationIntent struct {
	Operation    CoordinationOperation `json:"operation"`
	RequiresLock bool                  `json:"requires_lock"`
	LockKey      string                `json:"lock_key,omitempty"`
}

var (
	uuidRE        = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b`)
	hexRE         = regexp.MustCompile(`(?i)\b0x[0-9a-f]+\b`)
	longNumRE     = regexp.MustCompile(`\b\d{4,}\b`)
	lineColRE     = regexp.MustCompile(`:\d+(?::\d+)?\)?$`)
	paramsRE      = regexp.MustCompile(`(?is)params:\s*[\s\S]*$`)
	traceRE       = regexp.MustCompile(`\b(?:dd|ores)-trace-[A-Za-z0-9_-]+\b`)
	routineRE     = regexp.MustCompile(`\bddl-routine-[A-Za-z0-9_-]+\b`)
	emailRE       = regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`)
	isoRE         = regexp.MustCompile(`\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b`)
	jsonIDRE      = regexp.MustCompile(`"(traceId|requestId|browserSessionId|hashcode|canonicalHashcode|incomingHashcode)"\s*:\s*"[^"]*"`)
	namedIDRE     = regexp.MustCompile(`(?i)\b(reqId|requestId|browserSessionId):[A-Za-z0-9_-]+\b`)
	veryLongNumRE = regexp.MustCompile(`\b\d{10,}\b`)
)

func collapseWS(s string) string { return strings.Join(strings.Fields(strings.TrimSpace(s)), " ") }
func ident(s string) string      { return strings.ToLower(collapseWS(s)) }
func safeField(s string) string  { return strings.ReplaceAll(s, sep, "<sep>") }

func NormalizeMessage(s string) string {
	s = collapseWS(s)
	s = uuidRE.ReplaceAllString(s, "<uuid>")
	s = hexRE.ReplaceAllString(s, "<hex>")
	return longNumRE.ReplaceAllString(s, "<n>")
}

func NormalizeDDNextText(s string) string {
	s = paramsRE.ReplaceAllString(s, "params:<redacted>")
	s = traceRE.ReplaceAllString(s, "<trace-id>")
	s = routineRE.ReplaceAllString(s, "<routine-id>")
	s = uuidRE.ReplaceAllString(s, "<uuid>")
	s = emailRE.ReplaceAllString(s, "<email>")
	s = isoRE.ReplaceAllString(s, "<iso-timestamp>")
	s = jsonIDRE.ReplaceAllString(s, `"$1":"<redacted>"`)
	s = namedIDRE.ReplaceAllString(s, "$1:<id>")
	s = veryLongNumRE.ReplaceAllString(s, "<long-number>")
	s = collapseWS(s)
	if len([]rune(s)) > 2000 {
		s = string([]rune(s)[:2000])
	}
	return s
}

func NormalizeFrame(s string) string {
	return strings.TrimSpace(lineColRE.ReplaceAllString(NormalizeMessage(s), ""))
}

func CanonicalKey(e ErrorEvent) string {
	errorType := e.ExceptionType
	if errorType == "" {
		errorType = e.ErrorType
	}
	parts := []string{prefix, ident(e.Service), ident(errorType), NormalizeMessage(e.Message), NormalizeFrame(e.TopFrame), ident(e.Operation)}
	for i := range parts {
		parts[i] = safeField(parts[i])
	}
	return strings.Join(parts, sep)
}

func Fingerprint(e ErrorEvent) string {
	sum := sha256.Sum256([]byte(CanonicalKey(e)))
	return hex.EncodeToString(sum[:])
}

func DDNextCompatCanonicalKey(e ErrorEvent) string {
	errorType := e.ErrorType
	if errorType == "" {
		errorType = e.ExceptionType
	}
	if errorType == "" {
		errorType = "unknown"
	}
	severity := e.Severity
	if severity == "" {
		severity = errorType
	}
	runtime := e.Runtime
	if runtime == "" {
		runtime = "unknown-runtime"
	}
	env := e.Environment
	if env == "" {
		env = "unknown-env"
	}
	errorCode := e.ErrorCode
	if errorCode == "" {
		errorCode = "DEFAULT"
	}
	normList := make([]string, 0, 3)
	for _, item := range e.ErrorList {
		if strings.TrimSpace(item) == "" {
			continue
		}
		normList = append(normList, NormalizeDDNextText(item))
		if len(normList) == 3 {
			break
		}
	}
	msg := e.Message
	if msg == "" && len(normList) > 0 {
		msg = normList[0]
	}
	if msg == "" {
		msg = "unknown-error"
	}
	parts := []string{ddPrefix, ident(env), e.ReleaseSHA, errorCode, errorType, severity, runtime, e.Source, e.RoutineID, e.Repository, e.FileName, NormalizeDDNextText(msg)}
	parts = append(parts, normList...)
	for i := range parts {
		parts[i] = safeField(parts[i])
	}
	return strings.Join(parts, sep)
}

func DDNextCompatFingerprint(e ErrorEvent) string {
	sum := sha256.Sum256([]byte(DDNextCompatCanonicalKey(e)))
	return DDNextCompatVersion + ":" + hex.EncodeToString(sum[:])
}

func ValidFingerprintPolicy(policy FingerprintPolicy) bool {
	switch policy {
	case FingerprintPolicyPreferredV1, FingerprintPolicyDDNextCompatV2:
		return true
	default:
		return false
	}
}

func BuildFingerprintEnvelope(e ErrorEvent, policy FingerprintPolicy) (FingerprintEnvelope, error) {
	var value string
	switch policy {
	case FingerprintPolicyPreferredV1:
		value = Fingerprint(e)
	case FingerprintPolicyDDNextCompatV2:
		value = DDNextCompatFingerprint(e)
	default:
		return FingerprintEnvelope{}, fmt.Errorf("unsupported fingerprint policy: %q", policy)
	}
	return FingerprintEnvelope{Policy: policy, Fingerprint: value, Service: ident(e.Service)}, nil
}

func LockKeyForFingerprint(service, fingerprint string) string {
	key := "oresoftware/err-trace/fingerprint:" + ident(service) + ":" + fingerprint
	if len([]rune(key)) > 512 {
		return string([]rune(key)[:512])
	}
	return key
}

func ValidCoordinationOperation(op CoordinationOperation) bool {
	switch op {
	case RecordOccurrence, ReconcileFingerprintAlias, CompactOccurrenceHistory, EmitSingletonIssue, ResolveOnce:
		return true
	default:
		return false
	}
}

func RequiresCoordination(op CoordinationOperation) bool { return op != RecordOccurrence }

func BuildCoordinationIntent(op CoordinationOperation, service, fingerprint string) (CoordinationIntent, error) {
	if !ValidCoordinationOperation(op) {
		return CoordinationIntent{}, fmt.Errorf("unsupported coordination operation: %q", op)
	}
	requiresLock := RequiresCoordination(op)
	intent := CoordinationIntent{Operation: op, RequiresLock: requiresLock}
	if requiresLock {
		intent.LockKey = LockKeyForFingerprint(service, fingerprint)
	}
	return intent, nil
}
