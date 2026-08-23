#!/usr/bin/env bash
# Apply one externally stored Cloudflare Tunnel token Secret without logging its
# contents, then wait for the local connector to become available.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cluster=""
context=""
secret_file=""
apply="false"

usage() {
  cat <<'USAGE'
usage:
  scripts/apply-cloudflared-tunnel-secret.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --secret-file /secure/bootstrap/cloudflared-tunnel-token.secret.yaml \
    [--apply]

The Secret file must remain outside Git and be mode 0600 (or stricter).
USAGE
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

case "$cluster" in
  laptop-aws-sim|laptop-gcp-sim|laptop-azure-sim) ;;
  *) fail "--cluster must name one of the three laptop clusters" ;;
esac
[[ -n "$context" && -f "$secret_file" ]] || fail "$(usage)"
command -v node >/dev/null || fail "node is required"
mode="$(stat -c '%a' "$secret_file")"
(( (8#$mode & 077) == 0 )) || fail "Tunnel Secret file must not be group/world accessible"

node "$repo_root/tools/validate-cloudflared-token-secret.mjs" --file "$secret_file" >/dev/null
echo "validated redacted Cloudflare Tunnel token Secret contract for $cluster"
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
kubectl --context "$context" -n fiducia rollout restart deployment/cloudflared >/dev/null
kubectl --context "$context" -n fiducia rollout status deployment/cloudflared --timeout=300s
kubectl --context "$context" -n fiducia get deployment cloudflared \
  -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,AVAILABLE:.status.availableReplicas'
