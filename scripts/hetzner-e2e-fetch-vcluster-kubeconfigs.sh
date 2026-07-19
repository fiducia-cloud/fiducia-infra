#!/usr/bin/env bash
set -euo pipefail

# Extract client-certificate kubeconfigs from the three vCluster-owned host
# Secrets. Servers are rewritten to loopback API forwards; no credential bytes
# are printed and no global kubeconfig is merged or modified.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
STATE_DIR=${FIDUCIA_HETZNER_E2E_STATE_DIR:-"$HOME/.local/state/fiducia/hetzner-e2e"}
KUBECONFIG_DIR="$STATE_DIR/kubeconfigs"
CLUSTERS=(hetzner-fsn1 hetzner-nbg1 hetzner-hel1)

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

if test -n "${FIDUCIA_HOST_KUBECONFIG:-}" && test -n "${FIDUCIA_HOST_CONTEXT:-}"; then
  fail "set one host kubeconfig selector, not both"
elif test -n "${FIDUCIA_HOST_KUBECONFIG:-}"; then
  test -f "$FIDUCIA_HOST_KUBECONFIG" || fail "host kubeconfig not found"
  HOST_ARGS=(--kubeconfig="$FIDUCIA_HOST_KUBECONFIG")
elif test -n "${FIDUCIA_HOST_CONTEXT:-}"; then
  HOST_ARGS=(--context="$FIDUCIA_HOST_CONTEXT")
else
  fail "set FIDUCIA_HOST_KUBECONFIG or FIDUCIA_HOST_CONTEXT explicitly"
fi
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v base64 >/dev/null 2>&1 || fail "base64 is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
case "$STATE_DIR" in /*) ;; *) fail "state directory must be absolute" ;; esac
case "$STATE_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state must stay outside the repository" ;; esac
mkdir -p "$KUBECONFIG_DIR"
chmod 700 "$STATE_DIR" "$KUBECONFIG_DIR"
STATE_DIR=$(cd "$STATE_DIR" && pwd -P)
KUBECONFIG_DIR="$STATE_DIR/kubeconfigs"
case "$STATE_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state must stay outside the repository" ;; esac
umask 077

api_port_for() {
  case "$1" in
    hetzner-fsn1) printf '18403' ;;
    hetzner-nbg1) printf '18404' ;;
    hetzner-hel1) printf '18405' ;;
    *) fail "unknown cluster $1" ;;
  esac
}

paths=()
for cluster in "${CLUSTERS[@]}"; do
  short=${cluster#hetzner-}
  namespace="fiducia-vc-$short"
  release="fiducia-$cluster"
  context="fiducia-e2e-$cluster"
  destination="$KUBECONFIG_DIR/$cluster.kubeconfig"
  api_port=$(api_port_for "$cluster")
  test "$(kubectl "${HOST_ARGS[@]}" get namespace "$namespace" -o jsonpath='{.metadata.labels.fiducia\.cloud/vcluster-fleet}')" = "hetzner-e2e" ||
    fail "$namespace is not an owned test namespace"
  test "$(kubectl "${HOST_ARGS[@]}" get namespace "$namespace" -o jsonpath='{.metadata.labels.fiducia\.cloud/logical-cluster}')" = "$cluster" ||
    fail "$namespace has a mismatched logical-cluster owner"
  encoded_config=$(kubectl "${HOST_ARGS[@]}" -n "$namespace" get secret "vc-$release" -o jsonpath='{.data.config}')
  test -n "$encoded_config" || fail "$cluster vCluster kubeconfig Secret is empty"
  decoded_config=$(printf '%s' "$encoded_config" | base64 --decode)
  test -n "$decoded_config" || fail "$cluster vCluster kubeconfig could not be decoded"
  printf '%s\n' "$decoded_config" |
    tee "$destination" |
    openssl dgst -sha256
  chmod 600 "$destination"
  source_context=$(kubectl --kubeconfig="$destination" config current-context)
  cluster_entry=$(kubectl --kubeconfig="$destination" config view -o json |
    jq -er --arg source_context "$source_context" '.contexts[] | select(.name == $source_context) | .context.cluster')
  kubectl --kubeconfig="$destination" config set-cluster "$cluster_entry" \
    --server="https://127.0.0.1:$api_port" >/dev/null
  if test "$source_context" != "$context"; then
    kubectl --kubeconfig="$destination" config rename-context "$source_context" "$context" >/dev/null
  fi
  paths+=("$destination")
done

unset encoded_config decoded_config

joined=$(IFS=:; printf '%s' "${paths[*]}")
printf 'fetched three virtual-cluster kubeconfigs; they require the foreground tunnel script:\n'
printf 'export KUBECONFIG=%q\n' "$joined"
