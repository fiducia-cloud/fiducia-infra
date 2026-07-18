#!/usr/bin/env bash
# Inject / clear emulated WAN conditions between the three clusters using `tc
# netem` on each Kind node container's eth0 (its interface on the shared `kind`
# network). Intra-cluster pod traffic does NOT traverse eth0, so this delays ONLY
# cross-cluster (and host) traffic — a faithful stand-in for inter-region RTT that
# does not slow each cluster's internal Raft/API.
#
#   ./netem.sh eu                       # ~10ms±3 egress each  -> ~20ms pairwise RTT (nearby EU)
#   ./netem.sh continental              # ~45ms±10 egress each -> ~90ms RTT (US<->EU stress)
#   ./netem.sh delay <ms> [jit] [loss]  # custom, applied to all clusters
#   ./netem.sh loss <cluster> <pct>     # add packet loss on one cluster's egress
#   ./netem.sh show                     # print current qdiscs
#   ./netem.sh clear                    # remove all emulation
#
# tc runs INSIDE the privileged Kind node containers (they have NET_ADMIN), so no
# host-level tc/root is needed. Delay is per-traversal: applying Xms to both ends
# of a link adds ~2X to the round trip (hence "10ms each -> ~20ms RTT").
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools docker

IFACE=eth0

# apply <container> <ms> <jitter_ms> <loss_pct>   (ms=0 -> loss-only)
apply_netem() {
  local ctr="$1" ms="$2" jit="$3" loss="$4" spec=""
  [[ "$ms"   != "0" ]] && spec="delay ${ms}ms ${jit}ms"
  [[ -n "$loss" && "$loss" != "0" ]] && spec="$spec loss ${loss}%"
  [[ -n "$spec" ]] || die "nothing to apply (ms and loss both zero)"
  # shellcheck disable=SC2086
  docker exec "$ctr" tc qdisc replace dev "$IFACE" root netem $spec
}
clear_one() { docker exec "$1" tc qdisc del dev "$IFACE" root 2>/dev/null || true; }

cmd="${1:-}"; shift || true
case "$cmd" in
  eu)          for c in "${CLUSTERS[@]}"; do apply_netem "$(cp_container "$c")" 10 3 0;  ok "$c: +10ms±3 (≈20ms pairwise RTT)"; done ;;
  continental) for c in "${CLUSTERS[@]}"; do apply_netem "$(cp_container "$c")" 45 10 0; ok "$c: +45ms±10 (≈90ms pairwise RTT)"; done ;;
  delay)       ms="${1:?ms}"; jit="${2:-2}"; loss="${3:-0}"
               for c in "${CLUSTERS[@]}"; do apply_netem "$(cp_container "$c")" "$ms" "$jit" "$loss"; ok "$c: +${ms}ms±${jit} loss=${loss}%"; done ;;
  loss)        c="${1:?cluster}"; pct="${2:?pct}"; apply_netem "$(cp_container "$c")" 0 0 "$pct"; ok "$c: loss ${pct}%" ;;
  show)        for c in "${CLUSTERS[@]}"; do echo "== $c =="; docker exec "$(cp_container "$c")" tc qdisc show dev "$IFACE"; done ;;
  clear)       for c in "${CLUSTERS[@]}"; do clear_one "$(cp_container "$c")"; ok "$c cleared"; done ;;
  *) die "usage: netem.sh {eu|continental|delay <ms> [jit] [loss]|loss <cluster> <pct>|show|clear}" ;;
esac
