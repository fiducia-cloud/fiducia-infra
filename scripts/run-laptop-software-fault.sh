#!/usr/bin/env bash
# Run one bounded Kubernetes-level laptop fault with a global coordination lock,
# explicit production acknowledgements, redacted before/after evidence, and full
# workload readiness before releasing the lock. Physical, network, disk, clock,
# thermal, upgrade, revocation, and restore faults remain manual runbook steps.
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cluster=""
context=""
coordination_context=""
revision=""
scenario=""
evidence_dir=""
observed_role="none"
apply="false"
ack_production="false"
ack_single="false"
ack_rollback="false"
ack_leader_last="false"

lock_name="fiducia-acceptance-active-fault"
lock_created="false"

usage() {
  cat <<'EOF'
usage:
  scripts/run-laptop-software-fault.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --coordination-context fiducia-laptop-aws-sim \
    --revision <40-character-git-sha> \
    --scenario cloudflared-pod-restart|stateless-api-pod-restart|fiducia-member-restart|jetstream-member-restart \
    --evidence-dir /secure/evidence/den-946 \
    [--observed-role follower|leader|none] \
    [--ack-leader-last] \
    [--ack-production-fault --ack-single-fault --ack-rollback-reviewed --apply]

Without --apply, prints a redacted plan and performs no Kubernetes write.
The stateful scenarios require --observed-role follower|leader. A leader requires
--ack-leader-last and should be exercised only after all follower cases recover.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

cleanup() {
  local exit_code=$?
  if [[ "$lock_created" == "true" ]]; then
    kubectl --context "$coordination_context" -n fiducia delete configmap "$lock_name" \
      --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

while (($#)); do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --context) context="${2:-}"; shift 2 ;;
    --coordination-context) coordination_context="${2:-}"; shift 2 ;;
    --revision) revision="${2:-}"; shift 2 ;;
    --scenario) scenario="${2:-}"; shift 2 ;;
    --evidence-dir) evidence_dir="${2:-}"; shift 2 ;;
    --observed-role) observed_role="${2:-}"; shift 2 ;;
    --ack-production-fault) ack_production="true"; shift ;;
    --ack-single-fault) ack_single="true"; shift ;;
    --ack-rollback-reviewed) ack_rollback="true"; shift ;;
    --ack-leader-last) ack_leader_last="true"; shift ;;
    --apply) apply="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$cluster" in
  laptop-aws-sim|laptop-gcp-sim|laptop-azure-sim) ;;
  *) fail "--cluster must name one of the three laptop clusters" ;;
esac
case "$scenario" in
  cloudflared-pod-restart|stateless-api-pod-restart|fiducia-member-restart|jetstream-member-restart) ;;
  *) fail "--scenario is not an approved automated Kubernetes fault" ;;
esac
[[ -n "$context" ]] || fail "--context is required"
[[ -n "$coordination_context" ]] || fail "--coordination-context is required"
[[ "$revision" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--revision must be an exact 40-character Git SHA"
[[ -n "$evidence_dir" && "$evidence_dir" = /* ]] || fail "--evidence-dir must be an absolute path"
case "$observed_role" in
  none|follower|leader) ;;
  *) fail "--observed-role must be none, follower, or leader" ;;
esac

stateful="false"
case "$scenario" in
  fiducia-member-restart|jetstream-member-restart) stateful="true" ;;
esac
if [[ "$stateful" == "true" && "$observed_role" == "none" ]]; then
  fail "$scenario requires --observed-role follower|leader from fresh live evidence"
fi
if [[ "$stateful" == "false" && "$observed_role" != "none" ]]; then
  fail "$scenario is not leader-sensitive; use --observed-role none"
fi
if [[ "$observed_role" == "leader" && "$ack_leader_last" != "true" ]]; then
  fail "a leader fault requires --ack-leader-last"
fi

case "$scenario" in
  cloudflared-pod-restart)
    app_label="fiducia-cloudflared"
    workload_kind="deployment"
    workload_name="fiducia-cloudflared"
    ;;
  stateless-api-pod-restart)
    app_label="fiducia-load-balance"
    workload_kind="deployment"
    workload_name="fiducia-load-balance"
    ;;
  fiducia-member-restart)
    app_label="fiducia-node"
    workload_kind="statefulset"
    workload_name="fiducia-node"
    ;;
  jetstream-member-restart)
    app_label="fiducia-nats"
    workload_kind="statefulset"
    workload_name="fiducia-nats"
    ;;
esac

cat <<EOF
bounded laptop software-fault plan
  scenario: $scenario
  cluster: $cluster
  target context: $context
  coordination context: $coordination_context
  pinned revision: ${revision,,}
  workload: fiducia/$workload_kind/$workload_name
  observed role: $observed_role
  global lock: fiducia/$lock_name
  evidence directory: $evidence_dir
  operation: delete exactly one selected pod, wait replacement readiness, capture redacted before/after status
  not verified by this script: external probes, alerts, Fiducia quorum, JetStream lag, protected mutation safety, physical recovery
EOF

[[ "$apply" == "true" ]] || exit 0
[[ "$ack_production" == "true" ]] || fail "--apply requires --ack-production-fault"
[[ "$ack_single" == "true" ]] || fail "--apply requires --ack-single-fault"
[[ "$ack_rollback" == "true" ]] || fail "--apply requires --ack-rollback-reviewed"

for command in date jq kubectl sha256sum; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

validate_context() {
  local kube_context="$1"
  local expected_cluster="$2"
  mapfile -t nodes < <(
    kubectl --context "$kube_context" get nodes \
      -l "fiducia.cloud/cluster=$expected_cluster,fiducia.cloud/substrate=laptop-k3s" \
      -o name
  )
  [[ ${#nodes[@]} -eq 1 ]] \
    || fail "context $kube_context must expose exactly one node labeled for $expected_cluster; found ${#nodes[@]}"
}
validate_context "$context" "$cluster"

mapfile -t coordination_nodes < <(
  kubectl --context "$coordination_context" get nodes \
    -l "fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#coordination_nodes[@]} -eq 1 ]] \
  || fail "coordination context must expose exactly one laptop-k3s node"

mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_id="${scenario}@${cluster}@$(date -u +%Y%m%dT%H%M%SZ)"
before="$evidence_dir/${run_id}.before.json"
after="$evidence_dir/${run_id}.after.json"
result="$evidence_dir/${run_id}.software-result.json"

kubectl --context "$coordination_context" -n fiducia create configmap "$lock_name" \
  --from-literal="campaign=den-946-three-laptop-acceptance-v1" \
  --from-literal="scenario=$scenario" \
  --from-literal="target=$cluster" \
  --from-literal="revision=${revision,,}" \
  --from-literal="startedAt=$started_at" >/dev/null \
  || fail "another acceptance fault lock already exists; inspect it and recover the prior fault before continuing"
lock_created="true"

"$repo_root/scripts/capture-laptop-cluster-snapshot.sh" \
  --cluster "$cluster" \
  --context "$context" \
  --revision "$revision" \
  --output "$before" >/dev/null

mapfile -t pods < <(
  kubectl --context "$context" -n fiducia get pods \
    -l "app=$app_label" \
    --field-selector=status.phase=Running \
    -o name
)
[[ ${#pods[@]} -eq 1 ]] \
  || fail "expected exactly one running app=$app_label pod; found ${#pods[@]}"
target_pod="${pods[0]}"

kubectl --context "$context" -n fiducia delete "$target_pod" --wait=false >/dev/null
kubectl --context "$context" -n fiducia wait --for=delete "$target_pod" --timeout=180s >/dev/null
kubectl --context "$context" -n fiducia rollout status "$workload_kind/$workload_name" --timeout=600s >/dev/null
kubectl --context "$context" -n fiducia wait pod \
  -l "app=$app_label" \
  --for=condition=Ready \
  --timeout=600s >/dev/null

"$repo_root/scripts/capture-laptop-cluster-snapshot.sh" \
  --cluster "$cluster" \
  --context "$context" \
  --revision "$revision" \
  --output "$after" >/dev/null
ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
before_sha="$(sha256sum "$before" | awk '{print $1}')"
after_sha="$(sha256sum "$after" | awk '{print $1}')"

jq -n \
  --arg runId "$run_id" \
  --arg scenarioId "$scenario" \
  --arg clusterName "$cluster" \
  --arg pinnedRevision "${revision,,}" \
  --arg observedRole "$observed_role" \
  --arg startedAt "$started_at" \
  --arg endedAt "$ended_at" \
  --arg workloadKind "$workload_kind" \
  --arg workloadName "$workload_name" \
  --arg beforeSnapshotSha256 "$before_sha" \
  --arg afterSnapshotSha256 "$after_sha" \
  '{
    schemaVersion: 1,
    evidenceMode: "live-local-software-fault",
    runId: $runId,
    scenarioId: $scenarioId,
    clusterName: $clusterName,
    pinnedRevision: $pinnedRevision,
    observedRole: $observedRole,
    startedAt: $startedAt,
    endedAt: $endedAt,
    workload: {kind: $workloadKind, name: $workloadName},
    podRestartCompleted: true,
    workloadReadyAfterRestart: true,
    beforeSnapshotSha256: $beforeSnapshotSha256,
    afterSnapshotSha256: $afterSnapshotSha256,
    externalVerificationRequired: [
      "independent external probes",
      "alert delivery",
      "Fiducia quorum and lag",
      "JetStream member and stream lag",
      "fencing and protected-mutation idempotency",
      "database outbox/inbox replay",
      "reviewer approval"
    ],
    nonClaim: "This local result is not a completed DEN-946 acceptance step until external and data-safety evidence is attached."
  }' >"$result"
chmod 600 "$result"

echo "software fault completed and workload recovered: $run_id"
echo "result: $result"
echo "the global lock will now be released; do not begin another fault until external evidence is reviewed"
