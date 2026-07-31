#!/usr/bin/env bash
# Promote one laptop cluster through the cluster-local Argo CD controller.
# Stateless resources are staged first. Stateful resources require an explicit
# one-member-at-a-time acknowledgement, with the current leader promoted last.
set -euo pipefail

cluster=""
revision=""
context=""
phase=""
member_role=""
apply="false"
ack_one="false"
ack_leader_last="false"

usage() {
  cat <<'EOF'
usage:
  scripts/promote-laptop-cluster.sh \
    --cluster laptop-aws-sim \
    --revision <40-character-commit> \
    --context <kube-context> \
    --phase stateless|stateful \
    [--member-role follower|leader] \
    [--ack-one-member-at-a-time] \
    [--ack-leader-last] \
    [--apply]

Without --apply, validates the request and prints the guarded promotion plan.
Stateful promotion requires --ack-one-member-at-a-time. A leader additionally
requires --ack-leader-last; observe the live Fiducia/JetStream role before use.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --revision) revision="${2:-}"; shift 2 ;;
    --context) context="${2:-}"; shift 2 ;;
    --phase) phase="${2:-}"; shift 2 ;;
    --member-role) member_role="${2:-}"; shift 2 ;;
    --ack-one-member-at-a-time) ack_one="true"; shift ;;
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
[[ "$revision" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--revision must be an exact 40-character Git commit SHA"
[[ -n "$context" ]] || fail "--context is required"
[[ "$phase" == "stateless" || "$phase" == "stateful" ]] || fail "--phase must be stateless or stateful"

if [[ "$phase" == "stateful" ]]; then
  [[ "$ack_one" == "true" ]] || fail "stateful promotion requires --ack-one-member-at-a-time"
  [[ "$member_role" == "follower" || "$member_role" == "leader" ]] || fail "stateful promotion requires --member-role follower|leader"
  if [[ "$member_role" == "leader" && "$ack_leader_last" != "true" ]]; then
    fail "leader promotion requires --ack-leader-last"
  fi
fi

app="fiducia-$cluster"
revision="${revision,,}"

if [[ "$phase" == "stateless" ]]; then
  resources=(
    "apps:Deployment:*"
    "apps:DaemonSet:*"
    ":ConfigMap:*"
    ":Service:*"
    ":ServiceAccount:*"
    "rbac.authorization.k8s.io:Role:*"
    "rbac.authorization.k8s.io:RoleBinding:*"
    "rbac.authorization.k8s.io:ClusterRole:*"
    "rbac.authorization.k8s.io:ClusterRoleBinding:*"
    "networking.k8s.io:NetworkPolicy:*"
  )
else
  resources=(
    "apps:StatefulSet:*"
    "policy:PodDisruptionBudget:*"
  )
fi

printf 'promotion plan\n'
printf '  cluster: %s\n' "$cluster"
printf '  context: %s\n' "$context"
printf '  application: %s\n' "$app"
printf '  revision: %s\n' "$revision"
printf '  phase: %s\n' "$phase"
if [[ "$phase" == "stateful" ]]; then
  printf '  observed member role: %s\n' "$member_role"
  printf '  sequencing: one member only; followers before leader\n'
fi
printf '  resources:\n'
printf '    - %s\n' "${resources[@]}"

[[ "$apply" == "true" ]] || exit 0
command -v kubectl >/dev/null || fail "kubectl is required for --apply"
command -v argocd >/dev/null || fail "argocd CLI is required for --apply"

mapfile -t matching_nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#matching_nodes[@]} -eq 1 ]] \
  || fail "context $context must expose exactly one node labeled for $cluster"

current_revision="$(
  kubectl --context "$context" -n argocd get application "$app" \
    -o jsonpath='{.spec.source.targetRevision}'
)"

if [[ "$phase" == "stateless" ]]; then
  kubectl --context "$context" -n argocd patch application "$app" --type merge \
    -p "{\"spec\":{\"source\":{\"targetRevision\":\"$revision\"}}}" >/dev/null
else
  [[ "${current_revision,,}" == "$revision" ]] \
    || fail "stateful phase requires the Application to be staged at $revision; current revision is $current_revision"
fi

sync_args=(app sync "$app" --core --kube-context "$context" --prune=false)
for resource in "${resources[@]}"; do
  sync_args+=(--resource "$resource")
done
argocd "${sync_args[@]}"
argocd app wait "$app" --core --kube-context "$context" --operation --timeout 600

kubectl --context "$context" -n argocd annotate application "$app" --overwrite \
  "fiducia.cloud/last-promotion-revision=$revision" \
  "fiducia.cloud/last-promotion-phase=$phase" \
  "fiducia.cloud/last-promotion-cluster=$cluster" >/dev/null

if [[ "$phase" == "stateful" ]]; then
  kubectl --context "$context" -n argocd annotate application "$app" --overwrite \
    "fiducia.cloud/observed-member-role=$member_role" >/dev/null
fi

echo "completed $phase promotion for $cluster at $revision"
