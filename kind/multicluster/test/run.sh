#!/usr/bin/env bash
# Cross-cluster Raft assertions against the running emulation (run ../up.sh first).
#
#   ./test/run.sh              # core: reachability + leadership safety + quorum
#   ./test/run.sh --scenarios  # + WAN, partition/heal, and whole-cluster failover
#
# The CORE checks use GET /v1/status (rich Raft state: per-shard
# role/term/leader_id/has_quorum + leading_shards) on each cluster's host API port.
# /v1/status is org-exempt but still trusted-hop authenticated, so we send the
# internal-auth header (org header is added only for tenant endpoints like KV).
# The data check does an authed KV write/read across clusters (best-effort — skips
# if direct-to-node writes aren't accepted). Scenarios drive netem.sh,
# partition.sh, and a reversible Kind control-plane pause, proving the prod
# cross-cluster Raft timing holds through WAN faults and a whole-member outage.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
require_tools curl jq

SCENARIOS=0; [[ "${1:-}" == "--scenarios" ]] && SCENARIOS=1
PRIMARY_CLUSTER="${CLUSTERS[0]}"
OUTAGE_SURVIVORS=()
while IFS= read -r cluster; do OUTAGE_SURVIVORS+=("$cluster"); done < <(survivor_clusters "$OUTAGE_CLUSTER")
[[ "${#OUTAGE_SURVIVORS[@]}" == 2 ]] || die "expected exactly two survivors for $OUTAGE_CLUSTER"

# The node guards ALL of /v1 (including the org-exempt /v1/status) with the
# internal-auth trusted-hop header — up.sh sets FIDUCIA_INTERNAL_SECRET, so the
# guard enforces. Send it on every call; add the org header only for tenant
# endpoints (KV etc.), never for /v1/status (which is org-exempt).
IA=(-H "x-fiducia-internal-auth: $DEV_INTERNAL_SECRET")

PASS=0; FAIL=0; SKIP=0
pass(){ ok "$1"; PASS=$((PASS+1)); }
fail(){ warn "FAIL: $1"; FAIL=$((FAIL+1)); }
skip(){ printf '  \033[1;90m--\033[0m SKIP %s\n' "$1"; SKIP=$((SKIP+1)); }
eq(){
  if [[ "$2" == "$3" ]]; then pass "$1 [$2]"; else fail "$1 (got '$2' want '$3')"; fi
}
ge(){
  if [[ "$2" =~ ^[0-9]+$ ]] && (( $2 >= $3 )); then pass "$1 [$2>=$3]"; else fail "$1 (got '$2' want >=$3)"; fi
}

TMP="$(mktemp -d)"
PAUSED_CONTAINER=""
cleanup(){
  # A scenario may stop the runner after Docker has paused a whole emulated
  # member. Always resume it. Keep the temporary snapshots for post-failure
  # forensics; test cleanup must never erase diagnostic evidence.
  [[ -z "$PAUSED_CONTAINER" ]] || docker unpause "$PAUSED_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT
snapshot_one(){
  local c="$1"
  # The node wraps NodeStatus under `.consensus`; unwrap so filters read .shards etc.
  curl -fsS --max-time 5 "${IA[@]}" "$(api_url "$c")/v1/status" 2>/dev/null \
    | jq '.consensus // .' >"$TMP/$c.json" 2>/dev/null || echo '{}' >"$TMP/$c.json"
}
snapshot(){ local c; for c in "${CLUSTERS[@]}"; do snapshot_one "$c"; done; }
j(){ jq -r "$2" "$TMP/$1.json" 2>/dev/null; }                        # j <cluster> <jq-filter>
count_shards_covered(){ local c; for c in "$@"; do jq -r '.leading_shards[]?' "$TMP/$c.json" 2>/dev/null; done | sort -nu | wc -l | tr -d ' '; }
no_orphan_quorum_leader(){ j "$1" '[.shards[]?|select(.role=="leader" and .has_quorum==false)]|length // 0'; }
min_leader_replicas(){ local c; for c in "${CLUSTERS[@]}"; do j "$c" '.shards[]?|select(.role=="leader")|.healthy_replicas'; done | sort -n | head -1; }

# ── CONVERGENCE ─────────────────────────────────────────────────────────────────
# up.sh only waits for pod readiness; Raft still needs a few seconds after a
# rollout to elect leaders for all shards. Poll until every shard is led with
# quorum (or the timeout passes — then run the assertions anyway so the failure
# output shows the real state).
wait_converged(){
  local timeout="${FIDUCIA_CONVERGE_TIMEOUT:-90}" deadline=$((SECONDS+${FIDUCIA_CONVERGE_TIMEOUT:-90}))
  local covered=0 orphans c
  while (( SECONDS < deadline )); do
    snapshot
    covered="$(count_shards_covered "${CLUSTERS[@]}")"; orphans=0
    for c in "${CLUSTERS[@]}"; do [[ "$(no_orphan_quorum_leader "$c")" == "0" ]] || orphans=1; done
    if [[ "$covered" == "$SHARD_COUNT" && "$orphans" == 0 ]]; then
      ok "converged: all $SHARD_COUNT shards led with quorum"; return 0
    fi
    sleep 3
  done
  warn "not converged after ${timeout}s (covered=$covered/$SHARD_COUNT) — asserting anyway"
}

log "── Waiting for Raft convergence ──"
wait_converged

# ── CORE ──────────────────────────────────────────────────────────────────────
log "── Core: cross-cluster Raft health ──"
snapshot
for c in "${CLUSTERS[@]}"; do
  eq "$c /v1/status reachable"              "$([[ -n "$(j "$c" '.node_id // empty')" ]] && echo up || echo down)" "up"
  eq "$c shard_count"                       "$(j "$c" '.shard_count // 0')" "$SHARD_COUNT"
  eq "$c hosts all $SHARD_COUNT shards"     "$(j "$c" '.hosted_shards|length // 0')" "$SHARD_COUNT"
  eq "$c every hosted shard knows a leader" "$(j "$c" '[.shards[]?|select((.leader_id//"")=="")]|length // 0')" "0"
  eq "$c no leader shard without quorum"    "$(no_orphan_quorum_leader "$c")" "0"
done
# Fleet-wide Raft SAFETY invariants (not spread — spread is a brain optimization):
#  (a) every shard is led somewhere, and (b) there is EXACTLY one leadership per
#  shard (Σ leading_shards == shard_count ⇒ no shard double-led = no split-brain).
eq "every shard is led (union of leaders covers all $SHARD_COUNT)" \
   "$(count_shards_covered "${CLUSTERS[@]}")" "$SHARD_COUNT"
eq "exactly $SHARD_COUNT leaderships fleet-wide (no split-brain double leader)" \
   "$(for c in "${CLUSTERS[@]}"; do j "$c" '.leading_shards[]?'; done | wc -l | tr -d ' ')" "$SHARD_COUNT"
# CROSS-CLUSTER REPLICATION PROOF: every leader shard has a majority of its 3
# cross-cluster replicas caught up to the commit index (has_quorum already checked;
# this asserts the actual replica count spans clusters).
minrep="$(min_leader_replicas)"
ge "leader shards hold cross-cluster quorum (min healthy_replicas ≥ 2 of 3)" "${minrep:-0}" "2"
fullrep=$(for c in "${CLUSTERS[@]}"; do j "$c" '[.shards[]?|select(.role=="leader" and .healthy_replicas>=3)]|length'; done | paste -sd+ - | bc 2>/dev/null || echo 0)
printf '  \033[1;90m--\033[0m INFO %s/%s leader shards fully replicated on all 3 clusters; leadership currently on %s/3 clusters (brain rebalances over time)\n' \
  "${fullrep:-0}" "$SHARD_COUNT" "$(for c in "${CLUSTERS[@]}"; do [[ "$(j "$c" '.leading_shards|length // 0')" -ge 1 ]] && echo x; done | wc -l | tr -d ' ')"

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
    got=$(curl -fsS --max-time 5 "$(api_url "$c")/v1/kv?key=$KEY" "${auth[@]}" 2>/dev/null | jq -r '.entry.value // empty' 2>/dev/null || echo '')
    [[ "$got" == "$VAL" ]] && served=$((served+1)) || true
  done
  ge "KV readable after commit (>=1 cluster)" "$served" "1"
  if [[ "$served" -ge 2 ]]; then pass "value replicated + readable across clusters ($served/3)"
  else skip "only the leader served the read ($served/3) — reads may be leader-only in this build"; fi
fi

# ── REAL LB ROUTING PATH ────────────────────────────────────────────────────────
# The production entrypoint: client → fiducia-load-balance → shard leader. The LB
# authenticates via the trusted-edge hop (x-fiducia-edge-auth == the internal
# secret, plus forwarded identity headers), enforces per-route scopes, computes
# key → shard via the compiled-in fiducia-routing crate, resolves the shard's
# leader from brain placement / NotLeader hints, and forwards with the
# trusted-hop secret + injected org. Leaders are spread across all 3 clusters, so
# some of these writes MUST be forwarded cross-cluster (sidecars advertise
# hostIP:30080, which is routable between the kind clusters).
log "── Real LB routing path (client → LB → shard leader, cross-cluster) ──"
edge=(-H "x-fiducia-edge-auth: $DEV_INTERNAL_SECRET" -H "x-fiducia-org-id: $DEV_ORG" -H "x-fiducia-scopes: admin:write admin:read kv:write kv:read")
for c in "${CLUSTERS[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$(lb_url "$c")/healthz" 2>/dev/null || echo 000)
  eq "$c LB /healthz (public, no auth)" "$code" "200"
done

# Fail-closed authz through the REAL LB: anonymous + insufficient scope. The
# local profile explicitly enables FIDUCIA_AUTH_REQUIRED, so credential-less
# requests are rejected at authentication (401) before route-scope evaluation.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X PUT "$(lb_url "$PRIMARY_CLUSTER")/v1/kv?key=emu/deny" \
  -H 'content-type: application/json' -d '{"value":"x"}' 2>/dev/null || echo 000)
# Anonymous (no raw credential or trusted-edge proof) fails closed before it can
# reach a node. It is intentionally 401 rather than 403 so callers can obtain a
# credential instead of inferring route authorization from an anonymous request.
eq "LB rejects ANONYMOUS kv write (missing credential, 401)" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X PUT "$(lb_url "$PRIMARY_CLUSTER")/v1/kv?key=emu/deny" \
  -H "x-fiducia-edge-auth: $DEV_INTERNAL_SECRET" -H "x-fiducia-org-id: $DEV_ORG" -H "x-fiducia-scopes: kv:read" \
  -H 'content-type: application/json' -d '{"value":"x"}' 2>/dev/null || echo 000)
eq "LB rejects kv:read-only scope for a write (403)" "$code" "403"

# Data path: N keys via EACH cluster's LB. Keys hash to different shards whose
# leaders live in different clusters → exercises local AND cross-cluster forwards
# + NotLeader refresh. Then read every key back through a DIFFERENT cluster's LB.
wrote=0; read_ok=0; total=0
for i in 1 2 3 4 5 6; do
  for c in "${CLUSTERS[@]}"; do
    total=$((total+1))
    key="emu/lb/$c/$i"; val="v-$c-$i"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X PUT "$(lb_url "$c")/v1/kv?key=$key" \
      "${edge[@]}" -H 'content-type: application/json' -d "{\"value\":\"$val\"}" 2>/dev/null || echo 000)
    [[ "$code" == 2* ]] && wrote=$((wrote+1)) || true
    # read back via the NEXT cluster's LB (cross-entrypoint linearizable read)
    rc="$(next_cluster "$c")"
    got=$(curl -fsS --max-time 8 "$(lb_url "$rc")/v1/kv?key=$key" "${edge[@]}" 2>/dev/null | jq -r '.entry.value // empty' 2>/dev/null || echo '')
    [[ "$got" == "$val" ]] && read_ok=$((read_ok+1)) || true
  done
done
eq "LB writes committed ($total keys via all 3 LBs)" "$wrote" "$total"
eq "cross-LB reads returned the written values"      "$read_ok" "$total"

# The reads were issued to a DIFFERENT cluster's LB than the write, and every one
# returned the committed value — so the write was replicated cross-cluster AND the
# reading LB either served it locally (its own replica is caught up) or forwarded
# to the remote leader. Either way the value crossed clusters. Whenever leaders are
# NOT all on one cluster (brain rebalanced), some writes were also forwarded
# cross-cluster from the LB; report the current placement.
snapshot
# `|| true` keeps a false [[ ]] on the LAST iteration from failing the loop —
# under pipefail that would fail the whole substitution and set -e kills the run.
led=$(for c in "${CLUSTERS[@]}"; do [[ "$(j "$c" '.leading_shards|length // 0')" -ge 1 ]] && echo x || true; done | wc -l | tr -d ' ')
printf '  \033[1;90m--\033[0m INFO cross-LB reads all resolved (%s/%s); shard leaders currently on %s/3 clusters\n' "$read_ok" "$total" "$led"

# ── SCENARIOS ───────────────────────────────────────────────────────────────────
if [[ "$SCENARIOS" == 1 ]]; then
  log "── Scenario: EU WAN latency (~20ms RTT) — prod Raft timing must stay stable ──"
  "$HERE/netem.sh" eu >/dev/null; sleep 4; snapshot
  eq "under latency: leadership still covers all shards" "$(count_shards_covered "${CLUSTERS[@]}")" "$SHARD_COUNT"
  for c in "${CLUSTERS[@]}"; do eq "under latency: $c keeps quorum on its leader shards" "$(no_orphan_quorum_leader "$c")" "0"; done
  "$HERE/netem.sh" clear >/dev/null

  log "── Scenario: isolate $OUTAGE_CLUSTER — the other two keep 2/3 quorum ──"
  # Isolating the (possibly leader-heavy) member forces re-election on the survivors
  # AND civo's check_quorum step-down; both take several election timeouts
  # (election_min 600ms + jitter). Give it room, then poll to the survivors' target.
  "$HERE/partition.sh" isolate "$OUTAGE_CLUSTER" >/dev/null
  for _ in $(seq 1 10); do sleep 3; snapshot; [[ "$(count_shards_covered "${OUTAGE_SURVIVORS[@]}")" == "$SHARD_COUNT" ]] && break; done
  eq "survivors (${OUTAGE_SURVIVORS[*]}) still cover all $SHARD_COUNT shards" "$(count_shards_covered "${OUTAGE_SURVIVORS[@]}")" "$SHARD_COUNT"
  for cluster in "${OUTAGE_SURVIVORS[@]}"; do
    eq "$cluster keeps quorum on its leader shards" "$(no_orphan_quorum_leader "$cluster")" "0"
  done
  eq "isolated $OUTAGE_CLUSTER leads NOTHING with quorum (stepped down)" "$(j "$OUTAGE_CLUSTER" '[.shards[]?|select(.role=="leader" and .has_quorum==true)]|length // 0')" "0"

  log "── Scenario: heal — $OUTAGE_CLUSTER rejoins, followers catch up ──"
  "$HERE/partition.sh" heal >/dev/null
  for _ in $(seq 1 8); do
    sleep 3; snapshot
    healed_minrep="$(min_leader_replicas)"
    [[ "$(j "$OUTAGE_CLUSTER" '[.shards[]?|select((.leader_id//"")=="")]|length // 0')" == "0" \
      && "$healed_minrep" =~ ^[0-9]+$ && "$healed_minrep" -ge 3 ]] && break
  done
  eq "after heal: $OUTAGE_CLUSTER knows a leader for every shard again" "$(j "$OUTAGE_CLUSTER" '[.shards[]?|select((.leader_id//"")=="")]|length // 0')" "0"
  eq "after heal: leadership again covers all $SHARD_COUNT shards" "$(count_shards_covered "${CLUSTERS[@]}")" "$SHARD_COUNT"
  ge "after heal: every leader has all 3 replicas healthy" "$(min_leader_replicas)" "3"

  log "── Scenario: pause $OUTAGE_CLUSTER control plane — survivors keep serving, then it catches up ──"
  require_tools docker
  PAUSED_CONTAINER="$(cp_container "$OUTAGE_CLUSTER")"
  docker pause "$PAUSED_CONTAINER" >/dev/null
  docker inspect -f '{{.State.Paused}}' "$PAUSED_CONTAINER" | grep -qx true || die "failed to pause $PAUSED_CONTAINER"
  pass "$OUTAGE_CLUSTER Kind control plane paused (whole-member outage injected)"

  # Unlike partition.sh, this removes the target's Kubernetes API, workloads, and
  # NodePorts together. Probe only the two survivors while the target is paused:
  # a paused host port may legitimately wait until curl's timeout.
  for _ in $(seq 1 10); do
    sleep 3
    for cluster in "${OUTAGE_SURVIVORS[@]}"; do snapshot_one "$cluster"; done
    [[ "$(count_shards_covered "${OUTAGE_SURVIVORS[@]}")" == "$SHARD_COUNT" ]] && break
  done
  eq "after whole-member loss: survivors cover all $SHARD_COUNT shards" "$(count_shards_covered "${OUTAGE_SURVIVORS[@]}")" "$SHARD_COUNT"
  for cluster in "${OUTAGE_SURVIVORS[@]}"; do
    eq "after whole-member loss: $cluster has no unquorate leader" "$(no_orphan_quorum_leader "$cluster")" "0"
  done

  outage_key="emu/failover/${OUTAGE_CLUSTER}-pause-${SECONDS}-$$"
  outage_value="committed-during-${OUTAGE_CLUSTER}-pause"
  outage_write_attempt=0; code=000
  # Raft leadership converges before every LB's periodic brain-table refresh.
  # A production caller retries an idempotent/fenced request across that short
  # window; make it an explicit bounded assertion instead of a flaky one-shot.
  for attempt in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X PUT "$(lb_url "${OUTAGE_SURVIVORS[0]}")/v1/kv?key=$outage_key" \
      "${edge[@]}" -H 'content-type: application/json' -d "{\"value\":\"$outage_value\"}" 2>/dev/null || echo 000)
    [[ "$code" == 2* ]] && { outage_write_attempt="$attempt"; break; }
    sleep 1
  done
  ge "after whole-member loss: survivor LB write commits within 10s (last status $code)" "$outage_write_attempt" "1"
  got=''
  if [[ "$outage_write_attempt" -ge 1 ]]; then
    got=$(curl -fsS --max-time 10 "$(lb_url "${OUTAGE_SURVIVORS[1]}")/v1/kv?key=$outage_key" "${edge[@]}" 2>/dev/null | jq -r '.entry.value // empty' 2>/dev/null || echo '')
  fi
  eq "after whole-member loss: other survivor LB reads committed value" "$got" "$outage_value"

  docker unpause "$PAUSED_CONTAINER" >/dev/null
  PAUSED_CONTAINER=""
  for _ in $(seq 1 12); do
    sleep 3; snapshot
    recovered_minrep="$(min_leader_replicas)"
    [[ "$(count_shards_covered "${CLUSTERS[@]}")" == "$SHARD_COUNT" \
      && "$(j "$OUTAGE_CLUSTER" '[.shards[]?|select((.leader_id//"")=="")]|length // 0')" == "0" \
      && "$recovered_minrep" =~ ^[0-9]+$ && "$recovered_minrep" -ge 3 ]] && break
  done
  eq "after whole-member recovery: $OUTAGE_CLUSTER status is reachable" "$( [[ -n "$(j "$OUTAGE_CLUSTER" '.node_id // empty')" ]] && echo up || echo down )" "up"
  eq "after whole-member recovery: $OUTAGE_CLUSTER knows every shard leader" "$(j "$OUTAGE_CLUSTER" '[.shards[]?|select((.leader_id//"")=="")]|length // 0')" "0"
  eq "after whole-member recovery: leadership covers all $SHARD_COUNT shards" "$(count_shards_covered "${CLUSTERS[@]}")" "$SHARD_COUNT"
  ge "after whole-member recovery: every leader has all 3 replicas healthy" "$(min_leader_replicas)" "3"
fi

# ── SUMMARY ─────────────────────────────────────────────────────────────────────
echo
printf '\033[1m%s\033[0m\n' "results: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" == 0 ]] || exit 1
