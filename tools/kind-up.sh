#!/usr/bin/env bash
# Bring up the local kind cluster (Tier 1) and deploy fiducia onto it, so the
# fiducia-e2e conformance + chaos suite has a real coordination API to hit with
# zero cloud spend.
#
#   tools/kind-up.sh                 # create cluster + deploy fiducia
#   FIDUCIA_LOAD_IMAGES=1 tools/kind-up.sh   # also `kind load` local images first
#
# Env:
#   FIDUCIA_NODE_IMAGE     (default ghcr.io/fiducia-cloud/fiducia-node:v0.1.0)
#   FIDUCIA_SIDECAR_IMAGE  (default ghcr.io/fiducia-cloud/fiducia-node-sidecar:v0.1.0)
#   FIDUCIA_LOAD_IMAGES=1  load those images from the local Docker daemon into kind
#                          (set this in CI after building them, so no registry pull)
#
# After it prints READY, run the suite:
#   FIDUCIA_E2E_BASE_URL=http://localhost:8090 npm --prefix ../fiducia-e2e test
set -euo pipefail

CLUSTER="fiducia"
# Every kubectl call MUST pin this context — the cluster-reuse path must never
# inherit the ambient kubeconfig context (which could be a real cluster).
CTX="kind-${CLUSTER}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_IMAGE="${FIDUCIA_NODE_IMAGE:-ghcr.io/fiducia-cloud/fiducia-node:v0.1.0}"
SIDECAR_IMAGE="${FIDUCIA_SIDECAR_IMAGE:-ghcr.io/fiducia-cloud/fiducia-node-sidecar:v0.1.0}"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "kind cluster '$CLUSTER' already exists — reusing it."
else
  echo "Creating kind cluster '$CLUSTER' (1 control-plane + 4 zone-labeled workers)…"
  kind create cluster --config "$ROOT/kind/multizone.yaml"
fi

if [[ "${FIDUCIA_LOAD_IMAGES:-0}" == "1" ]]; then
  echo "Loading images into kind (from local Docker daemon)…"
  kind load docker-image "$NODE_IMAGE" --name "$CLUSTER"
  kind load docker-image "$SIDECAR_IMAGE" --name "$CLUSTER"
fi

echo "Deploying fiducia (kind overlay)…"
kubectl apply -k "$ROOT/kind/overlay"

echo "Waiting for fiducia-node to become ready…"
kubectl -n fiducia rollout status statefulset/fiducia-node --timeout="${FIDUCIA_ROLLOUT_TIMEOUT:-180s}"

echo
echo "READY. Coordination API is exposed at:"
echo "  FIDUCIA_E2E_BASE_URL=http://localhost:8090"
echo
echo "Zones (failure domains) — one fiducia-node replica each:"
kubectl get nodes -L topology.kubernetes.io/zone
