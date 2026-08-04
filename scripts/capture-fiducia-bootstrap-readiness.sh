#!/usr/bin/env bash
# Capture value-free bootstrap readiness for one cluster. This script reads
# ExternalSecret/ClusterSecretStore metadata and Kubernetes Secret KEY NAMES only.
# It never requests Secret values, cloud object values, bearer material, or
# workload environment variables.
set -euo pipefail
umask 077

cluster=""
context=""
output=""

usage() {
  cat <<'EOF'
usage:
  scripts/capture-fiducia-bootstrap-readiness.sh \
    --cluster laptop-aws-sim \
    --context fiducia-laptop-aws-sim \
    --output /secure/evidence/laptop-aws-sim-bootstrap-readiness.json

The output is a cluster fragment. Cloud-object existence/property checks,
rotation ownership, value-shape validation, and independent approval remain
separate protected-operator evidence.
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
[[ "$output" = /* ]] || fail "--output must be an absolute path"

for command in kubectl jq sha256sum install mktemp date sort awk chmod rm; do
  command -v "$command" >/dev/null || fail "$command is required"
done

mapfile -t matching_nodes < <(
  kubectl --context "$context" get nodes \
    -l "fiducia.cloud/cluster=$cluster" \
    -o name
)
[[ ${#matching_nodes[@]} -ge 1 ]] \
  || fail "context $context has no node labelled fiducia.cloud/cluster=$cluster"

kubectl --context "$context" get namespace external-secrets >/dev/null
kubectl --context "$context" get namespace fiducia >/dev/null

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

kubectl --context "$context" get clustersecretstores.external-secrets.io \
  dd-cluster-secrets dd-fiducia-kv -o json \
  | jq -S '{
      apiVersion,
      kind,
      items: [.items[] | {
        metadata: {name: .metadata.name, generation: .metadata.generation},
        status: {
          conditions: [.status.conditions[]? | {type,status,reason,lastTransitionTime}],
          capabilities: (.status.capabilities // null)
        }
      }]
    }' >"$tmpdir/stores.json"

kubectl --context "$context" -n external-secrets get externalsecrets.external-secrets.io \
  fiducia-eso-reader -o json >"$tmpdir/externalsecrets-reader.raw.json"
kubectl --context "$context" -n fiducia get externalsecrets.external-secrets.io \
  fiducia-kv-protection \
  fiducia-cluster-secrets \
  fiducia-auth-secrets \
  fiducia-backend-secrets \
  fiducia-admin-secrets \
  -o json >"$tmpdir/externalsecrets-fiducia.raw.json"

jq -s -S '{
  apiVersion: "external-secrets.io/v1",
  kind: "List",
  items: ([.[0].items[], .[1].items[]] | map({
    metadata: {name: .metadata.name, namespace: .metadata.namespace, generation: .metadata.generation},
    spec: {
      refreshInterval: .spec.refreshInterval,
      secretStoreRef: .spec.secretStoreRef,
      target: {
        name: .spec.target.name,
        creationPolicy: .spec.target.creationPolicy,
        deletionPolicy: .spec.target.deletionPolicy
      },
      keyContract: [.spec.data[]? | {
        secretKey,
        remoteKey: .remoteRef.key,
        property: .remoteRef.property
      }]
    },
    status: {
      conditions: [.status.conditions[]? | {type,status,reason,lastTransitionTime}],
      refreshTime: .status.refreshTime,
      syncedResourceVersion: .status.syncedResourceVersion
    }
  }))
}' "$tmpdir/externalsecrets-reader.raw.json" "$tmpdir/externalsecrets-fiducia.raw.json" \
  >"$tmpdir/externalsecrets.json"
rm -f "$tmpdir/externalsecrets-reader.raw.json" "$tmpdir/externalsecrets-fiducia.raw.json"

secret_keys_json() {
  local namespace="$1"
  local name="$2"
  kubectl --context "$context" -n "$namespace" get secret "$name" \
    -o go-template='{{range $key, $_ := .data}}{{$key}}{{"\n"}}{{end}}' \
    | sort \
    | jq -Rsc 'split("\n") | map(select(length > 0))'
}

jq -n -S \
  --argjson esoReader "$(secret_keys_json external-secrets fiducia-eso-reader)" \
  --argjson kvProtection "$(secret_keys_json fiducia fiducia-kv-protection)" \
  --argjson clusterSecrets "$(secret_keys_json fiducia fiducia-cluster-secrets)" \
  --argjson authSecrets "$(secret_keys_json fiducia fiducia-auth-secrets)" \
  --argjson backendSecrets "$(secret_keys_json fiducia fiducia-backend-secrets)" \
  --argjson adminSecrets "$(secret_keys_json fiducia fiducia-admin-secrets)" \
  '{
    "external-secrets/fiducia-eso-reader": $esoReader,
    "fiducia/fiducia-kv-protection": $kvProtection,
    "fiducia/fiducia-cluster-secrets": $clusterSecrets,
    "fiducia/fiducia-auth-secrets": $authSecrets,
    "fiducia/fiducia-backend-secrets": $backendSecrets,
    "fiducia/fiducia-admin-secrets": $adminSecrets
  }' >"$tmpdir/secret-key-names.json"

stores_sha="$(sha256sum "$tmpdir/stores.json" | awk '{print $1}')"
external_secrets_sha="$(sha256sum "$tmpdir/externalsecrets.json" | awk '{print $1}')"
secret_keys_sha="$(sha256sum "$tmpdir/secret-key-names.json" | awk '{print $1}')"

jq -n -S \
  --arg cluster "$cluster" \
  --arg context "$context" \
  --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --slurpfile stores "$tmpdir/stores.json" \
  --slurpfile externalSecrets "$tmpdir/externalsecrets.json" \
  --slurpfile secretKeyNames "$tmpdir/secret-key-names.json" \
  --arg storesSha "$stores_sha" \
  --arg externalSecretsSha "$external_secrets_sha" \
  --arg secretKeysSha "$secret_keys_sha" \
  '{
    schemaVersion: 1,
    evidenceMode: "live-cluster-capture-fragment",
    captureOnly: true,
    productionApproval: false,
    cluster: $cluster,
    context: $context,
    observedAt: $observedAt,
    stores: $stores[0],
    externalSecrets: $externalSecrets[0],
    materializedSecretKeyNames: $secretKeyNames[0],
    proofIds: {
      stores: ("cluster-metadata-sha256:" + $storesSha),
      externalSecrets: ("cluster-metadata-sha256:" + $externalSecretsSha),
      secretKeyNames: ("cluster-metadata-sha256:" + $secretKeysSha)
    },
    redaction: {
      secretValues: "not-read",
      cloudObjectValues: "not-read",
      bearerMaterial: "not-read",
      workloadEnvironment: "not-read",
      secretKeyNamesOnly: true
    },
    missingGates: [
      "cloud-object-existence-and-property-proof",
      "dedicated-organization-and-kv-read-scope-proof",
      "minimum-byte-length-and-whitespace-proof",
      "historical-encryption-key-retention-proof",
      "rotation-owner-and-emergency-recovery-owner",
      "independent-trust-domain-proof",
      "operator-and-reviewer-approval"
    ]
  }' >"$tmpdir/output.json"

install -d -m 700 "$(dirname "$output")"
install -m 600 "$tmpdir/output.json" "$output"
printf 'wrote value-free Fiducia bootstrap readiness fragment: %s\n' "$output"
