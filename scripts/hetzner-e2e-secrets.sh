#!/usr/bin/env bash
set -euo pipefail

# Bootstrap runtime-only authentication material on all three clusters. Secret
# values pass through stdin and are never written to a repository or manifest.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
STATE_DIR=${FIDUCIA_HETZNER_E2E_STATE_DIR:-"$HOME/.local/state/fiducia/hetzner-e2e"}
KUBECONFIG_DIR="$STATE_DIR/kubeconfigs"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
command -v base64 >/dev/null 2>&1 || fail "base64 is required"
case "$STATE_DIR" in /*) ;; *) fail "state directory must be absolute" ;; esac
test -d "$STATE_DIR" || fail "state directory does not exist: $STATE_DIR"
STATE_DIR=$(cd "$STATE_DIR" && pwd -P)
KUBECONFIG_DIR="$STATE_DIR/kubeconfigs"
case "$STATE_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state must stay outside the repository" ;; esac

test -n "${FIDUCIA_INTERNAL_SECRET:-}" || fail "FIDUCIA_INTERNAL_SECRET is required"
test -n "${FIDUCIA_BRAIN_RAFT_SECRET:-}" || fail "FIDUCIA_BRAIN_RAFT_SECRET is required"
test -n "${FIDUCIA_GHCR_USERNAME:-}" || fail "FIDUCIA_GHCR_USERNAME is required"
test -n "${FIDUCIA_GHCR_TOKEN:-}" || fail "FIDUCIA_GHCR_TOKEN is required"
[[ "$FIDUCIA_GHCR_USERNAME" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] ||
  fail "FIDUCIA_GHCR_USERNAME is not a valid GitHub account name"
test "${#FIDUCIA_GHCR_TOKEN}" -ge 20 || fail "FIDUCIA_GHCR_TOKEN is unexpectedly short"
test "${#FIDUCIA_INTERNAL_SECRET}" -ge 32 || fail "FIDUCIA_INTERNAL_SECRET must be at least 32 characters"
test "${#FIDUCIA_BRAIN_RAFT_SECRET}" -ge 32 || fail "FIDUCIA_BRAIN_RAFT_SECRET must be at least 32 characters"
test "$FIDUCIA_INTERNAL_SECRET" != "$FIDUCIA_BRAIN_RAFT_SECRET" || fail "use distinct internal and brain Raft secrets"
case "$FIDUCIA_INTERNAL_SECRET:$FIDUCIA_BRAIN_RAFT_SECRET" in
  *emulation-internal-secret-do-not-use-in-prod*|*emulation-brain-raft-secret-do-not-use-in-prod*)
    fail "the fixed local-emulator secrets are forbidden on Hetzner"
    ;;
esac

internal_b64=$(printf '%s' "$FIDUCIA_INTERNAL_SECRET" | base64 | tr -d '\n')
brain_b64=$(printf '%s' "$FIDUCIA_BRAIN_RAFT_SECRET" | base64 | tr -d '\n')
registry_auth_b64=$(printf '%s:%s' "$FIDUCIA_GHCR_USERNAME" "$FIDUCIA_GHCR_TOKEN" | base64 | tr -d '\n')
registry_config_b64=$(
  printf '{"auths":{"ghcr.io":{"username":"%s","auth":"%s"}}}' \
    "$FIDUCIA_GHCR_USERNAME" "$registry_auth_b64" | base64 | tr -d '\n'
)

for cluster in hetzner-fsn1 hetzner-nbg1 hetzner-hel1; do
  kubeconfig="$KUBECONFIG_DIR/$cluster.kubeconfig"
  test -f "$kubeconfig" || fail "missing kubeconfig: $kubeconfig"
  kubectl --kubeconfig="$kubeconfig" create namespace fiducia \
    --dry-run=client -o yaml | kubectl --kubeconfig="$kubeconfig" apply -f - >/dev/null
  printf '%s\n' \
    'apiVersion: v1' \
    'kind: Secret' \
    'metadata:' \
    '  name: fiducia-secrets' \
    '  namespace: fiducia' \
    'type: Opaque' \
    'data:' \
    "  internal-secret: $internal_b64" \
    "  brain-raft-secret: $brain_b64" |
    kubectl --kubeconfig="$kubeconfig" apply -f - >/dev/null
  printf '%s\n' \
    'apiVersion: v1' \
    'kind: Secret' \
    'metadata:' \
    '  name: fiducia-ghcr-pull' \
    '  namespace: fiducia' \
    'type: kubernetes.io/dockerconfigjson' \
    'data:' \
    "  .dockerconfigjson: $registry_config_b64" |
    kubectl --kubeconfig="$kubeconfig" apply -f - >/dev/null
  printf 'bootstrapped runtime and registry pull secrets on %s\n' "$cluster"
done

unset internal_b64 brain_b64 registry_auth_b64 registry_config_b64
