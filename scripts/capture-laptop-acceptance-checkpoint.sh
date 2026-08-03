#!/usr/bin/env bash
# Capture a redacted, hash-addressed checkpoint for one DEN-946 acceptance
# scenario. This script never injects faults, changes workloads, or reads Secret
# or ConfigMap values. The operator performs every fault/recovery manually.
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cluster=""
context=""
scenario=""
phase=""
revision=""
output_dir=""

usage() {
  cat <<'USAGE'
usage:
  scripts/capture-laptop-acceptance-checkpoint.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --scenario follower-laptop-power-loss \
    --phase before|fault|recovered|start|daily|complete \
    --revision <40-character-git-sha> \
    --output-dir /secure/evidence/den-946

The script is capture-only. It does not power off hosts, partition networks,
change clocks, fill disks, revoke devices, restore data, or restart workloads.
USAGE
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --context) context="${2:-}"; shift 2 ;;
    --scenario) scenario="${2:-}"; shift 2 ;;
    --phase) phase="${2:-}"; shift 2 ;;
    --revision) revision="${2:-}"; shift 2 ;;
    --output-dir) output_dir="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$cluster" in
  laptop-aws-sim|laptop-gcp-sim|laptop-azure-sim) ;;
  *) fail "--cluster must name one of the three laptop clusters" ;;
esac
[[ -n "$context" ]] || fail "--context is required"
[[ -n "$scenario" ]] || fail "--scenario is required"
case "$phase" in
  before|fault|recovered|start|daily|complete) ;;
  *) fail "--phase must be before, fault, recovered, start, daily, or complete" ;;
esac
[[ "$revision" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--revision must be an exact 40-character Git commit SHA"
[[ -n "$output_dir" ]] || fail "--output-dir is required"

for command in node kubectl jq sha256sum install mktemp find sort stat awk grep date; do
  command -v "$command" >/dev/null || fail "$command is required"
done

scenario_json="$(
  node "$repo_root/tools/laptop-acceptance.mjs" \
    --assert-scenario "$scenario"
)"

if [[ "$scenario" == "seven-day-soak" ]]; then
  [[ "$phase" == "start" || "$phase" == "daily" || "$phase" == "complete" ]] \
    || fail "seven-day-soak accepts only start, daily, or complete phases"
else
  [[ "$phase" == "before" || "$phase" == "fault" || "$phase" == "recovered" ]] \
    || fail "$scenario accepts only before, fault, or recovered phases"
fi

mapfile -t matching_nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#matching_nodes[@]} -eq 1 ]] \
  || fail "context $context must expose exactly one node labeled for $cluster; found ${#matching_nodes[@]}"

observed_node="${matching_nodes[0]#node/}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
checkpoint_dir="$output_dir/$scenario/$phase/$cluster/$timestamp"
install -d -m 700 "$checkpoint_dir"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

capture_text() {
  local name="$1"
  shift
  "$@" >"$tmpdir/$name"
  install -m 600 "$tmpdir/$name" "$checkpoint_dir/$name"
}

# Filter to operational status. Deliberately exclude annotations, environment,
# command arguments, Secret/ConfigMap data, token hashes, and event messages.
kubectl --context "$context" get node "$observed_node" -o json \
  | jq -S '{
      apiVersion,
      kind,
      metadata: {
        name: .metadata.name,
        labels: (.metadata.labels | with_entries(select(.key | startswith("fiducia.cloud/") or . == "kubernetes.io/hostname")))
      },
      status: {
        conditions: [.status.conditions[]? | {type,status,reason,lastHeartbeatTime,lastTransitionTime}],
        capacity: .status.capacity,
        allocatable: .status.allocatable,
        nodeInfo: {
          architecture: .status.nodeInfo.architecture,
          operatingSystem: .status.nodeInfo.operatingSystem,
          kernelVersion: .status.nodeInfo.kernelVersion,
          containerRuntimeVersion: .status.nodeInfo.containerRuntimeVersion,
          kubeletVersion: .status.nodeInfo.kubeletVersion
        }
      }
    }' >"$tmpdir/node-status.json"
install -m 600 "$tmpdir/node-status.json" "$checkpoint_dir/node-status.json"

kubectl --context "$context" -n fiducia get pods -o json \
  | jq -S '{
      apiVersion,
      kind,
      items: [.items[] | {
        metadata: {name: .metadata.name, generation: .metadata.generation, labels: (.metadata.labels | with_entries(select((.key == "app") or (.key | startswith("fiducia.cloud/")))))},
        status: {
          phase: .status.phase,
          reason: .status.reason,
          startTime: .status.startTime,
          conditions: [.status.conditions[]? | {type,status,reason,lastTransitionTime}],
          containerStatuses: [.status.containerStatuses[]? | {name,ready,restartCount,state,lastState,imageID}]
        }
      }]
    }' >"$tmpdir/pod-status.json"
install -m 600 "$tmpdir/pod-status.json" "$checkpoint_dir/pod-status.json"

kubectl --context "$context" -n fiducia get deployments,statefulsets,daemonsets -o json \
  | jq -S '{
      apiVersion,
      kind,
      items: [.items[] | {
        apiVersion,
        kind,
        metadata: {name: .metadata.name, generation: .metadata.generation},
        desiredReplicas: (.spec.replicas // null),
        updateStrategy: (.spec.updateStrategy.type // .spec.strategy.type // null),
        status: .status
      }]
    }' >"$tmpdir/workload-status.json"
install -m 600 "$tmpdir/workload-status.json" "$checkpoint_dir/workload-status.json"

kubectl --context "$context" -n fiducia get persistentvolumeclaims -o json \
  | jq -S '{
      apiVersion,
      kind,
      items: [.items[] | {
        metadata: {name: .metadata.name},
        spec: {accessModes: .spec.accessModes, storageClassName: .spec.storageClassName, resources: {requests: .spec.resources.requests}},
        status: {phase: .status.phase, accessModes: .status.accessModes, capacity: .status.capacity}
      }]
    }' >"$tmpdir/pvc-status.json"
install -m 600 "$tmpdir/pvc-status.json" "$checkpoint_dir/pvc-status.json"

kubectl --context "$context" -n fiducia get services -o json \
  | jq -S '{
      apiVersion,
      kind,
      items: [.items[] | {
        metadata: {name: .metadata.name},
        spec: {type: .spec.type, loadBalancerClass: .spec.loadBalancerClass, ports: [.spec.ports[]? | {name,protocol,port,targetPort}]}
      }]
    }' >"$tmpdir/service-surface.json"
install -m 600 "$tmpdir/service-surface.json" "$checkpoint_dir/service-surface.json"

kubectl --context "$context" -n fiducia get networkpolicies.networking.k8s.io -o json \
  | jq -S '{
      apiVersion,
      kind,
      items: [.items[] | {
        metadata: {name: .metadata.name},
        policyTypes: .spec.policyTypes,
        ingressRuleCount: ((.spec.ingress // []) | length),
        egressRuleCount: ((.spec.egress // []) | length)
      }]
    }' >"$tmpdir/network-policy-summary.json"
install -m 600 "$tmpdir/network-policy-summary.json" "$checkpoint_dir/network-policy-summary.json"

if kubectl --context "$context" api-resources --api-group=argoproj.io -o name 2>/dev/null | grep -qx applications; then
  kubectl --context "$context" -n argocd get applications.argoproj.io -o json \
    | jq -S '{
        apiVersion,
        kind,
        items: [.items[] | {
          metadata: {name: .metadata.name, generation: .metadata.generation},
          source: {repoURL: .spec.source.repoURL, targetRevision: .spec.source.targetRevision, path: .spec.source.path},
          destination: {namespace: .spec.destination.namespace},
          status: {sync: .status.sync, health: .status.health, operationState: {phase: .status.operationState.phase, startedAt: .status.operationState.startedAt, finishedAt: .status.operationState.finishedAt}}
        }]
      }' >"$tmpdir/argocd-status.json"
else
  jq -n -S '{apiVersion:"v1",kind:"List",items:[]}' >"$tmpdir/argocd-status.json"
fi
install -m 600 "$tmpdir/argocd-status.json" "$checkpoint_dir/argocd-status.json"

if kubectl --context "$context" api-resources -o name 2>/dev/null | grep -qx etcdsnapshotfiles.k3s.cattle.io; then
  kubectl --context "$context" get etcdsnapshotfiles.k3s.cattle.io -o json \
    | jq -S '{
        apiVersion,
        kind,
        items: [.items[] | {
          metadata: {name: .metadata.name, labels: (.metadata.labels | with_entries(select(.key == "etcd.k3s.cattle.io/snapshot-storage-node")))},
          status: {creationTime: .status.creationTime, readyToUse: .status.readyToUse, size: .status.size}
        }]
      }' >"$tmpdir/etcd-snapshot-status.json"
else
  jq -n -S '{apiVersion:"v1",kind:"List",items:[]}' >"$tmpdir/etcd-snapshot-status.json"
fi
install -m 600 "$tmpdir/etcd-snapshot-status.json" "$checkpoint_dir/etcd-snapshot-status.json"

capture_text kubernetes-readyz.txt \
  kubectl --context "$context" get --raw='/readyz?verbose'

jq -n -S \
  --arg campaignId "den-946-laptop-acceptance-v1" \
  --arg cluster "$cluster" \
  --arg context "$context" \
  --arg scenario "$scenario" \
  --arg phase "$phase" \
  --arg revision "${revision,,}" \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg node "$observed_node" \
  --argjson scenarioPolicy "$scenario_json" \
  '{
    schemaVersion: 1,
    campaignId: $campaignId,
    cluster: $cluster,
    context: $context,
    scenario: $scenario,
    phase: $phase,
    revision: $revision,
    capturedAt: $capturedAt,
    node: $node,
    captureOnly: true,
    automatedFaultInjection: false,
    scenarioPolicy: $scenarioPolicy
  }' >"$tmpdir/checkpoint.json"
install -m 600 "$tmpdir/checkpoint.json" "$checkpoint_dir/checkpoint.json"

artifacts_json="$tmpdir/artifacts.json"
: >"$tmpdir/artifacts.tsv"
while IFS= read -r -d '' file; do
  name="$(basename "$file")"
  hash="$(sha256sum "$file" | awk '{print $1}')"
  size="$(stat -c '%s' "$file")"
  printf '%s\t%s\t%s\n' "$name" "$hash" "$size" >>"$tmpdir/artifacts.tsv"
done < <(find "$checkpoint_dir" -maxdepth 1 -type f -print0 | sort -z)

jq -Rn -S '
  [inputs | split("\t") | {
    name: .[0],
    sha256: .[1],
    sizeBytes: (.[2] | tonumber)
  }]
' <"$tmpdir/artifacts.tsv" >"$artifacts_json"

jq -n -S \
  --arg campaignId "den-946-laptop-acceptance-v1" \
  --arg cluster "$cluster" \
  --arg scenario "$scenario" \
  --arg phase "$phase" \
  --arg revision "${revision,,}" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg checkpointDirectory "$checkpoint_dir" \
  --slurpfile artifacts "$artifacts_json" \
  '{
    schemaVersion: 1,
    campaignId: $campaignId,
    cluster: $cluster,
    scenario: $scenario,
    phase: $phase,
    revision: $revision,
    generatedAt: $generatedAt,
    checkpointDirectory: $checkpointDirectory,
    captureOnly: true,
    artifacts: $artifacts[0]
  }' >"$tmpdir/artifact-manifest.json"
install -m 600 "$tmpdir/artifact-manifest.json" "$checkpoint_dir/artifact-manifest.json"

echo "captured $scenario/$phase for $cluster at $checkpoint_dir"
echo "no fault or recovery action was executed; follow the reviewed manual scenario procedure"
