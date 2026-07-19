#!/usr/bin/env bash
set -euo pipefail

# Digest-pinned Fiducia workload lifecycle inside the three logical vClusters.
# Run the foreground tunnel script first; this script never reaches a public API.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
E2E_ROOT=${FIDUCIA_E2E_REPO:-"$(dirname "$REPO_ROOT")/fiducia-e2e"}
STATE_DIR=${FIDUCIA_HETZNER_E2E_STATE_DIR:-"$HOME/.local/state/fiducia/hetzner-e2e"}
KUBECONFIG_DIR="$STATE_DIR/kubeconfigs"
CLUSTERS=(hetzner-fsn1 hetzner-nbg1 hetzner-hel1)

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'usage: scripts/hetzner-e2e-vcluster-deploy.sh preflight' \
    '       scripts/hetzner-e2e-vcluster-deploy.sh render <release-id>' \
    '       scripts/hetzner-e2e-vcluster-deploy.sh apply <release-id>' \
    '       scripts/hetzner-e2e-vcluster-deploy.sh verify <release-id>' \
    '       scripts/hetzner-e2e-vcluster-deploy.sh evidence <release-id>' \
    '       scripts/hetzner-e2e-vcluster-deploy.sh proof <release-id>'
}

command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
command -v node >/dev/null 2>&1 || fail "Node.js is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
command -v git >/dev/null 2>&1 || fail "git is required"
case "$STATE_DIR" in /*) ;; *) fail "state directory must be absolute" ;; esac
case "$STATE_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state must stay outside the repository" ;; esac
mkdir -p "$STATE_DIR/releases" "$STATE_DIR/evidence"
chmod 700 "$STATE_DIR" "$STATE_DIR/releases" "$STATE_DIR/evidence"
STATE_DIR=$(cd "$STATE_DIR" && pwd -P)
case "$STATE_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state must stay outside the repository" ;; esac
umask 077

kubeconfig_for() { printf '%s/%s.kubeconfig' "$KUBECONFIG_DIR" "$1"; }
region_for() { case "$1" in hetzner-fsn1) printf fsn1;; hetzner-nbg1) printf nbg1;; hetzner-hel1) printf hel1;; esac; }
node_port_for() { case "$1" in hetzner-fsn1) printf 18003;; hetzner-nbg1) printf 18004;; hetzner-hel1) printf 18005;; esac; }
lb_port_for() { case "$1" in hetzner-fsn1) printf 18103;; hetzner-nbg1) printf 18104;; hetzner-hel1) printf 18105;; esac; }

release_directory() {
  local release_id=${1:-}
  test -n "$release_id" || fail "release-id is required"
  [[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail "release-id has unsafe characters"
  printf '%s/releases/%s' "$STATE_DIR" "$release_id"
}

preflight() {
  local cluster kubeconfig context uid nodes uids='' physical_nodes=''
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig=$(kubeconfig_for "$cluster")
    test -f "$kubeconfig" || fail "missing kubeconfig: $kubeconfig"
    context=$(kubectl --kubeconfig="$kubeconfig" config current-context)
    test "$context" = "fiducia-e2e-$cluster" || fail "$cluster has unexpected context $context"
    uid=$(kubectl --kubeconfig="$kubeconfig" get namespace kube-system -o jsonpath='{.metadata.uid}')
    test -n "$uid" || fail "$cluster has no Kubernetes UID"
    nodes=$(kubectl --kubeconfig="$kubeconfig" get nodes -o json)
    jq -e '(.items | length) == 1 and any(.items[0].status.conditions[]?; .type == "Ready" and .status == "True")' \
      <<<"$nodes" >/dev/null || fail "$cluster must expose exactly one Ready host node"
    kubectl --kubeconfig="$kubeconfig" get storageclass local-path >/dev/null 2>&1 ||
      fail "$cluster does not expose local-path storage"
    uids="$uids$uid"$'\n'
    physical_nodes="$physical_nodes$(jq -r '.items[0].metadata.name' <<<"$nodes")"$'\n'
    printf '%s uid=%s node=%s\n' "$cluster" "$uid" "$(jq -r '.items[0].metadata.name' <<<"$nodes")"
  done
  test "$(printf '%s' "$uids" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')" -eq 3 ||
    fail "proof requires exactly three distinct virtual Kubernetes UIDs"
  test "$(printf '%s' "$physical_nodes" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')" -eq 3 ||
    fail "logical clusters must be pinned to three distinct host Nodes"
}

validate_release() {
  local release_dir=$1 metadata cluster manifest expected actual source_sha
  metadata="$release_dir/evidence/release.json"
  test -f "$metadata" || fail "missing release metadata"
  jq -e '
    .schema_version == 1 and .profile == "vcluster" and
    .topology == "three-logically-isolated-vclusters-on-existing-hetzner-kubeadm" and
    .source.repository == "fiducia-infra" and .source.clean == true and
    (.source.commit | test("^[0-9a-f]{40}$")) and
    .clusters == ["hetzner-fsn1","hetzner-nbg1","hetzner-hel1"] and
    ([.images[] | test("^ghcr\\.io/fiducia-cloud/.+@sha256:[0-9a-f]{64}$")] | all)
  ' "$metadata" >/dev/null || fail "invalid vCluster release metadata"
  source_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)
  test "$source_sha" = "$(jq -er .source.commit "$metadata")" || fail "release belongs to a different fiducia-infra commit"
  test -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ||
    fail "release use requires clean committed fiducia-infra source"
  for cluster in "${CLUSTERS[@]}"; do
    manifest="$release_dir/manifests/$cluster.yaml"
    test -f "$manifest" || fail "missing manifest $manifest"
    expected=$(jq -er --arg cluster "$cluster" '.manifests[$cluster] | sub("^sha256:"; "")' "$metadata")
    actual=$(openssl dgst -sha256 "$manifest" | awk '{print $NF}')
    test "$actual" = "$expected" || fail "$cluster manifest digest mismatch"
    rg -q '^kind: Secret$' "$manifest" && fail "$cluster release embeds a Secret"
    test "$(grep -c '^[[:space:]]*- name: fiducia-ghcr-pull$' "$manifest")" -eq 3 ||
      fail "$cluster release must wire the private GHCR pull Secret to all three workloads"
    rg -n '^\s*type:\s*(NodePort|LoadBalancer)\s*$' "$manifest" >/dev/null &&
      fail "$cluster release exposes a forbidden Service type"
  done
  return 0
}

render_release() {
  local release_id=$1 release_dir
  release_dir=$(release_directory "$release_id")
  test ! -e "$release_dir" || fail "release is immutable and already exists: $release_dir"
  for variable in FIDUCIA_NODE_IMAGE FIDUCIA_NODE_SIDECAR_IMAGE FIDUCIA_BRAIN_IMAGE FIDUCIA_LOAD_BALANCE_IMAGE; do
    test -n "${!variable:-}" || fail "$variable is required"
  done
  node "$REPO_ROOT/tools/render-hetzner-e2e-release.mjs" \
    --profile vcluster --output "$release_dir" \
    --image "node=$FIDUCIA_NODE_IMAGE" \
    --image "sidecar=$FIDUCIA_NODE_SIDECAR_IMAGE" \
    --image "brain=$FIDUCIA_BRAIN_IMAGE" \
    --image "load_balance=$FIDUCIA_LOAD_BALANCE_IMAGE"
  validate_release "$release_dir"
}

apply_release() {
  local release_id=$1 release_dir cluster kubeconfig
  release_dir=$(release_directory "$release_id")
  validate_release "$release_dir"
  preflight
  test "${FIDUCIA_CONFIRM_DEPLOY:-}" = "deploy-to-three-logical-vclusters" ||
    fail "set FIDUCIA_CONFIRM_DEPLOY=deploy-to-three-logical-vclusters after review"
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig=$(kubeconfig_for "$cluster")
    kubectl --kubeconfig="$kubeconfig" -n fiducia get secret fiducia-secrets -o json |
      jq -e '.data["internal-secret"] and .data["brain-raft-secret"]' >/dev/null ||
      fail "$cluster is missing runtime secrets"
    kubectl --kubeconfig="$kubeconfig" -n fiducia get secret fiducia-ghcr-pull -o json |
      jq -e '.type == "kubernetes.io/dockerconfigjson" and .data[".dockerconfigjson"]' >/dev/null ||
      fail "$cluster is missing the private GHCR pull Secret"
  done
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig=$(kubeconfig_for "$cluster")
    kubectl --kubeconfig="$kubeconfig" apply -f "$release_dir/manifests/$cluster.yaml"
  done
}

check_image() {
  local kubeconfig=$1 metadata=$2 kind=$3 resource=$4 container=$5 key=$6 expected actual
  expected=$(jq -er --arg key "$key" '.images[$key]' "$metadata")
  actual=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get "$kind" "$resource" -o json |
    jq -er --arg container "$container" '.spec.template.spec.containers[] | select(.name == $container) | .image')
  test "$actual" = "$expected" || fail "$resource/$container image differs from the release"
}

verify_release() {
  local release_id=$1 release_dir metadata cluster kubeconfig config pods expected_services service
  release_dir=$(release_directory "$release_id")
  metadata="$release_dir/evidence/release.json"
  validate_release "$release_dir"
  preflight
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig=$(kubeconfig_for "$cluster")
    kubectl --kubeconfig="$kubeconfig" -n fiducia rollout status statefulset/fiducia-node --timeout=5m
    kubectl --kubeconfig="$kubeconfig" -n fiducia rollout status statefulset/fiducia-brain --timeout=5m
    kubectl --kubeconfig="$kubeconfig" -n fiducia rollout status deployment/fiducia-load-balance --timeout=5m
    config=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get configmap fiducia-cluster -o json)
    jq -e --arg cluster "$cluster" --arg self "${cluster#hetzner-}" '
      .data.FIDUCIA_CLUSTER == $cluster and
      .data.FIDUCIA_CLUSTER_ID == "fiducia-e2e-hetzner-vcluster" and
      .data.FIDUCIA_REPLICATION_FACTOR == "3" and
      .data.FIDUCIA_TARGET_NODES == "3" and
      .data.FIDUCIA_AUTH_REQUIRED == "true" and
      (.data.FIDUCIA_PEERS | split(",") | length) == 2 and
      (.data.FIDUCIA_BRAIN_PEERS | split(",") | length) == 2 and
      (.data.FIDUCIA_PEERS | contains($self) | not) and
      (.data.FIDUCIA_BRAIN_PEERS | contains($self) | not)
    ' <<<"$config" >/dev/null || fail "$cluster has stale or self-referential topology"
    expected_services='[]'
    for service in fiducia-node-peer-fsn1 fiducia-brain-peer-fsn1 fiducia-node-peer-nbg1 fiducia-brain-peer-nbg1 fiducia-node-peer-hel1 fiducia-brain-peer-hel1; do
      case "$service" in *"${cluster#hetzner-}"*) continue;; esac
      expected_services=$(jq -cn --argjson values "$expected_services" --arg service "$service" '$values + [$service]')
    done
    actual_services=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get services -o json |
      jq -c '[.items[].metadata.name]')
    jq -ne --argjson expected "$expected_services" --argjson actual "$actual_services" '$expected - $actual | length == 0' >/dev/null ||
      fail "$cluster is missing replicated peer Services"
    check_image "$kubeconfig" "$metadata" statefulset fiducia-node node node
    check_image "$kubeconfig" "$metadata" statefulset fiducia-node sidecar sidecar
    check_image "$kubeconfig" "$metadata" statefulset fiducia-brain brain brain
    check_image "$kubeconfig" "$metadata" statefulset fiducia-brain sidecar sidecar
    check_image "$kubeconfig" "$metadata" deployment fiducia-load-balance lb load_balance
    pods=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get pods -l 'app in (fiducia-node,fiducia-brain,fiducia-load-balance)' -o json)
    jq -e '(.items | length) >= 4 and all(.items[]; all(.status.containerStatuses[]?; .ready and .imageID != ""))' \
      <<<"$pods" >/dev/null || fail "$cluster has unready workloads"
    printf 'verified %s\n' "$cluster"
  done
}

write_evidence() {
  local release_id=$1 release_dir stamp evidence_dir cluster kubeconfig uid nodes pods config item
  local source_sha release_json infra_sha topology_sha clusters_json='[]' topology_clusters='[]'
  release_dir=$(release_directory "$release_id")
  verify_release "$release_id"
  test -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ||
    fail "evidence requires clean committed fiducia-infra source"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  evidence_dir="$STATE_DIR/evidence/$release_id-$stamp"
  mkdir -p "$evidence_dir"
  chmod 700 "$evidence_dir"
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig=$(kubeconfig_for "$cluster")
    uid=$(kubectl --kubeconfig="$kubeconfig" get namespace kube-system -o jsonpath='{.metadata.uid}')
    nodes=$(kubectl --kubeconfig="$kubeconfig" get nodes -o json)
    pods=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get pods -o json)
    config=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get configmap fiducia-cluster -o json)
    item=$(jq -cn --arg cluster "$cluster" --arg uid "$uid" --argjson nodes "$nodes" --argjson pods "$pods" --argjson config "$config" '
      {
        cluster: $cluster,
        kubernetes_cluster_uid: $uid,
        visible_nodes: [$nodes.items[] | {name: .metadata.name, uid: .metadata.uid, providerID: .spec.providerID, labels: {region: .metadata.labels["topology.kubernetes.io/region"], zone: .metadata.labels["topology.kubernetes.io/zone"]}}],
        workload_placement: [$pods.items[] | {name: .metadata.name, nodeName: .spec.nodeName, images: [.status.containerStatuses[]? | {name, image, imageID, ready}]}],
        topology: $config.data
      }')
    clusters_json=$(jq -cn --argjson values "$clusters_json" --argjson item "$item" '$values + [$item]')
    topology_item=$(jq -cn \
      --arg cluster "$cluster" --arg region "$(region_for "$cluster")" \
      --arg context "fiducia-e2e-$cluster" --arg kubeconfig "$kubeconfig" \
      --arg nodeEndpoint "http://127.0.0.1:$(node_port_for "$cluster")" \
      --arg endpoint "http://127.0.0.1:$(lb_port_for "$cluster")" --arg uid "$uid" '
      {
        clusterId: $cluster,
        region: $region,
        kubernetesDistribution: "vcluster",
        kubeContext: $context,
        kubeconfig: $kubeconfig,
        nodeEndpoint: $nodeEndpoint,
        endpoint: $endpoint,
        expectedKubernetesClusterUid: $uid
      }')
    topology_clusters=$(jq -cn --argjson values "$topology_clusters" --argjson item "$topology_item" '$values + [$item]')
  done
  source_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)
  release_json=$(jq -c . "$release_dir/evidence/release.json")
  jq -n --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg source_sha "$source_sha" \
    --arg release_id "$release_id" --argjson release "$release_json" --argjson clusters "$clusters_json" '
    {
      schema_version: 1,
      proof_scope: "three-logically-isolated-vclusters-on-existing-hetzner-kubeadm",
      generated_at: $generated_at,
      source: {repository: "fiducia-infra", commit: $source_sha, clean: true},
      release_id: $release_id,
      release: $release,
      clusters: $clusters
    }' | tee "$evidence_dir/infra-evidence.json" | openssl dgst -sha256
  jq -n --argjson clusters "$topology_clusters" '
    {schemaVersion: 1, provider: "hetzner", isolationMode: "logical", namespace: "fiducia", clusters: $clusters}' |
    tee "$evidence_dir/proof-topology.json" | openssl dgst -sha256
  infra_sha=$(openssl dgst -sha256 "$evidence_dir/infra-evidence.json" | awk '{print $NF}')
  topology_sha=$(openssl dgst -sha256 "$evidence_dir/proof-topology.json" | awk '{print $NF}')
  jq -n \
    --arg source_sha "$source_sha" --arg release_id "$release_id" \
    --arg topology_sha "$topology_sha" --arg infra_sha "$infra_sha" '
    {
      schema_version: 1,
      provider: "hetzner",
      proof_scope: "three-logically-isolated-vclusters-on-existing-hetzner-kubeadm",
      source: {repository: "fiducia-infra", commit: $source_sha, clean: true},
      release_id: $release_id,
      topology: {file: "proof-topology.json", sha256: $topology_sha},
      infra_evidence: {file: "infra-evidence.json", sha256: $infra_sha}
    }' | tee "$evidence_dir/proof-input.json" | openssl dgst -sha256
  chmod 600 "$evidence_dir/infra-evidence.json" "$evidence_dir/proof-topology.json" "$evidence_dir/proof-input.json"
  printf '%s\n' "$evidence_dir"
}

run_proof() {
  local release_id=$1 evidence_dir topology proof_dir
  evidence_dir=$(write_evidence "$release_id" | tail -n 1)
  topology="$evidence_dir/proof-topology.json"
  proof_dir="$evidence_dir/fiducia-e2e-proof"
  test -d "$E2E_ROOT/.git" || fail "fiducia-e2e checkout not found"
  test -z "$(git -C "$E2E_ROOT" status --porcelain --untracked-files=normal)" ||
    fail "strict proof requires clean committed fiducia-e2e source"
  test -n "${FIDUCIA_INTERNAL_SECRET:-}" || fail "FIDUCIA_INTERNAL_SECRET is required"
  test -n "${FIDUCIA_E2E_ORG_ID:-}" || fail "FIDUCIA_E2E_ORG_ID is required"
  FIDUCIA_E2E_TOPOLOGY_FILE="$topology" \
  FIDUCIA_E2E_INFRA_ATTESTATION_FILE="$evidence_dir/proof-input.json" \
  FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1 \
  FIDUCIA_E2E_LOCAL_EDGE_SECRET="$FIDUCIA_INTERNAL_SECRET" \
  npm --prefix "$E2E_ROOT" run proof:hetzner -- --evidence-dir "$proof_dir"
  jq -e '.passed == true and .proof == "fiducia-locks-leases-three-hetzner-clusters"' "$proof_dir/manifest.json" >/dev/null ||
    fail "strict locks/leases proof failed"
  printf 'strict locks/leases proof passed: %s\n' "$proof_dir"
}

command=${1:-}
release_id=${2:-}
case "$command" in
  preflight) preflight ;;
  render) render_release "$release_id" ;;
  apply) apply_release "$release_id" ;;
  verify) verify_release "$release_id" ;;
  evidence) write_evidence "$release_id" ;;
  proof) run_proof "$release_id" ;;
  *) usage >&2; exit 2 ;;
esac
