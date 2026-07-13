#!/usr/bin/env bash
# Shared config + helpers for the local 3-cluster emulation. SOURCED by the other
# scripts (up/down/netem/partition/test) — not executed directly.
set -euo pipefail

# The three emulated clouds — mirror ../../topology.toml (hetzner/vultr/civo).
CLUSTERS=(hetzner vultr civo)

KIND_PREFIX="fiducia"       # kind cluster name  = <prefix>-<cloud>  (e.g. fiducia-hetzner)
DOCKER_NET="kind"           # kind attaches every cluster to this Docker network
NAMESPACE="fiducia"
SHARD_COUNT=16              # keep small so status is readable + startup is fast

# NodePorts exposed by common/nodeport.yaml (identical in every cluster).
NP_API=30080                # -> fiducia-node  :8090  (coordination API)
NP_NODE_PEER=30090          # -> fiducia-node  :9090  (cross-cluster Raft)
NP_BRAIN_PEER=30095         # -> fiducia-brain :9095  (cross-cluster Raft)

# Host ports the kind-*.yaml configs map the coordination API to (one per cluster).
declare -A API_HOST_PORT=( [hetzner]=8090 [vultr]=8091 [civo]=8092 )

# Fixed DEV secrets — this is a THROWAWAY local env; never reuse these anywhere.
# The SAME value in all three clusters so brain Raft peers + the trusted-hop agree.
DEV_INTERNAL_SECRET="emulation-internal-secret-do-not-use-in-prod"
DEV_BRAIN_SECRET="emulation-brain-raft-secret-do-not-use-in-prod"
DEV_ORG="emulation-org"     # x-fiducia-org-id for authed /v1 calls (mandatory org scope)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

kind_name()    { echo "${KIND_PREFIX}-$1"; }
kube_ctx()     { echo "kind-${KIND_PREFIX}-$1"; }        # context kind creates
cp_container() { echo "${KIND_PREFIX}-$1-control-plane"; }
api_url()      { echo "http://127.0.0.1:${API_HOST_PORT[$1]}"; }

# Control-plane container IP on the shared `kind` Docker network — how OTHER
# clusters' pods reach this cluster's NodePorts.
cp_ip() {
  docker inspect -f "{{(index .NetworkSettings.Networks \"${DOCKER_NET}\").IPAddress}}" \
    "$(cp_container "$1")" 2>/dev/null
}

# kubectl against a given emulated cluster's context.
kc() { local c="$1"; shift; kubectl --context "$(kube_ctx "$c")" "$@"; }

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
