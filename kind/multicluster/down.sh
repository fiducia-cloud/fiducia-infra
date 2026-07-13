#!/usr/bin/env bash
# Tear down the local 3-cluster emulation.
#
#   ./down.sh   # delete all three kind clusters
#
# The FIDUCIA_PEERS/FIDUCIA_BRAIN_PEERS lines in the per-cluster topology.env files
# were rewritten in place by up.sh with live container IPs. They're placeholders —
# reset them with `git checkout kind/multicluster/*/topology.env` if you want a
# clean tree (up.sh rewrites them again next run regardless).
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
