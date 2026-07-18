#!/usr/bin/env bash
# Tear down the local 3-cluster emulation.
#
#   ./down.sh   # delete all three kind clusters
#
# `up.sh` renders live Kind peer addresses into the Kubernetes apply stream; it
# never modifies the checked-in topology.env templates. Tearing down an emulator
# therefore leaves the source tree unchanged.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools kind

for c in "${CLUSTERS[@]}"; do
  name="$(kind_name "$c")"
  if kind get clusters 2>/dev/null | grep -qx "$name"; then
    log "deleting kind cluster '$name'…"
    kind delete cluster --name "$name"
  else
    ok "'$name' not present — nothing to delete"
  fi
done
ok "emulation torn down"
