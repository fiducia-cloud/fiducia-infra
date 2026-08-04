#!/usr/bin/env bash
# Capture redacted certificate/trust evidence without reading or exporting the
# serving private key. This script performs no rollout, renewal, or Secret write.
set -euo pipefail
umask 077

cluster=""
context=""
output=""

usage() {
  cat <<'EOF'
usage:
  scripts/capture-fiducia-internal-tls-evidence.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --output /secure/evidence/fiducia-tls-laptop-aws-sim.json

The script reads only tls.crt and ca.crt from fiducia-load-balance-tls. It never
requests tls.key, never prints certificate bytes, and writes mode-0600 JSON.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --context) context="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$cluster" in
  laptop-aws-sim|laptop-gcp-sim|laptop-azure-sim|hetzner|vultr|civo) ;;
  *) fail "--cluster must name an approved Fiducia cluster" ;;
esac
[[ -n "$context" ]] || fail "--context is required"
[[ "$output" = /* ]] || fail "--output must be an absolute path"

for command in kubectl openssl jq base64 sha256sum install mktemp date grep awk; do
  command -v "$command" >/dev/null || fail "$command is required"
done

mapfile -t matching_nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster" \
    -o name
)
[[ ${#matching_nodes[@]} -ge 1 ]] \
  || fail "context $context has no node labeled fiducia.cloud/cluster=$cluster"

certificate_ready="$(
  kubectl --context "$context" -n fiducia get certificate.cert-manager.io fiducia-load-balance-tls \
    -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{end}'
)"
[[ "$certificate_ready" == "True" ]] || fail "Certificate/fiducia-load-balance-tls is not Ready"

secret_type="$(
  kubectl --context "$context" -n fiducia get secret fiducia-load-balance-tls \
    -o jsonpath='{.type}'
)"
[[ "$secret_type" == "kubernetes.io/tls" ]] || fail "unexpected serving Secret type: $secret_type"

key_names="$(
  kubectl --context "$context" -n fiducia get secret fiducia-load-balance-tls \
    -o go-template='{{range $key, $_ := .data}}{{$key}}{{"\n"}}{{end}}' \
    | sort
)"
[[ "$key_names" == $'ca.crt\ntls.crt\ntls.key' ]] \
  || fail "serving Secret must contain exactly ca.crt, tls.crt, and tls.key"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Deliberately request only public certificate material. Do not change these
# jsonpaths to `.data`, and never request `.data.tls\.key`.
kubectl --context "$context" -n fiducia get secret fiducia-load-balance-tls \
  -o jsonpath='{.data.tls\.crt}' \
  | base64 -d >"$tmpdir/tls.crt"
kubectl --context "$context" -n fiducia get secret fiducia-load-balance-tls \
  -o jsonpath='{.data.ca\.crt}' \
  | base64 -d >"$tmpdir/ca.crt"
chmod 600 "$tmpdir/tls.crt" "$tmpdir/ca.crt"

openssl verify -CAfile "$tmpdir/ca.crt" "$tmpdir/tls.crt" >/dev/null
openssl x509 -in "$tmpdir/tls.crt" -noout -checkend 604800 >/dev/null \
  || fail "serving certificate expires in less than seven days"

leaf_text="$(openssl x509 -in "$tmpdir/tls.crt" -noout -text)"
ca_text="$(openssl x509 -in "$tmpdir/ca.crt" -noout -text)"
grep -q 'CA:FALSE' <<<"$leaf_text" || fail "serving certificate is not an end-entity certificate"
grep -q 'TLS Web Server Authentication' <<<"$leaf_text" || fail "serving certificate lacks serverAuth EKU"
grep -q 'CA:TRUE' <<<"$ca_text" || fail "trust certificate is not a CA"

required_sans=(
  fiducia-load-balance.fiducia.svc.cluster.local
  fiducia-load-balance-tls.fiducia.svc.cluster.local
)
for dns_name in "${required_sans[@]}"; do
  grep -q "DNS:$dns_name" <<<"$leaf_text" || fail "serving certificate lacks DNS SAN $dns_name"
done

leaf_fingerprint="$(openssl x509 -in "$tmpdir/tls.crt" -noout -fingerprint -sha256 | sed 's/^.*=//' | tr -d ':' | tr 'A-F' 'a-f')"
ca_fingerprint="$(openssl x509 -in "$tmpdir/ca.crt" -noout -fingerprint -sha256 | sed 's/^.*=//' | tr -d ':' | tr 'A-F' 'a-f')"
leaf_serial="$(openssl x509 -in "$tmpdir/tls.crt" -noout -serial | sed 's/^serial=//' | tr 'A-F' 'a-f')"
not_before="$(openssl x509 -in "$tmpdir/tls.crt" -noout -startdate | sed 's/^notBefore=//')"
not_after="$(openssl x509 -in "$tmpdir/tls.crt" -noout -enddate | sed 's/^notAfter=//')"
certificate_revision="$(
  kubectl --context "$context" -n fiducia get certificate.cert-manager.io fiducia-load-balance-tls \
    -o jsonpath='{.status.revision}'
)"

install -d -m 700 "$(dirname "$output")"
temporary="$(mktemp "${output}.tmp.XXXXXX")"
trap 'rm -rf "$tmpdir"; rm -f "$temporary"' EXIT

jq -n -S \
  --arg cluster "$cluster" \
  --arg context "$context" \
  --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg certificateName "fiducia-load-balance-tls" \
  --arg secretName "fiducia-load-balance-tls" \
  --arg revision "$certificate_revision" \
  --arg leafFingerprint "$leaf_fingerprint" \
  --arg caFingerprint "$ca_fingerprint" \
  --arg leafSerial "$leaf_serial" \
  --arg notBefore "$not_before" \
  --arg notAfter "$not_after" \
  --argjson sans "$(printf '%s\n' "${required_sans[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')" \
  '{
    schemaVersion: 1,
    evidenceMode: "live-capture",
    cluster: $cluster,
    context: $context,
    observedAt: $observedAt,
    certificate: {
      name: $certificateName,
      secretName: $secretName,
      ready: true,
      revision: $revision,
      leafSha256Fingerprint: $leafFingerprint,
      caSha256Fingerprint: $caFingerprint,
      leafSerial: $leafSerial,
      notBefore: $notBefore,
      notAfter: $notAfter,
      requiredSans: $sans,
      chainVerified: true,
      minimumRemainingLifetimeSeconds: 604800
    },
    redaction: {
      privateKey: "not-read",
      certificateBytes: "not-emitted",
      caBytes: "not-emitted",
      secretValues: "not-emitted"
    }
  }' >"$temporary"

chmod 600 "$temporary"
mv -f "$temporary" "$output"
trap 'rm -rf "$tmpdir"' EXIT
printf 'wrote redacted Fiducia TLS evidence: %s\n' "$output"
