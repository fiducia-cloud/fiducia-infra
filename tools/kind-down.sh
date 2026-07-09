#!/usr/bin/env bash
# Tear down the local kind cluster created by kind-up.sh. Ephemeral test infra —
# deletes only the kind Docker cluster, no repo files.
#
#   tools/kind-down.sh
set -euo pipefail
CLUSTER="fiducia"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind delete cluster --name "$CLUSTER"
  echo "Deleted kind cluster '$CLUSTER'."
else
  echo "No kind cluster '$CLUSTER' to delete."
fi
