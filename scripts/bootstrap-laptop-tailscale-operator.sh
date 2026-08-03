#!/usr/bin/env bash
# Install one cluster-local Tailscale Kubernetes Operator from a local,
# checksum-pinned Helm chart and an external mode-0600 OAuth values file.
set -euo pipefail

cluster=""
context=""
chart=""
chart_sha256=""
values=""
apply="false"

usage() {
  cat <<'EOF'
usage:
  scripts/bootstrap-laptop-tailscale-operator.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --chart /secure/artifacts/tailscale-operator-<version>.tgz \
    --chart-sha256 <64-character-sha256> \
    --values /secure/bootstrap/tailscale-oauth.values.yaml \
    [--apply]

Without --apply, validates non-secret arguments and prints the intended operation.
The values file must remain outside Git, be readable only by its owner, and define
oauth.clientId plus oauth.clientSecret (or the approved workload-identity fields).
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
    --chart) chart="${2:-}"; shift 2 ;;
    --chart-sha256) chart_sha256="${2:-}"; shift 2 ;;
    --values) values="${2:-}"; shift 2 ;;
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
[[ -f "$chart" ]] || fail "--chart must name an existing local Helm archive"
[[ "$chart_sha256" =~ ^[0-9a-fA-F]{64}$ ]] || fail "--chart-sha256 must be a 64-character SHA-256"
[[ -f "$values" ]] || fail "--values must name an existing external values file"
command -v sha256sum >/dev/null || fail "sha256sum is required"

actual_sha="$(sha256sum "$chart" | awk '{print $1}')"
[[ "$actual_sha" == "${chart_sha256,,}" ]] || fail "Tailscale operator chart checksum mismatch"

values_mode="$(stat -c '%a' "$values")"
(( (8#$values_mode & 077) == 0 )) || fail "OAuth values file must not be group/world accessible"
grep -Eq '^[[:space:]]*oauth:' "$values" || fail "values file must define the oauth section"
if grep -Eq 'CHANGEME|REPLACE_ME|<[^>]+>' "$values"; then
  fail "values file still contains a placeholder"
fi

echo "tailscale operator plan"
echo "  cluster: $cluster"
echo "  context: $context"
echo "  chart-sha256: ${chart_sha256,,}"
echo "  operator-hostname: ${cluster}-operator"
echo "  api-server-proxy: auth mode"
echo "  credentials: external values file (content suppressed)"

[[ "$apply" == "true" ]] || exit 0
command -v kubectl >/dev/null || fail "kubectl is required for --apply"
command -v helm >/dev/null || fail "helm is required for --apply"

mapfile -t nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#nodes[@]} -eq 1 ]] || fail "context $context must expose exactly one labeled laptop node"

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
chmod 600 "$rendered"
helm template tailscale-operator "$chart" \
  --namespace tailscale \
  --values "$values" \
  --set-string "operatorConfig.hostname=${cluster}-operator" \
  --set-string 'apiServerProxyConfig.mode=true' >"$rendered"

kubectl --context "$context" apply --server-side --dry-run=server -f "$rendered" >/dev/null

helm upgrade --install tailscale-operator "$chart" \
  --kube-context "$context" \
  --namespace tailscale \
  --create-namespace \
  --values "$values" \
  --set-string "operatorConfig.hostname=${cluster}-operator" \
  --set-string 'apiServerProxyConfig.mode=true' \
  --atomic \
  --wait \
  --timeout 10m

kubectl --context "$context" wait \
  --for=condition=Established \
  crd/proxygroups.tailscale.com \
  --timeout=180s >/dev/null
kubectl --context "$context" -n tailscale wait \
  --for=condition=Available deployment/operator \
  --timeout=300s >/dev/null

echo "installed cluster-local Tailscale operator for $cluster; OAuth values were not printed"
