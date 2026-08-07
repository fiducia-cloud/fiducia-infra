#!/usr/bin/env bash
# Capture the private MagicDNS endpoints created by the Tailscale operator.
# The resulting file is non-secret but security-sensitive and should be stored
# with deployment evidence rather than committed.
set -euo pipefail

mapping=""
output=""

usage() {
  cat <<'EOF'
usage:
  scripts/capture-laptop-tailnet-observations.sh \
    --contexts /secure/config/laptop-contexts.json \
    --output /secure/evidence/tailnet-observations.json

contexts JSON:
{
  "laptop-aws-sim": "fiducia-laptop-aws-sim",
  "laptop-gcp-sim": "fiducia-laptop-gcp-sim",
  "laptop-azure-sim": "fiducia-laptop-azure-sim"
}
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --contexts) mapping="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -f "$mapping" && -n "$output" ]] || fail "$(usage)"
command -v kubectl >/dev/null || fail "kubectl is required"
command -v jq >/dev/null || fail "jq is required"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"
printf '{"evidenceMode":"live","observedAt":%s,"clusters":{' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ | jq -R .)" >"$tmp"

first="true"
for cluster in laptop-aws-sim laptop-gcp-sim laptop-azure-sim; do
  context="$(jq -er --arg cluster "$cluster" '.[$cluster]' "$mapping")"
  mapfile -t nodes < <(
    kubectl --context "$context" get nodes \
      -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
      -o name
  )
  [[ ${#nodes[@]} -eq 1 ]] || fail "context $context does not match $cluster"

  node_fqdn="$(kubectl --context "$context" -n fiducia get svc fiducia-node-peer-tailnet \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')"
  brain_fqdn="$(kubectl --context "$context" -n fiducia get svc fiducia-brain-peer-tailnet \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')"
  [[ "$node_fqdn" == node-"$cluster".*.ts.net ]] || fail "node tailnet hostname missing for $cluster"
  [[ "$brain_fqdn" == brain-"$cluster".*.ts.net ]] || fail "brain tailnet hostname missing for $cluster"

  [[ "$first" == "true" ]] || printf ',' >>"$tmp"
  first="false"
  jq -cn \
    --arg cluster "$cluster" \
    --arg node "$node_fqdn" \
    --arg brain "$brain_fqdn" \
    '{key:$cluster,value:{nodeFqdn:$node,brainFqdn:$brain}}' \
    | jq -c '"\(.key)":\(.value)' -r >>"$tmp"
done
printf '}}\n' >>"$tmp"

jq -e . "$tmp" >/dev/null
install -m 600 "$tmp" "$output"
echo "wrote fresh tailnet observations to $output"
