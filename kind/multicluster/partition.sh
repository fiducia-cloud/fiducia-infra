#!/usr/bin/env bash
# Simulate cross-cluster network partitions by DROPping traffic between the Kind
# node containers (matched by container IP) with iptables, inside a dedicated
# FIDUCIA_EMU chain so `heal` is a clean flush. Host->cluster API access is
# unaffected (the host is not a peer IP), so you can still read /v1/status on an
# isolated cluster to watch it lose quorum.
#
#   ./partition.sh isolate <cluster>     # cut <cluster> off from the other two
#   ./partition.sh directed <from> <to>  # one-way drop from->to (ASYMMETRIC)
#   ./partition.sh split-brain           # 1-1-1: every cluster isolated (no quorum)
#   ./partition.sh heal                  # remove all injected partitions
#   ./partition.sh show
#
# iptables runs inside the privileged Kind node containers. Directed/asymmetric
# drops are the interesting case: real outages are rarely clean bidirectional cuts.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools docker

CHAIN=FIDUCIA_EMU

# Drops live in the RAW table, jumped from PREROUTING + OUTPUT. raw runs BEFORE
# conntrack and BEFORE kube-proxy's NodePort DNAT, so a DROP there is unconditional
# — it isn't bypassed by an ESTABLISHED-conntrack ACCEPT and it matches the peer's
# real IP before DNAT rewrites the destination. (The filter INPUT/OUTPUT/FORWARD
# hooks are all too late/partial for kind's NodePort + pod-forwarded peer path.)
#   - raw PREROUTING sees traffic ARRIVING on any iface: inbound from a peer (match
#     -s peer) AND a local pod's packet heading to a peer (match -d peer).
#   - raw OUTPUT sees host-generated traffic to a peer (match -d peer).
ensure_chain() { # <container>
  docker exec "$1" sh -c "
    iptables -t raw -N $CHAIN 2>/dev/null || true
    for hook in PREROUTING OUTPUT; do
      iptables -t raw -C \$hook -j $CHAIN 2>/dev/null || iptables -t raw -I \$hook -j $CHAIN
    done
  "
}
drop_both()     { docker exec "$1" sh -c "iptables -t raw -A $CHAIN -s $2 -j DROP; iptables -t raw -A $CHAIN -d $2 -j DROP"; }  # <ctr> <peer-ip>
drop_out_only() { docker exec "$1" sh -c "iptables -t raw -A $CHAIN -d $2 -j DROP"; }                                          # <ctr> <peer-ip>
heal_one()      { docker exec "$1" sh -c "iptables -t raw -F $CHAIN 2>/dev/null || true"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  isolate)
    tgt="${1:?cluster}"; ensure_chain "$(cp_container "$tgt")"
    for o in "${CLUSTERS[@]}"; do
      [[ "$o" == "$tgt" ]] && continue
      drop_both "$(cp_container "$tgt")" "$(cp_ip "$o")"
    done
    ok "$tgt isolated — the other two clusters keep 2/3 quorum, $tgt loses it"
    ;;
  directed)
    from="${1:?from}"; to="${2:?to}"; ensure_chain "$(cp_container "$from")"
    drop_out_only "$(cp_container "$from")" "$(cp_ip "$to")"
    ok "one-way drop $from -> $to (asymmetric; return path still open)"
    ;;
  split-brain)
    for c in "${CLUSTERS[@]}"; do
      ensure_chain "$(cp_container "$c")"
      for o in "${CLUSTERS[@]}"; do [[ "$o" == "$c" ]] && continue; drop_both "$(cp_container "$c")" "$(cp_ip "$o")"; done
    done
    ok "split-brain: all three isolated — NO cluster has quorum (expect reads refused)"
    ;;
  heal)
    for c in "${CLUSTERS[@]}"; do heal_one "$(cp_container "$c")"; done
    ok "all partitions healed — expect re-election + follower catch-up"
    ;;
  show)
    for c in "${CLUSTERS[@]}"; do echo "== $c =="; docker exec "$(cp_container "$c")" sh -c "iptables -t raw -S $CHAIN 2>/dev/null || echo '(no $CHAIN chain)'"; done
    ;;
  *) die "usage: partition.sh {isolate <cluster>|directed <from> <to>|split-brain|heal|show}" ;;
esac
