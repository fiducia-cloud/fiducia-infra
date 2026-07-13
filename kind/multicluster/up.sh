#!/usr/bin/env bash
# Bring up the local 3-cluster emulation (Tier 2): three single-node Kind clusters
# (hetzner/vultr/civo), each running ONE fiducia-node + ONE fiducia-brain Raft
# member, wired into cross-cluster Raft groups over the shared `kind` Docker
# network. See README.md for the design + fidelity limits.
#
#   ./up.sh                        # create 3 clusters, deploy, wire peers
#   FIDUCIA_LOAD_IMAGES=1 ./up.sh  # `kind load` local images first (CI, no pull)
#
# Env: FIDUCIA_NODE_IMAGE, FIDUCIA_BRAIN_IMAGE, FIDUCIA_SIDECAR_IMAGE,
#      FIDUCIA_LOAD_IMAGES=1, FIDUCIA_ROLLOUT_TIMEOUT (default 180s)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools kind kubectl docker

NODE_IMAGE="${FIDUCIA_NODE_IMAGE:-ghcr.io/fiducia-cloud/fiducia-node:v0.1.0}"
BRAIN_IMAGE="${FIDUCIA_BRAIN_IMAGE:-ghcr.io/fiducia-cloud/fiducia-brain:v0.1.0}"
SIDECAR_IMAGE="${FIDUCIA_SIDECAR_IMAGE:-ghcr.io/fiducia-cloud/fiducia-node-sidecar:v0.1.0}"

# 1. create the three kind clusters ------------------------------------------------
for c in "${CLUSTERS[@]}"; do
  name="$(kind_name "$c")"
  if kind get clusters 2>/dev/null | grep -qx "$name"; then
    log "kind cluster '$name' already exists — reusing"
  else
    log "creating kind cluster '$name' (emulated $c)…"
    kind create cluster --name "$name" --config "$HERE/kind-$c.yaml"
  fi
done

# 2. optionally load local images into each cluster (so no registry pull) ----------
if [[ "${FIDUCIA_LOAD_IMAGES:-0}" == "1" ]]; then
  for c in "${CLUSTERS[@]}"; do
    log "loading images into $(kind_name "$c")…"
    kind load docker-image "$NODE_IMAGE" "$BRAIN_IMAGE" "$SIDECAR_IMAGE" --name "$(kind_name "$c")"
  done
fi

# 3. discover control-plane IPs, rewrite each cluster's cross-cluster peers ---------
# Pods can't resolve Kind container DNS names, so peers are addressed by the other
# clusters' control-plane container IPs (reachable from pods over the `kind` net).
declare -A IP
for c in "${CLUSTERS[@]}"; do
  IP[$c]="$(cp_ip "$c")"
  [[ -n "${IP[$c]}" ]] || die "no container IP for $(cp_container "$c") on network '$DOCKER_NET'"
  ok "$c control-plane @ ${IP[$c]}"
done
for c in "${CLUSTERS[@]}"; do
  node_peers=(); brain_peers=()
  for o in "${CLUSTERS[@]}"; do
    [[ "$o" == "$c" ]] && continue
    node_peers+=("${IP[$o]}:${NP_NODE_PEER}")
    brain_peers+=("${IP[$o]}:${NP_BRAIN_PEER}")
  done
  np="$(IFS=,; echo "${node_peers[*]}")"
  bp="$(IFS=,; echo "${brain_peers[*]}")"
  env_file="$HERE/$c/topology.env"
  # portable in-place sed (works on BSD/macOS + GNU): rewrite only the peer lines.
  sed -i.bak -E "s#^FIDUCIA_PEERS=.*#FIDUCIA_PEERS=${np}#; s#^FIDUCIA_BRAIN_PEERS=.*#FIDUCIA_BRAIN_PEERS=${bp}#" "$env_file"
  rm -f "$env_file.bak"
  ok "$c peers -> $np"
done

# 4. dev secrets + deploy the overlay into each cluster ----------------------------
for c in "${CLUSTERS[@]}"; do
  log "deploying fiducia into $(kind_name "$c")…"
  kc "$c" create namespace "$NAMESPACE" --dry-run=client -o yaml | kc "$c" apply -f -
  kc "$c" -n "$NAMESPACE" create secret generic fiducia-secrets \
    --from-literal=internal-secret="$DEV_INTERNAL_SECRET" \
    --from-literal=brain-raft-secret="$DEV_BRAIN_SECRET" \
    --dry-run=client -o yaml | kc "$c" apply -f -
  kc "$c" apply -k "$HERE/$c"
done

# 5. wait for readiness ------------------------------------------------------------
to="${FIDUCIA_ROLLOUT_TIMEOUT:-180s}"
for c in "${CLUSTERS[@]}"; do
  log "waiting for $c node + brain (timeout $to)…"
  kc "$c" -n "$NAMESPACE" rollout status statefulset/fiducia-node  --timeout="$to" || warn "$c node not Ready in time (check: kubectl --context $(kube_ctx "$c") -n $NAMESPACE get pods)"
  kc "$c" -n "$NAMESPACE" rollout status statefulset/fiducia-brain --timeout="$to" || warn "$c brain not Ready in time"
done

# 6. summary -----------------------------------------------------------------------
echo
log "3-cluster emulation READY. Coordination APIs:"
for c in "${CLUSTERS[@]}"; do printf '  %-8s %s/v1/status\n' "$c" "$(api_url "$c")"; done
cat <<EOF

Next:
  ./test/run.sh                 # assert cross-cluster Raft health
  ./netem.sh eu                 # inject ~20ms EU-spread WAN latency, then re-test
  ./partition.sh isolate civo   # simulate a civo outage (other two keep quorum)
  ./partition.sh heal
  ./down.sh                     # tear it all down
EOF
