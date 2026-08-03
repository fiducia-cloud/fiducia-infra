#!/usr/bin/env bash
# Materialize runtime credentials from root-readable files without putting secret
# values in Git, shell arguments, process listings, or command output.
set -euo pipefail
umask 077

cluster=""
context=""
cloudflare_token_file=""
s3_dir=""
apply="false"

usage() {
  cat <<'EOF_USAGE'
usage:
  scripts/apply-laptop-runtime-secrets.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --cloudflare-token-file /secure/cloudflare-token \
    --s3-config-dir /secure/k3s-s3 \
    [--apply]

The S3 directory must contain root-readable files named:
  etcd-s3-endpoint
  etcd-s3-access-key
  etcd-s3-secret-key
  etcd-s3-bucket
  etcd-s3-folder

Optional supported files:
  etcd-s3-endpoint-ca
  etcd-s3-endpoint-ca-name
  etcd-s3-skip-ssl-verify
  etcd-s3-session-token
  etcd-s3-bucket-lookup-type
  etcd-s3-region
  etcd-s3-insecure
  etcd-s3-timeout
  etcd-s3-proxy

Without --apply the script validates inputs and prints only object names.
EOF_USAGE
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --context) context="${2:-}"; shift 2 ;;
    --cloudflare-token-file) cloudflare_token_file="${2:-}"; shift 2 ;;
    --s3-config-dir) s3_dir="${2:-}"; shift 2 ;;
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
[[ -f "$cloudflare_token_file" && ! -L "$cloudflare_token_file" ]] \
  || fail "--cloudflare-token-file must be a regular non-symlink file"
[[ -s "$cloudflare_token_file" ]] || fail "Cloudflare token file is empty"
[[ -d "$s3_dir" && ! -L "$s3_dir" ]] || fail "--s3-config-dir must be a directory"

check_private_file() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" && -s "$file" ]] || fail "missing, empty, or symlinked secret file: $file"
  local mode
  mode="$(stat -c '%a' "$file")"
  (( (8#$mode & 8#077) == 0 )) || fail "secret file must not be group/world accessible: $file (mode $mode)"
  if grep -Eq 'CHANGEME|REPLACE_ME|EXTERNAL_|<[^>]+>' "$file"; then
    fail "secret file still contains a placeholder: $file"
  fi
}

read_scalar() {
  local file="$1"
  local value
  value="$(tr -d '\r\n' <"$file")"
  [[ -n "$value" ]] || fail "secret scalar is empty: $file"
  [[ "$value" =~ ^[^[:space:]]+$ ]] || fail "secret scalar contains whitespace: $file"
  printf '%s' "$value"
}

check_private_file "$cloudflare_token_file"
cloudflare_token="$(read_scalar "$cloudflare_token_file")"
[[ "$cloudflare_token" =~ ^eyJ[A-Za-z0-9._-]{97,}$ ]] \
  || fail "Cloudflare token does not match the expected remotely managed tunnel token shape"
unset cloudflare_token

required_s3_keys=(
  etcd-s3-endpoint
  etcd-s3-access-key
  etcd-s3-secret-key
  etcd-s3-bucket
  etcd-s3-folder
)
optional_s3_keys=(
  etcd-s3-endpoint-ca
  etcd-s3-endpoint-ca-name
  etcd-s3-skip-ssl-verify
  etcd-s3-session-token
  etcd-s3-bucket-lookup-type
  etcd-s3-region
  etcd-s3-insecure
  etcd-s3-timeout
  etcd-s3-proxy
)

s3_args=()
for key in "${required_s3_keys[@]}"; do
  check_private_file "$s3_dir/$key"
  s3_args+=("--from-file=$key=$s3_dir/$key")
done
for key in "${optional_s3_keys[@]}"; do
  if [[ -e "$s3_dir/$key" ]]; then
    check_private_file "$s3_dir/$key"
    s3_args+=("--from-file=$key=$s3_dir/$key")
  fi
done

s3_endpoint="$(read_scalar "$s3_dir/etcd-s3-endpoint")"
[[ ! "$s3_endpoint" =~ ^http:// ]] || fail "etcd-s3-endpoint cannot use plaintext http://"
s3_bucket="$(read_scalar "$s3_dir/etcd-s3-bucket")"
[[ "$s3_bucket" =~ ^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$ ]] \
  || fail "etcd-s3-bucket must be a conservative DNS-style bucket name"
s3_folder="$(read_scalar "$s3_dir/etcd-s3-folder")"
[[ "$s3_folder" == "$cluster" || "$s3_folder" == */"$cluster" ]] \
  || fail "etcd-s3-folder must end with the exact cluster identity $cluster"
for tls_key in etcd-s3-skip-ssl-verify etcd-s3-insecure; do
  if [[ -e "$s3_dir/$tls_key" ]]; then
    tls_value="$(read_scalar "$s3_dir/$tls_key")"
    [[ "$tls_value" == "false" ]] || fail "$tls_key must remain false"
  fi
done
unset s3_endpoint s3_bucket s3_folder tls_value

cat <<EOF_PLAN
validated runtime materialization plan
  cluster: $cluster
  context: $context
  namespace/secret: fiducia/cloudflare-tunnel-token
  namespace/secret: kube-system/k3s-etcd-snapshot-s3-config
  S3 folder isolation: exact cluster suffix required
  TLS verification: required
  secret values: redacted
EOF_PLAN

[[ "$apply" == "true" ]] || exit 0
command -v kubectl >/dev/null || fail "kubectl is required for --apply"

mapfile -t matching_nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#matching_nodes[@]} -eq 1 ]] \
  || fail "context $context must expose exactly one node labeled for $cluster"

kubectl --context "$context" get namespace fiducia >/dev/null

kubectl --context "$context" -n fiducia create secret generic cloudflare-tunnel-token \
  --from-file="token=$cloudflare_token_file" \
  --dry-run=client -o yaml \
  | kubectl --context "$context" apply --server-side --field-manager=fiducia-secret-bootstrap -f - >/dev/null

kubectl --context "$context" -n kube-system create secret generic k3s-etcd-snapshot-s3-config \
  --type=etcd.k3s.cattle.io/s3-config-secret \
  "${s3_args[@]}" \
  --dry-run=client -o yaml \
  | kubectl --context "$context" apply --server-side --field-manager=fiducia-secret-bootstrap -f - >/dev/null

kubectl --context "$context" -n fiducia annotate secret cloudflare-tunnel-token --overwrite \
  "fiducia.cloud/cluster=$cluster" \
  "fiducia.cloud/purpose=cloudflare-tunnel-token" >/dev/null
kubectl --context "$context" -n kube-system annotate secret k3s-etcd-snapshot-s3-config --overwrite \
  "fiducia.cloud/cluster=$cluster" \
  "fiducia.cloud/purpose=k3s-etcd-snapshot-s3" >/dev/null

cloudflare_keys="$(kubectl --context "$context" -n fiducia get secret cloudflare-tunnel-token -o go-template='{{len .data}}')"
s3_type="$(kubectl --context "$context" -n kube-system get secret k3s-etcd-snapshot-s3-config -o jsonpath='{.type}')"
[[ "$cloudflare_keys" == "1" ]] || fail "Cloudflare Secret must contain exactly one key"
[[ "$s3_type" == "etcd.k3s.cattle.io/s3-config-secret" ]] || fail "unexpected K3s S3 Secret type"

echo "runtime Secrets materialized for $cluster; values were not printed"
