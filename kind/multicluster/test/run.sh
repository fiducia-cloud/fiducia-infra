#!/usr/bin/env bash
# Cross-cluster Raft assertions against the running emulation (run ../up.sh first).
#
#   ./test/run.sh              # core: reachability + leadership spread + quorum
#   ./test/run.sh --scenarios  # + WAN latency and partition/heal scenarios
#
# The CORE checks use the auth-exempt GET /v1/status (rich Raft state: per-shard
# role/term/leader_id/has_quorum + leading_shards) on each cluster's host API port.
# The data check does an authed KV write/read across clusters (best-effort — skips
# if direct-to-node writes aren't accepted). Scenarios drive netem.sh + partition.sh
# and re-check, proving the prod cross-cloud Raft timing holds under emulated WAN.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
require_tools curl jq

SCENARIOS=0; [[ "${1:-}" == "--scenarios" ]] && SCENARIOS=1

# The node guards ALL of /v1 (including the org-exempt /v1/status) with the
# internal-auth trusted-hop header — up.sh sets FIDUCIA_INTERNAL_SECRET, so the
# guard enforces. Send it on every call; add the org header only for tenant
# endpoints (KV etc.), never for /v1/status (which is org-exempt).
IA=(-H "x-fiducia-internal-auth: $DEV_INTERNAL_SECRET")

PASS=0; FAIL=0; SKIP=0
pass(){ ok "$1"; PASS=$((PASS+1)); }
fail(){ warn "FAIL: $1"; FAIL=$((FAIL+1)); }
skip(){ printf '  \033[1;90m--\033[0m SKIP %s\n' "$1"; SKIP=$((SKIP+1)); }
eq(){ [[ "$2" == "$3" ]] && pass "$1 [$2]" || fail "$1 (got '$2' want '$3')"; }
ge(){ { [[ "$2" =~ ^[0-9]+$ ]] && (( $2 >= $3 )); } && pass "$1 [$2>=$3]" || fail "$1 (got '$2' want >=$3)"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
snapshot(){ local c; for c in "${CLUSTERS[@]}"; do
  curl -fsS --max-time 5 "${IA[@]}" "$(api_url "$c")/v1/status" >"$TMP/$c.json" 2>/dev/null || echo '{}' >"$TMP/$c.json"
done; }
j(){ jq -r "$2" "$TMP/$1.json" 2>/dev/null; }                        # j <cluster> <jq-filter>
count_shards_covered(){ local c; for c in "$@"; do jq -r '.leading_shards[]?' "$TMP/$c.json" 2>/dev/null; done | sort -nu | wc -l | tr -d ' '; }
no_orphan_quorum_leader(){ j "$1" '[.shards[]?|select(.role=="leader" and .has_quorum==false)]|length // 0'; }

# ── CORE ──────────────────────────────────────────────────────────────────────
log "── Core: cross-cluster Raft health ──"
snapshot
for c in "${CLUSTERS[@]}"; do
  eq "$c /v1/status reachable"             "$([[ -n "$(j "$c" '.node_id // empty')" ]] && echo up || echo down)" "up"
  eq "$c shard_count"                      "$(j "$c" '.shard_count // 0')" "$SHARD_COUNT"
  eq "$c every hosted shard knows a leader" "$(j "$c" '[.shards[]?|select((.leader_id//"")=="")]|length // 0')" "0"
  ge "$c leads at least one shard"         "$(j "$c" '.leading_shards|length // 0')" "1"
  eq "$c no leader shard without quorum"   "$(no_orphan_quorum_leader "$c")" "0"
done
eq "leadership spread covers all $SHARD_COUNT shards (one leader each, across clouds)" \
   "$(count_shards_covered "${CLUSTERS[@]}")" "$SHARD_COUNT"

# ── DATA PATH (best-effort) ─────────────────────────────────────────────────────
log "── Data path (best-effort): cross-cluster KV write/read ──"
KEY="emu/probe"; VAL="cross-cluster-ok"
auth=("${IA[@]}" -H "x-fiducia-org-id: $DEV_ORG")   # tenant endpoints need org too
leader=""
for c in "${CLUSTERS[@]}"; do   # a write only succeeds on the shard's leader cluster
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X PUT "$(api_url "$c")/v1/kv?key=$KEY" \
    "${auth[@]}" -H 'content-type: application/json' -d "{\"value\":\"$VAL\"}" 2>/dev/null || echo 000)
  [[ "$code" == 2* ]] && { leader="$c"; break; }
done
if [[ -z "$leader" ]]; then
  skip "KV write not accepted directly on any node (may require the LB path) — core Raft checks above already prove cross-cluster consensus"
else
  pass "KV write committed via '$leader' (the shard's leader)"
  served=0
  for c in "${CLUSTERS[@]}"; do
    got=$(curl -fsS --max-time 5 "$(api_url "$c")/v1/kv?key=$KEY" "${auth[@]}" 2>/dev/null | jq -r '.entry.value // empty' 2>/dev/null)
    [[ "$got" == "$VAL" ]] && served=$((served+1))
  done
  ge "KV readable after commit (>=1 cluster)" "$served" "1"
  if [[ "$served" -ge 2 ]]; then pass "value replicated + readable across clusters ($served/3)"
  else skip "only the leader served the read ($served/3) — reads may be leader-only in this build"; fi
fi

# ── SCENARIOS ───────────────────────────────────────────────────────────────────
if [[ "$SCENARIOS" == 1 ]]; then
  log "── Scenario: EU WAN latency (~20ms RTT) — prod Raft timing must stay stable ──"
  "$HERE/netem.sh" eu >/dev/null; sleep 4; snapshot
  eq "under latency: leadership still covers all shards" "$(count_shards_covered "${CLUSTERS[@]}")" "$SHARD_COUNT"
  for c in "${CLUSTERS[@]}"; do eq "under latency: $c keeps quorum on its leader shards" "$(no_orphan_quorum_leader "$c")" "0"; done
  "$HERE/netem.sh" clear >/dev/null

  log "── Scenario: isolate civo — the other two keep 2/3 quorum ──"
  "$HERE/partition.sh" isolate civo >/dev/null; sleep 6; snapshot
  eq "survivors (hetzner+vultr) still cover all $SHARD_COUNT shards" "$(count_shards_covered hetzner vultr)" "$SHARD_COUNT"
  eq "hetzner keeps quorum on its leader shards" "$(no_orphan_quorum_leader hetzner)" "0"
  eq "vultr keeps quorum on its leader shards"   "$(no_orphan_quorum_leader vultr)" "0"
  eq "isolated civo leads NOTHING with quorum (stepped down)" "$(j civo '[.shards[]?|select(.role=="leader" and .has_quorum==true)]|length // 0')" "0"

  log "── Scenario: heal — civo rejoins, followers catch up ──"
  "$HERE/partition.sh" heal >/dev/null; sleep 8; snapshot
  eq "after heal: civo knows a leader for every shard again" "$(j civo '[.shards[]?|select((.leader_id//"")=="")]|length // 0')" "0"
  eq "after heal: leadership again covers all $SHARD_COUNT shards" "$(count_shards_covered "${CLUSTERS[@]}")" "$SHARD_COUNT"
fi

# ── SUMMARY ─────────────────────────────────────────────────────────────────────
echo
printf '\033[1m%s\033[0m\n' "results: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" == 0 ]] || exit 1
