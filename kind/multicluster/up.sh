#!/usr/bin/env bash
# Bring up the local 3-cluster emulation (Tier 2): by default, three single-node
# Kind clusters labelled as separate Hetzner regions. Each runs ONE fiducia-node
# + ONE fiducia-brain Raft member, wired into cross-cluster Raft groups over the
# shared `kind` Docker network. See README.md for the design + fidelity limits.
#
#   ./up.sh                        # create 3 clusters, deploy, wire peers
#   FIDUCIA_LOAD_IMAGES=1 ./up.sh  # `kind load` local images first (CI, no pull)
#
# Env: FIDUCIA_NODE_IMAGE, FIDUCIA_BRAIN_IMAGE, FIDUCIA_SIDECAR_IMAGE,
#      FIDUCIA_LB_IMAGE, FIDUCIA_EMULATION_PROFILE (default hetzner-regions),
#      FIDUCIA_LOAD_IMAGES=1, FIDUCIA_ROLLOUT_TIMEOUT (default 180s)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools kind kubectl docker

NODE_IMAGE="${FIDUCIA_NODE_IMAGE:-ghcr.io/fiducia-cloud/fiducia-node:v0.1.0}"
BRAIN_IMAGE="${FIDUCIA_BRAIN_IMAGE:-ghcr.io/fiducia-cloud/fiducia-brain:v0.1.0}"
SIDECAR_IMAGE="${FIDUCIA_SIDECAR_IMAGE:-ghcr.io/fiducia-cloud/fiducia-node-sidecar:v0.1.0}"
LB_IMAGE="${FIDUCIA_LB_IMAGE:-ghcr.io/fiducia-cloud/fiducia-load-balance:v0.1.0}"

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
    kind load docker-image "$NODE_IMAGE" "$BRAIN_IMAGE" "$SIDECAR_IMAGE" "$LB_IMAGE" --name "$(kind_name "$c")"
  done
fi

# 3. discover control-plane IPs and render each cluster's cross-cluster peers ------
# Pods can't resolve Kind container DNS names, so peers are addressed by the other
# clusters' control-plane container IPs (reachable from pods over the `kind` net).
for c in "${CLUSTERS[@]}"; do
  ip="$(cp_ip "$c")"
  [[ -n "$ip" ]] || die "no container IP for $(cp_container "$c") on network '$DOCKER_NET'"
  ok "$c control-plane @ $ip"
done
# Render the dynamic peer values into Kustomize's stdout instead of rewriting
# checked-in topology.env templates. A test run therefore cannot dirty or leave
# host-specific container addresses in the repository.
render_overlay() {
  local c="$1" o ip self_ip self_addr np bp
  local node_peers=() brain_peers=()
  self_ip="$(cp_ip "$c")"
  [[ -n "$self_ip" ]] || die "no container IP for $(cp_container "$c") on network '$DOCKER_NET'"
  for o in "${CLUSTERS[@]}"; do
    [[ "$o" == "$c" ]] && continue
    ip="$(cp_ip "$o")"
    [[ -n "$ip" ]] || die "no container IP for $(cp_container "$o") on network '$DOCKER_NET'"
    node_peers+=("${ip}:${NP_NODE_PEER}")
    brain_peers+=("http://${ip}:${NP_BRAIN_PEER}")
  done
  np="$(IFS=,; echo "${node_peers[*]}")"
  bp="$(IFS=,; echo "${brain_peers[*]}")"
  # It must be host:port without a scheme: the sidecar puts the node id inside
  # /v1/nodes/<node-id>/heartbeat and a scheme would introduce path slashes.
  self_addr="${self_ip}:${NP_API}"
  ok "$c self=$self_addr peers -> $np" >&2
  kubectl kustomize "$HERE/$c" | sed -E \
    -e "s|^  FIDUCIA_PEERS:.*|  FIDUCIA_PEERS: ${np}|" \
    -e "s|^  FIDUCIA_BRAIN_PEERS:.*|  FIDUCIA_BRAIN_PEERS: ${bp}|" \
    -e "s|^  FIDUCIA_SELF_ADDR:.*|  FIDUCIA_SELF_ADDR: ${self_addr}|"
}

# 4. dev secrets + deploy the overlay into each cluster ----------------------------
for c in "${CLUSTERS[@]}"; do
  log "deploying fiducia into $(kind_name "$c")…"
  kc "$c" create namespace "$NAMESPACE" --dry-run=client -o yaml | kc "$c" apply -f -
  kc "$c" -n "$NAMESPACE" create secret generic fiducia-secrets \
    --from-literal=internal-secret="$DEV_INTERNAL_SECRET" \
    --from-literal=brain-raft-secret="$DEV_BRAIN_SECRET" \
    --dry-run=client -o yaml | kc "$c" apply -f -
  render_overlay "$c" | kc "$c" apply -f -
done

# 5. wait for readiness ------------------------------------------------------------
# A failed rollout must be FATAL. Swallowing it (`|| warn`) also defeats `set -e`,
# so the READY banner below printed unconditionally and a broken deploy surfaced
# downstream only as opaque 90s `eventually` timeouts in fiducia-e2e.
to="${FIDUCIA_ROLLOUT_TIMEOUT:-180s}"
not_ready=0
for c in "${CLUSTERS[@]}"; do
  log "waiting for $c node + brain + load balance (timeout $to)…"
  for workload in statefulset/fiducia-node statefulset/fiducia-brain deployment/fiducia-load-balance; do
    if ! kc "$c" -n "$NAMESPACE" rollout status "$workload" --timeout="$to"; then
      warn "$c $workload not Ready in time (check: kubectl --context $(kube_ctx "$c") -n $NAMESPACE get pods)"
      not_ready=$((not_ready + 1))
    fi
  done
done
if (( not_ready > 0 )); then
  die "$not_ready workload rollout(s) did not become Ready — the emulation is NOT usable"
fi

# 6. summary -----------------------------------------------------------------------
echo
log "3-cluster ${EMULATION_PROFILE} emulation READY. Coordination APIs and local LBs:"
for c in "${CLUSTERS[@]}"; do printf '  %-8s node=%s/v1/status  lb=%s\n' "$c" "$(api_url "$c")" "$(lb_url "$c")"; done
cat <<EOF

Next:
  ./test/run.sh                 # assert cross-cluster Raft health
  ./netem.sh eu                 # inject ~20ms EU-spread WAN latency, then re-test
  ./partition.sh isolate $OUTAGE_CLUSTER   # simulate one member outage (other two keep quorum)
  ./partition.sh heal
  ./down.sh                     # tear it all down
EOF
