#!/usr/bin/env bash
# Render and apply one cluster's Tailscale egress Services from fresh endpoint
# observations. The manifest contains no credentials, but production evidence is
# still kept outside Git because it identifies the private tailnet.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cluster=""
context=""
observations=""
allow_example="false"
apply="false"

usage() {
  cat <<'EOF'
usage:
  scripts/apply-laptop-tailnet-egress.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --observations /secure/evidence/tailnet-observations.json \
    [--allow-example] [--apply]

Without --apply, prints the rendered manifest. Example observations are CI-only
and require --allow-example; live observations older than ten minutes fail.
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
    --observations) observations="${2:-}"; shift 2 ;;
    --allow-example) allow_example="true"; shift ;;
    --apply) apply="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -n "$cluster" && -n "$context" && -f "$observations" ]] || fail "$(usage)"
command -v node >/dev/null || fail "node is required"

manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT
args=(
  "$repo_root/tools/render-laptop-tailnet-egress.mjs"
  --cluster "$cluster"
  --observations "$observations"
)
[[ "$allow_example" == "true" ]] && args+=(--allow-example)
node "${args[@]}" >"$manifest"

if [[ "$apply" != "true" ]]; then
  cat "$manifest"
  exit 0
fi

command -v kubectl >/dev/null || fail "kubectl is required for --apply"
mapfile -t nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#nodes[@]} -eq 1 ]] || fail "context $context must expose exactly one labeled laptop node"

kubectl --context "$context" get crd proxygroups.tailscale.com >/dev/null
kubectl --context "$context" wait \
  proxygroup/fiducia-egress-proxies \
  --for=condition=ProxyGroupReady=true \
  --timeout=300s >/dev/null

kubectl --context "$context" apply --server-side --dry-run=server -f "$manifest" >/dev/null
kubectl --context "$context" apply --server-side -f "$manifest" >/dev/null
kubectl --context "$context" -n fiducia wait \
  svc -l "fiducia.cloud/tailnet-egress=true" \
  --for=condition=TailscaleEgressSvcReady=true \
  --timeout=300s >/dev/null

kubectl --context "$context" -n fiducia get svc \
  -l "fiducia.cloud/tailnet-egress=true" \
  -o custom-columns='NAME:.metadata.name,REMOTE:.metadata.labels.fiducia\.cloud/remote-cluster,READY:.status.conditions[-1].status'
