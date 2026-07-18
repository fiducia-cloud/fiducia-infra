#!/usr/bin/env bash
# Shared config + helpers for the local 3-cluster emulation. SOURCED by the other
# scripts (up/down/netem/partition/test) — not executed directly.
# shellcheck disable=SC2034  # vars here are consumed by the scripts that source this
set -euo pipefail

# Default to three disposable clusters that model separate Hetzner failure
# domains. This is deliberately a *single-provider* profile: it exercises three
# Kubernetes control planes and cross-cluster Raft without claiming that one
# Docker host proves Hetzner's physical failure domains.
#
# The former labels remain available only to reproduce old local runs with
# FIDUCIA_EMULATION_PROFILE=legacy-multicloud. They are not the default: this
# harness neither creates nor implies any Civo or Vultr resources.
EMULATION_PROFILE="${FIDUCIA_EMULATION_PROFILE:-hetzner-regions}"
case "$EMULATION_PROFILE" in
  hetzner-regions)
    CLUSTERS=(hetzner-fsn1 hetzner-nbg1 hetzner-hel1)
    EMULATION_PROVIDER="hetzner"
    OUTAGE_CLUSTER="hetzner-hel1"
    ;;
  legacy-multicloud)
    CLUSTERS=(hetzner vultr civo)
    EMULATION_PROVIDER="mixed-local-labels"
    OUTAGE_CLUSTER="civo"
  ;;
  *)
    printf '%s\n' "error: unknown FIDUCIA_EMULATION_PROFILE '$EMULATION_PROFILE' (use hetzner-regions or legacy-multicloud)" >&2
    exit 1
    ;;
esac

KIND_PREFIX="fiducia"       # kind cluster name = <prefix>-<member>
DOCKER_NET="kind"           # kind attaches every cluster to this Docker network
NAMESPACE="fiducia"
SHARD_COUNT=16              # keep small so status is readable + startup is fast

# NodePorts exposed by common/nodeport.yaml (identical in every cluster).
NP_API=30080                # -> fiducia-node  :8090  (coordination API)
NP_NODE_PEER=30090          # -> fiducia-node  :9090  (cross-cluster Raft)
NP_BRAIN_PEER=30095         # -> fiducia-brain :9095  (cross-cluster Raft)
NP_LB=30088                 # -> fiducia-load-balance :8088 (local public entrypoint)

# Fixed DEV secrets — this is a THROWAWAY local env; never reuse these anywhere.
# The SAME value in all three clusters so brain Raft peers + the trusted-hop agree.
DEV_INTERNAL_SECRET="emulation-internal-secret-do-not-use-in-prod"
DEV_BRAIN_SECRET="emulation-brain-raft-secret-do-not-use-in-prod"
DEV_ORG="emulation-org"     # x-fiducia-org-id for authed /v1 calls (mandatory org scope)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

kind_name()    { echo "${KIND_PREFIX}-$1"; }
kube_ctx()     { echo "kind-${KIND_PREFIX}-$1"; }        # context kind creates
cp_container() { echo "${KIND_PREFIX}-$1-control-plane"; }
api_host_port() {
  case "$EMULATION_PROFILE:$1" in
    hetzner-regions:hetzner-fsn1) echo 8100 ;;
    hetzner-regions:hetzner-nbg1) echo 8101 ;;
    hetzner-regions:hetzner-hel1) echo 8102 ;;
    legacy-multicloud:hetzner) echo 8090 ;;
    legacy-multicloud:vultr)   echo 8091 ;;
    legacy-multicloud:civo)    echo 8092 ;;
    *) die "unknown emulated cluster: $1" ;;
  esac
}
lb_host_port() {
  case "$EMULATION_PROFILE:$1" in
    hetzner-regions:hetzner-fsn1) echo 8103 ;;
    hetzner-regions:hetzner-nbg1) echo 8104 ;;
    hetzner-regions:hetzner-hel1) echo 8105 ;;
    legacy-multicloud:hetzner) echo 8093 ;;
    legacy-multicloud:vultr)   echo 8094 ;;
    legacy-multicloud:civo)    echo 8095 ;;
    *) die "unknown emulated cluster: $1" ;;
  esac
}
api_url() { echo "http://127.0.0.1:$(api_host_port "$1")"; }
lb_url()  { echo "http://127.0.0.1:$(lb_host_port "$1")"; }

# Control-plane container IP on the shared `kind` Docker network — how OTHER
# clusters' pods reach this cluster's NodePorts.
cp_ip() {
  docker inspect -f "{{(index .NetworkSettings.Networks \"${DOCKER_NET}\").IPAddress}}" \
    "$(cp_container "$1")" 2>/dev/null
}

# kubectl against a given emulated cluster's context.
kc() { local c="$1"; shift; kubectl --context "$(kube_ctx "$c")" "$@"; }

next_cluster() {
  local current="$1" index
  for index in "${!CLUSTERS[@]}"; do
    [[ "${CLUSTERS[$index]}" == "$current" ]] || continue
    echo "${CLUSTERS[$(((index + 1) % ${#CLUSTERS[@]}))]}"
    return 0
  done
  die "unknown emulated cluster: $current"
}

survivor_clusters() {
  local excluded="$1" c
  for c in "${CLUSTERS[@]}"; do
    [[ "$c" == "$excluded" ]] || printf '%s\n' "$c"
  done
}

have() { command -v "$1" >/dev/null 2>&1; }
require_tools() {
  local t missing=()
  for t in "$@"; do have "$t" || missing+=("$t"); done
  ((${#missing[@]}==0)) || die "missing required tools: ${missing[*]}"
}

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
