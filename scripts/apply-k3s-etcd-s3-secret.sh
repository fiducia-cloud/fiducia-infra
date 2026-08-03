#!/usr/bin/env bash
# Apply the external K3s S3 snapshot Secret without logging its values.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cluster=""
context=""
secret_file=""
apply="false"

usage() {
  cat <<'EOF'
usage:
  scripts/apply-k3s-etcd-s3-secret.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --secret-file /secure/bootstrap/k3s-etcd-s3.secret.yaml \
    [--apply]
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
    --secret-file) secret_file="${2:-}"; shift 2 ;;
    --apply) apply="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -n "$cluster" && -n "$context" && -f "$secret_file" ]] || fail "$(usage)"
command -v node >/dev/null || fail "node is required"
mode="$(stat -c '%a' "$secret_file")"
(( (8#$mode & 077) == 0 )) || fail "S3 Secret file must not be group/world accessible"

node "$repo_root/tools/validate-k3s-s3-secret.mjs" \
  --cluster "$cluster" \
  --file "$secret_file" >/dev/null

echo "validated redacted K3s S3 Secret contract for $cluster"
[[ "$apply" == "true" ]] || exit 0
command -v kubectl >/dev/null || fail "kubectl is required for --apply"

mapfile -t nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#nodes[@]} -eq 1 ]] || fail "context $context must expose exactly one labeled laptop node"

kubectl --context "$context" apply --server-side --dry-run=server -f "$secret_file" >/dev/null
kubectl --context "$context" apply --server-side -f "$secret_file" >/dev/null
echo "applied k3s-etcd-snapshot-s3-config in kube-system without printing credential values"
