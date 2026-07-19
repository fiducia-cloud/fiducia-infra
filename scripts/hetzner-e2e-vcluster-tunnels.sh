#!/usr/bin/env bash
set -euo pipefail

# Foreground-only local access. `api` starts only the three virtual API tunnels
# needed for the first deployment; `workloads` adds six application tunnels
# after that deployment; `all` owns all nine in one process.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
STATE_DIR=${FIDUCIA_HETZNER_E2E_STATE_DIR:-"$HOME/.local/state/fiducia/hetzner-e2e"}
KUBECONFIG_DIR="$STATE_DIR/kubeconfigs"
CLUSTERS=(hetzner-fsn1 hetzner-nbg1 hetzner-hel1)
MODE=${1:-all}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v nc >/dev/null 2>&1 || fail "nc is required"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
test "$#" -le 1 || fail "usage: scripts/hetzner-e2e-vcluster-tunnels.sh [api|workloads|all]"
case "$MODE" in api|workloads|all) ;; *) fail "mode must be api, workloads, or all" ;; esac
case "$STATE_DIR" in /*) ;; *) fail "state directory must be absolute" ;; esac
test -d "$STATE_DIR" || fail "state directory does not exist: $STATE_DIR"
STATE_DIR=$(cd "$STATE_DIR" && pwd -P)
KUBECONFIG_DIR="$STATE_DIR/kubeconfigs"
case "$STATE_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state must stay outside the repository" ;; esac
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

api_port_for() { case "$1" in hetzner-fsn1) printf 18403;; hetzner-nbg1) printf 18404;; hetzner-hel1) printf 18405;; esac; }
node_port_for() { case "$1" in hetzner-fsn1) printf 18003;; hetzner-nbg1) printf 18004;; hetzner-hel1) printf 18005;; esac; }
lb_port_for() { case "$1" in hetzner-fsn1) printf 18103;; hetzner-nbg1) printf 18104;; hetzner-hel1) printf 18105;; esac; }

pids=()
cleanup() {
  if test "${#pids[@]}" -gt 0; then
    kill "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if test "$MODE" != workloads; then
  for cluster in "${CLUSTERS[@]}"; do
    short=${cluster#hetzner-}
    namespace="fiducia-vc-$short"
    release="fiducia-$cluster"
    api_port=$(api_port_for "$cluster")
    kubectl "${HOST_ARGS[@]}" -n "$namespace" port-forward --address 127.0.0.1 \
      "service/$release" "$api_port:443" &
    pids+=("$!")
  done
fi

for cluster in "${CLUSTERS[@]}"; do
  api_port=$(api_port_for "$cluster")
  ready=0
  for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if nc -z 127.0.0.1 "$api_port"; then ready=1; break; fi
    sleep 1
  done
  test "$ready" -eq 1 || fail "$cluster virtual API tunnel did not become ready"
done

if test "$MODE" = api; then
  printf 'Three loopback-only virtual API forwards are active; press Ctrl-C to stop them.\n'
  wait "${pids[@]}"
  exit 0
fi

uids=''
for cluster in "${CLUSTERS[@]}"; do
  kubeconfig="$KUBECONFIG_DIR/$cluster.kubeconfig"
  test -f "$kubeconfig" || fail "missing kubeconfig: $kubeconfig"
  uid=$(kubectl --kubeconfig="$kubeconfig" get namespace kube-system -o jsonpath='{.metadata.uid}')
  test -n "$uid" || fail "$cluster has no virtual Kubernetes UID"
  uids="$uids$uid"$'\n'
done
test "$(printf '%s' "$uids" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')" -eq 3 ||
  fail "refusing to expose workloads: fewer than three distinct virtual cluster UIDs"

for cluster in "${CLUSTERS[@]}"; do
  kubeconfig="$KUBECONFIG_DIR/$cluster.kubeconfig"
  node_port=$(node_port_for "$cluster")
  lb_port=$(lb_port_for "$cluster")
  kubectl --kubeconfig="$kubeconfig" -n fiducia get service/fiducia-node-client >/dev/null ||
    fail "$cluster is missing service/fiducia-node-client; deploy the release before workload tunnels"
  kubectl --kubeconfig="$kubeconfig" -n fiducia get service/fiducia-load-balance-internal >/dev/null ||
    fail "$cluster is missing service/fiducia-load-balance-internal; deploy the release before workload tunnels"
  kubectl --kubeconfig="$kubeconfig" -n fiducia port-forward --address 127.0.0.1 \
    service/fiducia-node-client "$node_port:8090" &
  pids+=("$!")
  kubectl --kubeconfig="$kubeconfig" -n fiducia port-forward --address 127.0.0.1 \
    service/fiducia-load-balance-internal "$lb_port:8088" &
  pids+=("$!")
  printf '%s api=https://127.0.0.1:%s node=http://127.0.0.1:%s lb=http://127.0.0.1:%s\n' \
    "$cluster" "$(api_port_for "$cluster")" "$node_port" "$lb_port"
done

if test "$MODE" = all; then
  printf 'Nine loopback-only kubectl forwards are active; press Ctrl-C to stop them.\n'
else
  printf 'Six workload forwards are active alongside the existing API forwards; press Ctrl-C to stop them.\n'
fi
wait "${pids[@]}"
