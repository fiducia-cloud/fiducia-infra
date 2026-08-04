#!/usr/bin/env bash
# Capture a redacted storage/status fragment for DEN-437. This script reads no
# Secret or ConfigMap values and performs no snapshot, rollout, delete, patch,
# scale, restore, or member-replacement action.
set -euo pipefail
umask 077

cluster=""
context=""
revision=""
output=""

usage() {
  cat <<'EOF'
usage:
  scripts/capture-fiducia-raft-storage-evidence.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --revision <40-character-git-sha> \
    --output /secure/evidence/laptop-aws-sim-raft-storage.json

The output is a capture-only fragment. It cannot satisfy backup, restore,
key-custody, member-replacement, or production-approval gates by itself.
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
  laptop-aws-sim|laptop-gcp-sim|laptop-azure-sim|hetzner|vultr|civo) ;;
  *) fail "--cluster must name an approved Fiducia cluster" ;;
esac
[[ -n "$context" ]] || fail "--context is required"
[[ "$revision" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--revision must be an exact 40-character Git SHA"
[[ "$output" = /* ]] || fail "--output must be an absolute path"

for command in kubectl jq sha256sum install mktemp date sort awk grep chmod rm; do
  command -v "$command" >/dev/null || fail "$command is required"
done

mapfile -t matching_nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster" \
    -o name
)
[[ ${#matching_nodes[@]} -ge 1 ]] \
  || fail "context $context has no node labeled fiducia.cloud/cluster=$cluster"

for statefulset in fiducia-node fiducia-brain; do
  kubectl --context "$context" -n fiducia get statefulset "$statefulset" >/dev/null \
    || fail "StatefulSet/$statefulset is missing in $context"
done

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

kubectl --context "$context" -n fiducia get statefulsets fiducia-node fiducia-brain -o json \
  | jq -S '{
      apiVersion,
      kind,
      items: [.items[] | {
        metadata: {
          name: .metadata.name,
          generation: .metadata.generation,
          labels: (.metadata.labels // {} | with_entries(select((.key | startswith("fiducia.cloud/")) or (.key == "app"))))
        },
        spec: {
          serviceName: .spec.serviceName,
          replicas: .spec.replicas,
          podManagementPolicy: .spec.podManagementPolicy,
          updateStrategy: .spec.updateStrategy.type,
          persistentVolumeClaimRetentionPolicy: .spec.persistentVolumeClaimRetentionPolicy,
          volumeClaimTemplates: [.spec.volumeClaimTemplates[]? | {
            name: .metadata.name,
            labels: (.metadata.labels // {} | with_entries(select((.key | startswith("fiducia.cloud/")) or (.key == "app")))),
            accessModes: .spec.accessModes,
            volumeMode: (.spec.volumeMode // "Filesystem"),
            storageClassName: .spec.storageClassName,
            requestedStorage: .spec.resources.requests.storage
          }],
          containers: [.spec.template.spec.containers[] | {
            name,
            image,
            imagePullPolicy,
            dataDirectory: ([.env[]? | select(.name == "FIDUCIA_DATA_DIR") | .value] | first // null),
            volumeMounts: [.volumeMounts[]? | {name,mountPath,readOnly:(.readOnly // false)}]
          }],
          volumes: [.spec.template.spec.volumes[]? | {
            name,
            source: (
              if has("emptyDir") then "emptyDir"
              elif has("persistentVolumeClaim") then "persistentVolumeClaim"
              elif has("secret") then "secret"
              elif has("configMap") then "configMap"
              elif has("projected") then "projected"
              else "other"
              end
            )
          }]
        },
        status: {
          currentRevision: .status.currentRevision,
          updateRevision: .status.updateRevision,
          currentReplicas: (.status.currentReplicas // 0),
          readyReplicas: (.status.readyReplicas // 0),
          availableReplicas: (.status.availableReplicas // 0)
        }
      }]
    }' >"$tmpdir/statefulsets.json"

kubectl --context "$context" -n fiducia get persistentvolumeclaims -o json \
  | jq -S '{
      apiVersion,
      kind,
      items: [.items[]
        | select(.metadata.name | test("^data-fiducia-(node|brain)-"))
        | {
            metadata: {name: .metadata.name},
            spec: {
              accessModes: .spec.accessModes,
              volumeMode: (.spec.volumeMode // "Filesystem"),
              storageClassName: .spec.storageClassName,
              requestedStorage: .spec.resources.requests.storage
            },
            status: {
              phase: .status.phase,
              accessModes: .status.accessModes,
              capacity: .status.capacity
            }
          }
      ]
    }' >"$tmpdir/pvcs.json"

mapfile -t storage_classes < <(
  jq -r '.items[].spec.storageClassName // empty' "$tmpdir/pvcs.json" | sort -u
)
if ((${#storage_classes[@]})); then
  kubectl --context "$context" get storageclass "${storage_classes[@]}" -o json \
    | jq -S '{
        apiVersion,
        kind,
        items: [.items[] | {
          metadata: {name: .metadata.name},
          provisioner: .provisioner,
          reclaimPolicy: (.reclaimPolicy // "Delete"),
          volumeBindingMode: (.volumeBindingMode // "Immediate"),
          allowVolumeExpansion: (.allowVolumeExpansion // false),
          mountOptions: (.mountOptions // [])
        }]
      }' >"$tmpdir/storageclasses.json"
else
  jq -n -S '{apiVersion:"storage.k8s.io/v1",kind:"List",items:[]}' >"$tmpdir/storageclasses.json"
fi

kubectl --context "$context" -n fiducia get pods -l 'app in (fiducia-node,fiducia-brain)' -o json \
  | jq -S '{
      apiVersion,
      kind,
      items: [.items[] | {
        metadata: {name: .metadata.name},
        status: {
          phase: .status.phase,
          conditions: [.status.conditions[]? | {type,status,reason,lastTransitionTime}],
          containerStatuses: [.status.containerStatuses[]? | {name,ready,restartCount,imageID}]
        }
      }]
    }' >"$tmpdir/pods.json"

statefulset_hash="$(sha256sum "$tmpdir/statefulsets.json" | awk '{print $1}')"
pvc_hash="$(sha256sum "$tmpdir/pvcs.json" | awk '{print $1}')"
storageclass_hash="$(sha256sum "$tmpdir/storageclasses.json" | awk '{print $1}')"
pod_hash="$(sha256sum "$tmpdir/pods.json" | awk '{print $1}')"

install -d -m 700 "$(dirname "$output")"
temporary="$(mktemp "${output}.tmp.XXXXXX")"
trap 'rm -rf "$tmpdir"; rm -f "$temporary"' EXIT

jq -n -S \
  --arg cluster "$cluster" \
  --arg context "$context" \
  --arg revision "${revision,,}" \
  --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --slurpfile statefulsets "$tmpdir/statefulsets.json" \
  --slurpfile pvcs "$tmpdir/pvcs.json" \
  --slurpfile storageClasses "$tmpdir/storageclasses.json" \
  --slurpfile pods "$tmpdir/pods.json" \
  --arg statefulsetSha256 "$statefulset_hash" \
  --arg pvcSha256 "$pvc_hash" \
  --arg storageClassSha256 "$storageclass_hash" \
  --arg podSha256 "$pod_hash" \
  '{
    schemaVersion: 1,
    evidenceMode: "live-capture-fragment",
    captureOnly: true,
    productionApproval: false,
    cluster: $cluster,
    context: $context,
    gitRevision: $revision,
    observedAt: $observedAt,
    statefulSets: $statefulsets[0],
    persistentVolumeClaims: $pvcs[0],
    storageClasses: $storageClasses[0],
    pods: $pods[0],
    artifactFingerprints: {
      statefulSetsSha256: $statefulsetSha256,
      persistentVolumeClaimsSha256: $pvcSha256,
      storageClassesSha256: $storageClassSha256,
      podsSha256: $podSha256
    },
    redaction: {
      secretValues: "not-read",
      configMapValues: "not-read",
      persistentVolumeIdentifiers: "not-emitted",
      nodeNamesAndAddresses: "not-emitted",
      workloadEnvironment: "only-FIDUCIA_DATA_DIR-retained"
    },
    missingGates: [
      "application-consistent-snapshot",
      "independent-encrypted-backup",
      "key-custody",
      "single-member-loss",
      "single-member-replacement",
      "interrupted-migration-rollback",
      "clean-room-restore",
      "revision-and-cas-semantics",
      "operator-and-reviewer-approval"
    ]
  }' >"$temporary"

chmod 600 "$temporary"
mv -f "$temporary" "$output"
trap 'rm -rf "$tmpdir"' EXIT
printf 'wrote redacted Raft storage capture fragment: %s\n' "$output"
