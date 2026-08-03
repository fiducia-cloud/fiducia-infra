#!/usr/bin/env bash
# Capture K3s ETCDSnapshotFile resources and prove a recent local/S3 pair.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cluster=""
context=""
output=""
max_age_hours="8"

usage() {
  cat <<'EOF'
usage:
  scripts/capture-laptop-etcd-snapshot-evidence.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --output /secure/evidence/laptop-aws-sim-etcdsnapshots.json \
    [--max-age-hours 8]
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
    --max-age-hours) max_age_hours="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -n "$cluster" && -n "$context" && -n "$output" ]] || fail "$(usage)"
command -v kubectl >/dev/null || fail "kubectl is required"
command -v node >/dev/null || fail "node is required"

mapfile -t nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#nodes[@]} -eq 1 ]] || fail "context $context must expose exactly one labeled laptop node"

tmp="$(mktemp)"
summary="$(mktemp)"
trap 'rm -f "$tmp" "$summary"' EXIT
chmod 600 "$tmp" "$summary"

kubectl --context "$context" get etcdsnapshotfile -o json >"$tmp"
node "$repo_root/tools/verify-etcd-snapshot-evidence.mjs" \
  --cluster "$cluster" \
  --file "$tmp" \
  --max-age-hours "$max_age_hours" >"$summary"

install -m 600 "$tmp" "$output"
install -m 600 "$summary" "${output%.json}.summary.json"
echo "captured verified local/S3 K3s snapshot evidence for $cluster"
