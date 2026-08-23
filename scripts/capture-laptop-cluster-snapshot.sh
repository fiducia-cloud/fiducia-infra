#!/usr/bin/env bash
# Capture a bounded, redacted Kubernetes status packet for one laptop cluster.
# The packet excludes Secrets, ConfigMaps, logs, events, environment variables,
# IP addresses, image pull credentials, and workload specifications.
set -euo pipefail
umask 077

cluster=""
context=""
revision=""
output=""

usage() {
  cat <<'EOF'
usage:
  scripts/capture-laptop-cluster-snapshot.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --revision <40-character-git-sha> \
    --output /secure/evidence/laptop-aws-sim-before.json
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --context) context="${2:-}"; shift 2 ;;
    --revision) revision="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$cluster" in
  laptop-aws-sim|laptop-gcp-sim|laptop-azure-sim) ;;
  *) fail "--cluster must name one of the three laptop clusters" ;;
esac
[[ -n "$context" ]] || fail "--context is required"
[[ "$revision" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--revision must be an exact 40-character Git SHA"
[[ -n "$output" && "$output" = /* ]] || fail "--output must be an absolute path"

for command in date jq kubectl sha256sum; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

mapfile -t matching_nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
    -o name
)
[[ ${#matching_nodes[@]} -eq 1 ]] \
  || fail "context $context must expose exactly one node labeled for $cluster; found ${#matching_nodes[@]}"

mkdir -p "$(dirname "$output")"
[[ ! -L "$output" ]] || fail "refusing to overwrite a symlink: $output"
temporary="$(mktemp "${output}.tmp.XXXXXX")"
work="$(mktemp -d)"
trap 'rm -f "$temporary"; rm -rf "$work"' EXIT

kubectl --context "$context" get nodes \
  -l "fiducia.cloud/cluster=$cluster,fiducia.cloud/substrate=laptop-k3s" \
  -o json >"$work/nodes.json"
kubectl --context "$context" -n fiducia get deployments,statefulsets -o json >"$work/workloads.json"
kubectl --context "$context" -n fiducia get pods -o json >"$work/pods.json"
kubectl --context "$context" -n fiducia get persistentvolumeclaims -o json >"$work/pvcs.json"
kubectl --context "$context" -n fiducia get services -o json >"$work/services.json"
kubectl --context "$context" -n fiducia get networkpolicies -o json >"$work/networkpolicies.json"

jq -n \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg clusterName "$cluster" \
  --arg context "$context" \
  --arg revision "${revision,,}" \
  --slurpfile nodes "$work/nodes.json" \
  --slurpfile workloads "$work/workloads.json" \
  --slurpfile pods "$work/pods.json" \
  --slurpfile pvcs "$work/pvcs.json" \
  --slurpfile services "$work/services.json" \
  --slurpfile networkpolicies "$work/networkpolicies.json" \
  '{
    schemaVersion: 1,
    evidenceMode: "live-local-capture",
    capturedAt: $capturedAt,
    clusterName: $clusterName,
    kubeContext: $context,
    pinnedRevision: $revision,
    nodes: [
      $nodes[0].items[] | {
        name: .metadata.name,
        labels: {
          cluster: .metadata.labels["fiducia.cloud/cluster"],
          substrate: .metadata.labels["fiducia.cloud/substrate"],
          syntheticProvider: .metadata.labels["fiducia.cloud/synthetic-provider"],
          site: .metadata.labels["fiducia.cloud/site"]
        },
        ready: (([.status.conditions[]? | select(.type == "Ready") | .status] | first) // "Unknown"),
        capacity: {
          cpu: .status.capacity.cpu,
          memory: .status.capacity.memory,
          ephemeralStorage: .status.capacity["ephemeral-storage"]
        },
        allocatable: {
          cpu: .status.allocatable.cpu,
          memory: .status.allocatable.memory,
          ephemeralStorage: .status.allocatable["ephemeral-storage"]
        }
      }
    ],
    workloads: [
      $workloads[0].items[] | {
        kind: .kind,
        name: .metadata.name,
        desiredReplicas: (.spec.replicas // 0),
        readyReplicas: (.status.readyReplicas // 0),
        currentReplicas: (.status.currentReplicas // 0),
        updatedReplicas: (.status.updatedReplicas // 0),
        availableReplicas: (.status.availableReplicas // 0),
        observedGeneration: (.status.observedGeneration // 0),
        generation: (.metadata.generation // 0)
      }
    ] | sort_by(.kind, .name),
    pods: [
      $pods[0].items[] | {
        name: .metadata.name,
        app: (.metadata.labels.app // null),
        phase: .status.phase,
        ready: (([.status.conditions[]? | select(.type == "Ready") | .status] | first) // "Unknown"),
        restartCount: ([.status.containerStatuses[]?.restartCount] | add // 0),
        containerReady: ([.status.containerStatuses[]?.ready] | all),
        deletionPending: (.metadata.deletionTimestamp != null)
      }
    ] | sort_by(.app, .name),
    persistentVolumeClaims: [
      $pvcs[0].items[] | {
        name: .metadata.name,
        phase: .status.phase,
        storageClass: .spec.storageClassName,
        requestedStorage: .spec.resources.requests.storage,
        capacity: (.status.capacity.storage // null),
        accessModes: (.status.accessModes // [])
      }
    ] | sort_by(.name),
    services: [
      $services[0].items[] | {
        name: .metadata.name,
        type: .spec.type,
        ports: [.spec.ports[]? | {
          name: .name,
          protocol: .protocol,
          port: .port,
          targetPort: .targetPort
        }]
      }
    ] | sort_by(.name),
    networkPolicies: [
      $networkpolicies[0].items[] | {
        name: .metadata.name,
        policyTypes: .spec.policyTypes,
        selectedApp: (.spec.podSelector.matchLabels.app // null)
      }
    ] | sort_by(.name),
    redaction: {
      secrets: "excluded",
      configMaps: "excluded",
      logs: "excluded",
      events: "excluded",
      environmentVariables: "excluded",
      podAndServiceIpAddresses: "excluded",
      nodeAddresses: "excluded",
      imagePullCredentials: "excluded",
      workloadSpecifications: "status-only"
    }
  }' >"$temporary"

chmod 600 "$temporary"
mv -f "$temporary" "$output"
trap - EXIT
rm -rf "$work"

fingerprint="$(sha256sum "$output" | awk '{print $1}')"
printf 'wrote redacted cluster snapshot: %s\n' "$output"
printf 'snapshot sha256: %s\n' "$fingerprint"
