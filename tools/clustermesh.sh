#!/usr/bin/env bash
# Stitch the clusters from topology.toml together with Cilium Cluster Mesh, so
# pods (and thus Raft peers) are routable pod-to-pod across every cloud — the
# lowest-latency way to run the cross-cluster brain + node Raft groups.
#
# The cluster list is READ FROM topology.toml (the single source of truth), so
# this script never needs editing when you add/swap a cluster — only the kubectl
# context mapping does. Handles connectivity = "clustermesh"; for "wireguard" or
# "public-mtls" see docs/multi-cluster-architecture.md.
#
# Prereqs: the `cilium` CLI, Cilium installed in each cluster with a unique
# cluster-id/name, and a kubectl context per cluster.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
topology="${TOPOLOGY_FILE:-$root/topology.toml}"

# Parse the [[cluster]] .name values out of topology.toml (order preserved).
mapfile -t clusters < <(awk '
  /^\[\[cluster\]\]/ { inblock = 1; next }
  /^\[/             { inblock = 0 }
  inblock && /^[[:space:]]*name[[:space:]]*=/ {
    gsub(/.*=[[:space:]]*"?/, ""); gsub(/".*/, ""); print
  }
' "$topology")

[ "${#clusters[@]}" -ge 2 ] || { echo "need >=2 clusters in $topology, found ${#clusters[@]}"; exit 1; }

# Map each topology [[cluster]].name -> your kubectl context. Defaults assume a
# `<name>-fiducia` context; override any with CTX_<name>, e.g.
#   CTX_vultr=my-vke-ctx CTX_civo=my-civo-ctx ./tools/clustermesh.sh
ctx() {
  local var="CTX_$1"
  echo "${!var:-$1-fiducia}"
}

echo "== clusters from topology.toml: ${clusters[*]} =="

echo "== enable Cluster Mesh on each cluster =="
for c in "${clusters[@]}"; do
  cilium clustermesh enable --context "$(ctx "$c")" --service-type LoadBalancer
done
for c in "${clusters[@]}"; do
  cilium clustermesh status --context "$(ctx "$c")" --wait
done

echo "== connect every pair of clusters (full mesh) =="
n=${#clusters[@]}
for ((i = 0; i < n; i++)); do
  for ((j = i + 1; j < n; j++)); do
    a="${clusters[i]}"; b="${clusters[j]}"
    echo "  connect ${a} <-> ${b}"
    cilium clustermesh connect --context "$(ctx "$a")" --destination-context "$(ctx "$b")"
  done
done

echo "== done. Verify: cilium clustermesh status --context <ctx> =="
echo "Then the *_endpoint values in topology.toml can be mesh global-service DNS,"
echo "e.g. fiducia-node.fiducia.svc.clusterset.local:9090."
