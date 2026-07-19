#!/usr/bin/env bash
set -euo pipefail

# Render, deploy, verify, and prove the three-cluster Hetzner test system. Every
# stateful artifact is written below an external mode-0700 state directory.
# Optional future new-server profile only. The existing-host vCluster workflow
# is scripts/hetzner-e2e-vcluster-deploy.sh.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
TF_ROOT="$REPO_ROOT/terraform/envs/hetzner-e2e"
E2E_ROOT=${FIDUCIA_E2E_REPO:-"$(dirname "$REPO_ROOT")/fiducia-e2e"}
STATE_DIR=${FIDUCIA_HETZNER_E2E_STATE_DIR:-"$HOME/.local/state/fiducia/hetzner-e2e"}
STATE_FILE="$STATE_DIR/terraform.tfstate"
KUBECONFIG_DIR="$STATE_DIR/kubeconfigs"
CLUSTERS=(hetzner-fsn1 hetzner-nbg1 hetzner-hel1)

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

test "${FIDUCIA_ENABLE_OPTIONAL_NEW_SERVERS:-}" = "create-three-additional-hetzner-servers" ||
  fail "new-server deployment is disabled; use the vCluster deployment script"

usage() {
  printf '%s\n' \
    'usage: scripts/hetzner-e2e-deploy.sh preflight' \
    '       scripts/hetzner-e2e-deploy.sh render <release-id>' \
    '       scripts/hetzner-e2e-deploy.sh apply <release-id>' \
    '       scripts/hetzner-e2e-deploy.sh verify <release-id>' \
    '       scripts/hetzner-e2e-deploy.sh evidence <release-id>' \
    '       scripts/hetzner-e2e-deploy.sh proof <release-id>'
}

command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
command -v node >/dev/null 2>&1 || fail "Node.js is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
command -v git >/dev/null 2>&1 || fail "git is required"
case "$STATE_DIR" in /*) ;; *) fail "FIDUCIA_HETZNER_E2E_STATE_DIR must be absolute" ;; esac
case "$STATE_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state and evidence must remain outside the repository" ;; esac
mkdir -p "$STATE_DIR/releases" "$STATE_DIR/evidence"
chmod 700 "$STATE_DIR" "$STATE_DIR/releases" "$STATE_DIR/evidence"
STATE_DIR=$(cd "$STATE_DIR" && pwd -P)
case "$STATE_DIR" in
  "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state and evidence must remain outside the repository" ;;
esac
umask 077

release_directory() {
  local release_id=${1:-}
  test -n "$release_id" || fail "a release-id is required"
  [[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail "release-id has unsafe characters"
  printf '%s/releases/%s' "$STATE_DIR" "$release_id"
}

private_ip_for() {
  case "$1" in
    hetzner-fsn1) printf '10.30.0.11' ;;
    hetzner-nbg1) printf '10.30.0.12' ;;
    hetzner-hel1) printf '10.30.0.13' ;;
    *) fail "unknown cluster $1" ;;
  esac
}

region_for() {
  case "$1" in
    hetzner-fsn1) printf 'fsn1' ;;
    hetzner-nbg1) printf 'nbg1' ;;
    hetzner-hel1) printf 'hel1' ;;
    *) fail "unknown cluster $1" ;;
  esac
}

preflight() {
  local uids='' cluster kubeconfig context uid nodes expected_ip
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig="$KUBECONFIG_DIR/$cluster.kubeconfig"
    test -f "$kubeconfig" || fail "missing kubeconfig: $kubeconfig"
    context=$(kubectl --kubeconfig="$kubeconfig" config current-context)
    test "$context" = "fiducia-e2e-$cluster" || fail "$cluster has unexpected context $context"
    uid=$(kubectl --kubeconfig="$kubeconfig" get namespace kube-system \
      -o jsonpath='{.metadata.uid}')
    test -n "$uid" || fail "$cluster has no Kubernetes cluster UID"
    nodes=$(kubectl --kubeconfig="$kubeconfig" get nodes -o json)
    expected_ip=$(private_ip_for "$cluster")
    jq -e --arg ip "$expected_ip" '
      (.items | length) == 1 and
      any(.items[0].status.conditions[]?; .type == "Ready" and .status == "True") and
      any(.items[0].status.addresses[]?; .type == "InternalIP" and .address == $ip)
    ' <<<"$nodes" >/dev/null || fail "$cluster must have one Ready node at private IP $expected_ip"
    uids="$uids$uid"$'\n'
    printf '%s uid=%s context=%s node=%s\n' "$cluster" "$uid" "$context" "$expected_ip"
  done
  unique_uids=$(printf '%s' "$uids" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')
  test "$unique_uids" -eq 3 || fail "preflight requires exactly three distinct Kubernetes cluster UIDs"
}

validate_release() {
  local release_dir=$1 release_json cluster manifest expected actual source_sha
  release_json="$release_dir/evidence/release.json"
  test -f "$release_json" || fail "missing release metadata: $release_json"
  jq -e '
    .schema_version == 1 and
    .profile == "vm" and
    .topology == "three-independent-single-node-k3s-on-hetzner" and
    .source.repository == "fiducia-infra" and .source.clean == true and
    (.source.commit | test("^[0-9a-f]{40}$")) and
    .clusters == ["hetzner-fsn1", "hetzner-nbg1", "hetzner-hel1"] and
    ([.images[] | test("^ghcr\\.io/fiducia-cloud/.+@sha256:[0-9a-f]{64}$")] | all)
  ' "$release_json" >/dev/null || fail "invalid release metadata"
  source_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)
  test "$source_sha" = "$(jq -er .source.commit "$release_json")" || fail "release belongs to a different fiducia-infra commit"
  test -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ||
    fail "release use requires clean committed fiducia-infra source"
  for cluster in "${CLUSTERS[@]}"; do
    manifest="$release_dir/manifests/$cluster.yaml"
    test -f "$manifest" || fail "missing release manifest: $manifest"
    expected=$(jq -er --arg cluster "$cluster" '.manifests[$cluster] | sub("^sha256:"; "")' "$release_json")
    actual=$(openssl dgst -sha256 "$manifest" | awk '{print $NF}')
    test "$actual" = "$expected" || fail "$cluster manifest digest does not match release metadata"
  done
}

render_release() {
  local release_id=$1 release_dir
  release_dir=$(release_directory "$release_id")
  test ! -e "$release_dir" || fail "release already exists and is immutable: $release_dir"
  test -n "${FIDUCIA_NODE_IMAGE:-}" || fail "FIDUCIA_NODE_IMAGE is required"
  test -n "${FIDUCIA_NODE_SIDECAR_IMAGE:-}" || fail "FIDUCIA_NODE_SIDECAR_IMAGE is required"
  test -n "${FIDUCIA_BRAIN_IMAGE:-}" || fail "FIDUCIA_BRAIN_IMAGE is required"
  test -n "${FIDUCIA_LOAD_BALANCE_IMAGE:-}" || fail "FIDUCIA_LOAD_BALANCE_IMAGE is required"
  node "$REPO_ROOT/tools/render-hetzner-e2e-release.mjs" \
    --profile vm \
    --output "$release_dir" \
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
  test "${FIDUCIA_CONFIRM_DEPLOY:-}" = "deploy-hetzner-e2e" || \
    fail "set FIDUCIA_CONFIRM_DEPLOY=deploy-hetzner-e2e after reviewing all three manifests"
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig="$KUBECONFIG_DIR/$cluster.kubeconfig"
    kubectl --kubeconfig="$kubeconfig" -n fiducia get secret fiducia-secrets -o json |
      jq -e '.data["internal-secret"] and .data["brain-raft-secret"]' >/dev/null ||
      fail "$cluster is missing fiducia-secrets; run scripts/hetzner-e2e-secrets.sh"
  done
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig="$KUBECONFIG_DIR/$cluster.kubeconfig"
    kubectl --kubeconfig="$kubeconfig" apply -f "$release_dir/manifests/$cluster.yaml"
  done
}

check_image() {
  local kubeconfig=$1 release_json=$2 kind=$3 resource=$4 container=$5 image_key=$6 expected actual
  expected=$(jq -er --arg key "$image_key" '.images[$key]' "$release_json")
  actual=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get "$kind" "$resource" -o json |
    jq -er --arg container "$container" '.spec.template.spec.containers[] | select(.name == $container) | .image')
  test "$actual" = "$expected" || fail "$resource/$container runs $actual, expected $expected"
}

verify_release() {
  local release_id=$1 release_dir release_json cluster kubeconfig config expected_ip pods
  release_dir=$(release_directory "$release_id")
  release_json="$release_dir/evidence/release.json"
  validate_release "$release_dir"
  preflight
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig="$KUBECONFIG_DIR/$cluster.kubeconfig"
    kubectl --kubeconfig="$kubeconfig" -n fiducia rollout status statefulset/fiducia-node --timeout=5m
    kubectl --kubeconfig="$kubeconfig" -n fiducia rollout status statefulset/fiducia-brain --timeout=5m
    kubectl --kubeconfig="$kubeconfig" -n fiducia rollout status deployment/fiducia-load-balance --timeout=5m
    config=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get configmap fiducia-cluster -o json)
    expected_ip=$(private_ip_for "$cluster")
    jq -e --arg cluster "$cluster" --arg self "$expected_ip:30080" --arg ip "$expected_ip" '
      .data.FIDUCIA_CLUSTER == $cluster and
      .data.FIDUCIA_CLUSTER_ID == "fiducia-e2e-hetzner" and
      .data.FIDUCIA_REPLICATION_FACTOR == "3" and
      .data.FIDUCIA_TARGET_NODES == "3" and
      .data.FIDUCIA_AUTH_REQUIRED == "true" and
      .data.FIDUCIA_SELF_ADDR == $self and
      (.data.FIDUCIA_PEERS | split(",") | length) == 2 and
      (.data.FIDUCIA_BRAIN_PEERS | split(",") | length) == 2 and
      (.data.FIDUCIA_PEERS | contains($ip) | not) and
      (.data.FIDUCIA_BRAIN_PEERS | contains($ip) | not)
    ' <<<"$config" >/dev/null || fail "$cluster has stale or self-referential topology"
    check_image "$kubeconfig" "$release_json" statefulset fiducia-node node node
    check_image "$kubeconfig" "$release_json" statefulset fiducia-node sidecar sidecar
    check_image "$kubeconfig" "$release_json" statefulset fiducia-brain brain brain
    check_image "$kubeconfig" "$release_json" statefulset fiducia-brain sidecar sidecar
    check_image "$kubeconfig" "$release_json" deployment fiducia-load-balance lb load_balance
    pods=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get pods \
      -l 'app in (fiducia-node,fiducia-brain,fiducia-load-balance)' -o json)
    jq -e '
      (.items | length) >= 4 and
      all(.items[]; .metadata.deletionTimestamp == null and
        all(.status.containerStatuses[]?; .ready == true and .imageID != ""))
    ' <<<"$pods" >/dev/null || fail "$cluster has unready or digest-unresolved workload containers"
    printf 'verified %s\n' "$cluster"
  done
}

write_evidence() {
  local release_id=$1 release_dir stamp evidence_dir cluster kubeconfig uid version nodes config workloads item
  local source_sha release_json evidence topology infra_sha topology_sha
  local clusters_json topology_clusters context node_endpoint endpoint
  release_dir=$(release_directory "$release_id")
  verify_release "$release_id"
  test -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" || \
    fail "evidence requires a clean, committed fiducia-infra source tree"
  test -f "$STATE_FILE" || fail "missing Terraform state: $STATE_FILE"
  inventory=$(terraform -chdir="$TF_ROOT" output -state="$STATE_FILE" -json fleet)
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  evidence_dir="$STATE_DIR/evidence/$release_id-$stamp"
  mkdir -p "$evidence_dir"
  chmod 700 "$evidence_dir"
  clusters_json='[]'
  topology_clusters='[]'
  for cluster in "${CLUSTERS[@]}"; do
    kubeconfig="$KUBECONFIG_DIR/$cluster.kubeconfig"
    uid=$(kubectl --kubeconfig="$kubeconfig" get namespace kube-system -o jsonpath='{.metadata.uid}')
    version=$(kubectl --kubeconfig="$kubeconfig" version -o json)
    nodes=$(kubectl --kubeconfig="$kubeconfig" get nodes -o json)
    config=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get configmap fiducia-cluster -o json)
    workloads=$(kubectl --kubeconfig="$kubeconfig" -n fiducia get statefulset,deployment -o json)
    item=$(jq -cn \
      --arg cluster "$cluster" \
      --arg uid "$uid" \
      --argjson version "$version" \
      --argjson nodes "$nodes" \
      --argjson config "$config" \
      --argjson workloads "$workloads" '
        {
          cluster: $cluster,
          kubernetes_cluster_uid: $uid,
          kubernetes_version: $version.serverVersion,
          nodes: [$nodes.items[] | {
            name: .metadata.name,
            uid: .metadata.uid,
            addresses: .status.addresses,
            ready: any(.status.conditions[]?; .type == "Ready" and .status == "True")
          }],
          topology: $config.data,
          workloads: [$workloads.items[] | {
            kind: .kind,
            name: .metadata.name,
            replicas: .spec.replicas,
            images: [.spec.template.spec.containers[] | {name, image}]
          }]
        }')
    clusters_json=$(jq -cn --argjson values "$clusters_json" --argjson item "$item" '$values + [$item]')
    context=$(jq -er --arg cluster "$cluster" '.[$cluster].kubernetes_context' <<<"$inventory")
    node_endpoint=$(jq -er --arg cluster "$cluster" '.[$cluster].node_tunnel_url' <<<"$inventory")
    endpoint=$(jq -er --arg cluster "$cluster" '.[$cluster].lb_tunnel_url' <<<"$inventory")
    topology_item=$(jq -cn \
      --arg cluster "$cluster" \
      --arg region "$(region_for "$cluster")" \
      --arg context "$context" \
      --arg kubeconfig "$kubeconfig" \
      --arg nodeEndpoint "$node_endpoint" \
      --arg endpoint "$endpoint" \
      --arg uid "$uid" '
        {
          clusterId: $cluster,
          region: $region,
          kubernetesDistribution: "k3s",
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
  evidence=$(jq -cn \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg source_sha "$source_sha" \
    --arg release_id "$release_id" \
    --argjson release "$release_json" \
    --argjson clusters "$clusters_json" '
      {
        schema_version: 1,
        proof_scope: "three-independent-single-node-k3s-on-hetzner",
        generated_at: $generated_at,
        source: {repository: "fiducia-infra", commit: $source_sha, clean: true},
        release_id: $release_id,
        release: $release,
        clusters: $clusters
      }')
  printf '%s\n' "$evidence" | jq . | tee "$evidence_dir/infra-evidence.json" | openssl dgst -sha256
  topology=$(jq -cn --argjson clusters "$topology_clusters" \
    '{schemaVersion: 1, provider: "hetzner", isolationMode: "regional", namespace: "fiducia", clusters: $clusters}')
  printf '%s\n' "$topology" | jq . | tee "$evidence_dir/proof-topology.json" | openssl dgst -sha256
  infra_sha=$(openssl dgst -sha256 "$evidence_dir/infra-evidence.json" | awk '{print $NF}')
  topology_sha=$(openssl dgst -sha256 "$evidence_dir/proof-topology.json" | awk '{print $NF}')
  jq -n \
    --arg source_sha "$source_sha" --arg release_id "$release_id" \
    --arg topology_sha "$topology_sha" --arg infra_sha "$infra_sha" '
    {
      schema_version: 1,
      provider: "hetzner",
      proof_scope: "three-independent-single-node-k3s-on-hetzner",
      source: {repository: "fiducia-infra", commit: $source_sha, clean: true},
      release_id: $release_id,
      topology: {file: "proof-topology.json", sha256: $topology_sha},
      infra_evidence: {file: "infra-evidence.json", sha256: $infra_sha}
    }' | tee "$evidence_dir/proof-input.json" | openssl dgst -sha256
  chmod 600 "$evidence_dir/infra-evidence.json" "$evidence_dir/proof-topology.json" "$evidence_dir/proof-input.json"
  printf '%s\n' "$evidence_dir"
}

run_proof() {
  local release_id=$1 evidence_dir topology_file proof_dir
  evidence_dir=$(write_evidence "$release_id" | tail -n 1)
  topology_file="$evidence_dir/proof-topology.json"
  proof_dir="$evidence_dir/fiducia-e2e-proof"
  test -d "$E2E_ROOT/.git" || fail "fiducia-e2e checkout not found: $E2E_ROOT"
  test -z "$(git -C "$E2E_ROOT" status --porcelain --untracked-files=normal)" || \
    fail "strict proof requires a clean, committed fiducia-e2e worktree"
  test -n "${FIDUCIA_INTERNAL_SECRET:-}" || fail "FIDUCIA_INTERNAL_SECRET is required by the loopback trusted-edge adapter"
  test -n "${FIDUCIA_E2E_ORG_ID:-}" || fail "FIDUCIA_E2E_ORG_ID is required"
  FIDUCIA_E2E_TOPOLOGY_FILE="$topology_file" \
  FIDUCIA_E2E_INFRA_ATTESTATION_FILE="$evidence_dir/proof-input.json" \
  FIDUCIA_E2E_ALLOW_INSECURE_LOCALHOST=1 \
  FIDUCIA_E2E_LOCAL_EDGE_SECRET="$FIDUCIA_INTERNAL_SECRET" \
  npm --prefix "$E2E_ROOT" run proof:hetzner -- --evidence-dir "$proof_dir"
  jq -e '.passed == true and .proof == "fiducia-locks-leases-three-hetzner-clusters"' \
    "$proof_dir/manifest.json" >/dev/null || fail "strict lock/lease proof did not pass"
  printf 'strict locks/leases proof passed; sanitized evidence: %s\n' "$proof_dir"
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
