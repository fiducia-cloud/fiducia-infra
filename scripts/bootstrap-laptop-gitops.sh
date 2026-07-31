#!/usr/bin/env bash
# Bootstrap one laptop cluster's local Argo CD controller from immutable inputs.
# This script never downloads mutable upstream content and never prints secrets.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cluster=""
revision=""
context=""
argocd_install=""
argocd_sha256=""
repo_secret=""
mode="plan"

usage() {
  cat <<'EOF'
usage:
  scripts/bootstrap-laptop-gitops.sh \
    --cluster laptop-aws-sim \
    --revision <40-character-fiducia-infra-commit> \
    [--context <kube-context>] \
    [--argocd-install <pinned-local-install.yaml>] \
    [--argocd-sha256 <64-character-sha256>] \
    [--repo-secret <local-argocd-repository-secret.yaml>] \
    [--apply]

Without --apply, renders the exact root bundle and performs no cluster writes.
With --apply, every file/context argument is mandatory. The repository Secret
must be stored outside Git and labeled argocd.argoproj.io/secret-type=repository.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --revision) revision="${2:-}"; shift 2 ;;
    --context) context="${2:-}"; shift 2 ;;
    --argocd-install) argocd_install="${2:-}"; shift 2 ;;
    --argocd-sha256) argocd_sha256="${2:-}"; shift 2 ;;
    --repo-secret) repo_secret="${2:-}"; shift 2 ;;
    --apply) mode="apply"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -n "$cluster" ]] || fail "--cluster is required"
[[ "$revision" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--revision must be an exact 40-character Git commit SHA"
command -v node >/dev/null || fail "node is required"

bundle="$(mktemp)"
trap 'rm -f "$bundle"' EXIT
node "$repo_root/tools/render-laptop-gitops.mjs" \
  --cluster "$cluster" \
  --revision "$revision" >"$bundle"

if [[ "$mode" == "plan" ]]; then
  echo "# bootstrap plan: $cluster at ${revision,,}"
  echo "# bundle-sha256: $(sha256sum "$bundle" | awk '{print $1}')"
  cat "$bundle"
  exit 0
fi

command -v kubectl >/dev/null || fail "kubectl is required for --apply"
command -v sha256sum >/dev/null || fail "sha256sum is required for --apply"
[[ -n "$context" ]] || fail "--context is required for --apply"
[[ -f "$argocd_install" ]] || fail "--argocd-install must name an existing pinned local manifest"
[[ "$argocd_sha256" =~ ^[0-9a-fA-F]{64}$ ]] || fail "--argocd-sha256 must be a 64-character SHA-256"
[[ -f "$repo_secret" ]] || fail "--repo-secret must name an existing local repository Secret"

actual_install_sha="$(sha256sum "$argocd_install" | awk '{print $1}')"
[[ "$actual_install_sha" == "${argocd_sha256,,}" ]] || fail "Argo CD install bundle checksum mismatch"

grep -Eq 'argocd\.argoproj\.io/secret-type:[[:space:]]*["'"']?repository["'"']?' "$repo_secret" \
  || fail "repository Secret lacks argocd.argoproj.io/secret-type=repository"
grep -Fq 'https://github.com/fiducia-cloud/fiducia-infra.git' "$repo_secret" \
  || fail "repository Secret is not scoped to fiducia-cloud/fiducia-infra"

mapfile -t matching_nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#matching_nodes[@]} -eq 1 ]] \
  || fail "context $context must expose exactly one node labeled for $cluster; found ${#matching_nodes[@]}"

# Validate every input against the live API before changing the cluster.
kubectl --context "$context" apply --server-side --dry-run=server -f "$argocd_install" >/dev/null
kubectl --context "$context" apply --server-side --dry-run=server -f "$repo_secret" >/dev/null

kubectl --context "$context" apply --server-side -f "$argocd_install" >/dev/null
kubectl --context "$context" wait \
  --for=condition=Established \
  crd/applications.argoproj.io \
  crd/appprojects.argoproj.io \
  --timeout=180s >/dev/null
kubectl --context "$context" -n argocd wait \
  --for=condition=Available deployment --all --timeout=300s >/dev/null

# Credentials remain outside Git; do not echo or diff this file.
kubectl --context "$context" apply --server-side -f "$repo_secret" >/dev/null
kubectl --context "$context" apply --server-side --dry-run=server -f "$bundle" >/dev/null
kubectl --context "$context" apply --server-side -f "$bundle" >/dev/null

app="fiducia-$cluster"
kubectl --context "$context" -n argocd get application "$app" \
  -o custom-columns='NAME:.metadata.name,REVISION:.spec.source.targetRevision,PATH:.spec.source.path,SYNC:.status.sync.status,HEALTH:.status.health.status'

echo "bootstrapped $app at immutable revision ${revision,,}; application sync remains manual"
