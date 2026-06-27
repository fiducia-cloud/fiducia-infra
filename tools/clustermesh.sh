#!/usr/bin/env bash
# Stitch the clusters from topology.toml together with Cilium Cluster Mesh, so
# pods (and thus Raft peers) are routable across GCP / AWS / Hetzner.
#
# Prereqs: the `cilium` CLI, Cilium installed in each cluster with a unique
# cluster-id/name, and a kubectl context per cluster. This handles
# connectivity = "clustermesh"; for "wireguard" or "public-mtls" see the README.
set -euo pipefail

# Map each topology [[cluster]].name -> your kubectl context. EDIT THESE (or pass
# as env, e.g. CTX_gcp=my-gke-context ./tools/clustermesh.sh).
CTX_gcp="${CTX_gcp:-gke-fiducia}"
CTX_aws="${CTX_aws:-eks-fiducia}"
CTX_hetzner="${CTX_hetzner:-hetzner-fiducia}"

clusters=(gcp aws hetzner)
ctx() { local v="CTX_$1"; echo "${!v}"; }

echo "== enable Cluster Mesh on each cluster =="
for c in "${clusters[@]}"; do
  cilium clustermesh enable --context "$(ctx "$c")" --service-type LoadBalancer
done
for c in "${clusters[@]}"; do
  cilium clustermesh status --context "$(ctx "$c")" --wait
done

echo "== connect every pair of clusters =="
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
