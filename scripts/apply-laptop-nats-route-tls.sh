#!/usr/bin/env bash
# Validate and materialize the dedicated NATS route CA and leaf identity for one
# laptop cluster. Client-account credentials remain in fiducia-nats-auth and are
# intentionally independent from this route-plane Secret.
set -euo pipefail
umask 077

cluster=""
context=""
tailnet_domain=""
cert_file=""
key_file=""
ca_file=""
apply="false"

usage() {
  cat <<'EOF'
usage:
  scripts/apply-laptop-nats-route-tls.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --tailnet-domain example.ts.net \
    --cert-file /secure/nats-route/tls.crt \
    --key-file /secure/nats-route/tls.key \
    --ca-file /secure/nats-route/ca.crt \
    [--apply]

Without --apply, validates identity, key matching, CA trust, SANs, lifetime, and
file permissions, then prints a redacted plan. No certificate or key content is
printed.
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
    --tailnet-domain) tailnet_domain="${2:-}"; shift 2 ;;
    --cert-file) cert_file="${2:-}"; shift 2 ;;
    --key-file) key_file="${2:-}"; shift 2 ;;
    --ca-file) ca_file="${2:-}"; shift 2 ;;
    --apply) apply="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$cluster" in
  laptop-aws-sim|laptop-gcp-sim|laptop-azure-sim) ;;
  *) fail "--cluster must name one of the three laptop clusters" ;;
esac
[[ -n "$context" ]] || fail "--context is required"
[[ "$tailnet_domain" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$ ]] \
  || fail "--tailnet-domain must be a concrete MagicDNS domain"

for command in openssl sha256sum stat; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

check_regular() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" && -s "$file" ]] \
    || fail "missing, empty, or symlinked file: $file"
}
check_private() {
  local file="$1"
  check_regular "$file"
  local mode
  mode="$(stat -c '%a' "$file")"
  (( (8#$mode & 8#077) == 0 )) \
    || fail "private-key file must not be group/world accessible: $file (mode $mode)"
}

check_regular "$cert_file"
check_private "$key_file"
check_regular "$ca_file"

openssl x509 -in "$cert_file" -noout >/dev/null 2>&1 || fail "invalid route certificate"
openssl x509 -in "$ca_file" -noout >/dev/null 2>&1 || fail "invalid route CA certificate"
openssl pkey -in "$key_file" -noout >/dev/null 2>&1 || fail "invalid route private key"
openssl verify -CAfile "$ca_file" "$cert_file" >/dev/null 2>&1 \
  || fail "route certificate is not trusted by the supplied route CA"
openssl x509 -in "$cert_file" -checkend 604800 -noout >/dev/null 2>&1 \
  || fail "route certificate expires in less than seven days"

cert_pub="$(openssl x509 -in "$cert_file" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
key_pub="$(openssl pkey -in "$key_file" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
[[ "$cert_pub" == "$key_pub" ]] || fail "route certificate and private key do not match"

san_output="$(openssl x509 -in "$cert_file" -noout -ext subjectAltName 2>/dev/null || true)"
tailnet_san="DNS:fiducia-nats-route-$cluster.$tailnet_domain"
service_san="DNS:fiducia-nats-route-$cluster-tailnet.fiducia.svc.cluster.local"
grep -Fq "$tailnet_san" <<<"$san_output" || fail "route certificate is missing SAN $tailnet_san"
grep -Fq "$service_san" <<<"$san_output" || fail "route certificate is missing SAN $service_san"

cert_fingerprint="$(openssl x509 -in "$cert_file" -outform DER | sha256sum | awk '{print $1}')"
ca_fingerprint="$(openssl x509 -in "$ca_file" -outform DER | sha256sum | awk '{print $1}')"

cat <<EOF
validated NATS route mTLS plan
  cluster: $cluster
  context: $context
  Secret: fiducia/fiducia-nats-route-tls
  certificate fingerprint: $cert_fingerprint
  CA fingerprint: $ca_fingerprint
  private key: redacted
  required SANs: present
EOF

[[ "$apply" == "true" ]] || exit 0
command -v kubectl >/dev/null || fail "kubectl is required for --apply"

mapfile -t matching_nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#matching_nodes[@]} -eq 1 ]] \
  || fail "context $context must expose exactly one node labeled for $cluster"

kubectl --context "$context" -n fiducia create secret generic fiducia-nats-route-tls \
  --from-file="tls.crt=$cert_file" \
  --from-file="tls.key=$key_file" \
  --from-file="ca.crt=$ca_file" \
  --dry-run=client -o yaml \
  | kubectl --context "$context" apply --server-side --field-manager=fiducia-nats-route-tls -f - >/dev/null

kubectl --context "$context" -n fiducia annotate secret fiducia-nats-route-tls --overwrite \
  "fiducia.cloud/cluster=$cluster" \
  "fiducia.cloud/purpose=nats-route-mtls" \
  "fiducia.cloud/certificate-sha256=$cert_fingerprint" \
  "fiducia.cloud/ca-sha256=$ca_fingerprint" >/dev/null

key_count="$(kubectl --context "$context" -n fiducia get secret fiducia-nats-route-tls -o go-template='{{len .data}}')"
[[ "$key_count" == "3" ]] || fail "route TLS Secret must contain exactly three keys"

echo "NATS route mTLS Secret materialized for $cluster; private key was not printed"
