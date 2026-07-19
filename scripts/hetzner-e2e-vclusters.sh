#!/usr/bin/env bash
set -euo pipefail

# Zero-new-server lifecycle for three official vCluster tenants on the existing
# five-node Hetzner kubeadm cluster. Nothing here chooses the current kubectl
# context implicitly, and install/destroy both require exact confirmation text.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
PROFILE_ROOT="$REPO_ROOT/vcluster/hetzner-e2e"
STATE_DIR=${FIDUCIA_HETZNER_E2E_STATE_DIR:-"$HOME/.local/state/fiducia/hetzner-e2e"}
CHART_VERSION=0.35.1
CHART_REPOSITORY=https://charts.loft.sh
CHART_URL="$CHART_REPOSITORY/charts/vcluster-$CHART_VERSION.tgz"
CHART_SHA256=ec1db9e9faf2da674eba5df3594b9d209861ee8e5889be850a9bb60861158c5b
CLUSTERS=(hetzner-fsn1 hetzner-nbg1 hetzner-hel1)
NODE_MAP=${FIDUCIA_VCLUSTER_NODE_MAP:-'{"hetzner-fsn1":"dd-k8s-fsn1","hetzner-nbg1":"dd-k8s-nbg1","hetzner-hel1":"dd-k8s-hel1"}'}
EXPECTED_FAILURE_DOMAINS='{"hetzner-fsn1":{"region":"eu-central","zone":"fsn1"},"hetzner-nbg1":{"region":"eu-central","zone":"nbg1"},"hetzner-hel1":{"region":"eu-central","zone":"hel1"}}'
HOST_NODE_INVENTORY='{}'
HCLOUD_LOCATION_EVIDENCE_SOURCE=''

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'usage: scripts/hetzner-e2e-vclusters.sh preflight' \
    '       scripts/hetzner-e2e-vclusters.sh plan <plan-id>' \
    '       scripts/hetzner-e2e-vclusters.sh install <plan-id>' \
    '       scripts/hetzner-e2e-vclusters.sh status' \
    '       scripts/hetzner-e2e-vclusters.sh destroy'
}

command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
command -v helm >/dev/null 2>&1 || fail "Helm 3 is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "Node.js is required"
case "$STATE_DIR" in /*) ;; *) fail "FIDUCIA_HETZNER_E2E_STATE_DIR must be absolute" ;; esac
case "$STATE_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state must remain outside the repository" ;; esac
mkdir -p "$STATE_DIR/plans" "$STATE_DIR/kubeconfigs" "$STATE_DIR/evidence" "$STATE_DIR/charts"
chmod 700 "$STATE_DIR" "$STATE_DIR/plans" "$STATE_DIR/kubeconfigs" "$STATE_DIR/evidence" "$STATE_DIR/charts"
STATE_DIR=$(cd "$STATE_DIR" && pwd -P)
case "$STATE_DIR" in
  "$REPO_ROOT"|"$REPO_ROOT"/*) fail "state must remain outside the repository" ;;
esac
umask 077

if test -n "${FIDUCIA_HOST_KUBECONFIG:-}" && test -n "${FIDUCIA_HOST_CONTEXT:-}"; then
  fail "set one of FIDUCIA_HOST_KUBECONFIG or FIDUCIA_HOST_CONTEXT, not both"
elif test -n "${FIDUCIA_HOST_KUBECONFIG:-}"; then
  test -f "$FIDUCIA_HOST_KUBECONFIG" || fail "host kubeconfig not found: $FIDUCIA_HOST_KUBECONFIG"
  HOST_ARGS=(--kubeconfig="$FIDUCIA_HOST_KUBECONFIG")
  HELM_HOST_ARGS=(--kubeconfig="$FIDUCIA_HOST_KUBECONFIG")
elif test -n "${FIDUCIA_HOST_CONTEXT:-}"; then
  HOST_ARGS=(--context="$FIDUCIA_HOST_CONTEXT")
  HELM_HOST_ARGS=(--kube-context="$FIDUCIA_HOST_CONTEXT")
else
  fail "explicitly set FIDUCIA_HOST_KUBECONFIG or FIDUCIA_HOST_CONTEXT; current-context fallback is forbidden"
fi

host_kubectl() {
  kubectl "${HOST_ARGS[@]}" "$@"
}

namespace_for() {
  printf 'fiducia-vc-%s' "${1#hetzner-}"
}

release_for() {
  printf 'fiducia-%s' "$1"
}

validate_node_map() {
  jq -e 'type == "object" and keys == ["hetzner-fsn1","hetzner-hel1","hetzner-nbg1"] and
    ([.[]] | (length == 3 and (unique | length == 3))) and all(.[]; type == "string" and length > 0)' \
    <<<"$NODE_MAP" >/dev/null || fail "FIDUCIA_VCLUSTER_NODE_MAP must map exactly three cluster IDs to three distinct Node names"
}

node_for() {
  jq -er --arg cluster "$1" '.[$cluster]' <<<"$NODE_MAP"
}

load_hcloud_inventory() {
  local inventory_file=${FIDUCIA_HCLOUD_INVENTORY_FILE:-}
  if test -n "$inventory_file"; then
    case "$inventory_file" in /*) ;; *) fail "FIDUCIA_HCLOUD_INVENTORY_FILE must be absolute" ;; esac
    test -f "$inventory_file" || fail "hcloud inventory file not found: $inventory_file"
    case "$inventory_file" in "$REPO_ROOT"|"$REPO_ROOT"/*) fail "hcloud inventory evidence must stay outside the repository" ;; esac
    HCLOUD_INVENTORY=$(<"$inventory_file")
    HCLOUD_LOCATION_EVIDENCE_SOURCE=reviewed-inventory-file
  else
    command -v hcloud >/dev/null 2>&1 ||
      fail "hcloud is required for read-only server location verification; alternatively set FIDUCIA_HCLOUD_INVENTORY_FILE"
    if ! HCLOUD_INVENTORY=$(hcloud server list -o json); then
      fail "read-only hcloud server inventory failed; alternatively supply a reviewed FIDUCIA_HCLOUD_INVENTORY_FILE"
    fi
    HCLOUD_LOCATION_EVIDENCE_SOURCE=live-hcloud-api
  fi
  jq -e 'type == "array"' <<<"$HCLOUD_INVENTORY" >/dev/null ||
    fail "hcloud inventory must be the JSON array returned by hcloud server list -o json"
}

ensure_chart() {
  CHART_FILE="$STATE_DIR/charts/vcluster-$CHART_VERSION.tgz"
  if test ! -f "$CHART_FILE"; then
    curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location \
      "$CHART_URL" --output "$CHART_FILE"
    chmod 600 "$CHART_FILE"
  fi
  actual_chart_sha=$(openssl dgst -sha256 "$CHART_FILE" | awk '{print $NF}')
  test "$actual_chart_sha" = "$CHART_SHA256" ||
    fail "vCluster chart checksum mismatch; preserve the artifact for audit and use a fresh state directory"
}

host_preflight() {
  validate_node_map
  local nodes host_uid known_cni cluster node hostname provider_id region zone
  host_uid=$(host_kubectl get namespace kube-system -o jsonpath='{.metadata.uid}')
  test -n "$host_uid" || fail "cannot identify the host cluster"
  nodes=$(host_kubectl get nodes -o json)
  test "$(jq '[.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length' <<<"$nodes")" -ge 3 ||
    fail "host cluster needs at least three Ready nodes"
  load_hcloud_inventory
  if ! HOST_NODE_INVENTORY=$(
    jq -cn \
      --argjson nodes "$nodes" \
      --argjson hcloudServers "$HCLOUD_INVENTORY" \
      --argjson nodeMap "$NODE_MAP" \
      --argjson expectedFailureDomains "$EXPECTED_FAILURE_DOMAINS" \
      '{nodes: $nodes, hcloudServers: $hcloudServers, nodeMap: $nodeMap, expectedFailureDomains: $expectedFailureDomains}' |
      node "$REPO_ROOT/tools/validate-vcluster-host.mjs"
  ); then
    fail "host Node identity/location verification failed before any cluster mutation"
  fi
  for cluster in "${CLUSTERS[@]}"; do
    node=$(jq -er --arg cluster "$cluster" '.[$cluster].node' <<<"$HOST_NODE_INVENTORY")
    hostname=$(jq -er --arg cluster "$cluster" '.[$cluster].hostname' <<<"$HOST_NODE_INVENTORY")
    provider_id=$(jq -er --arg cluster "$cluster" '.[$cluster].provider_id' <<<"$HOST_NODE_INVENTORY")
    region=$(jq -er --arg cluster "$cluster" '.[$cluster].region' <<<"$HOST_NODE_INVENTORY")
    zone=$(jq -er --arg cluster "$cluster" '.[$cluster].zone' <<<"$HOST_NODE_INVENTORY")
    printf '%s host-node=%s hostname-label=%s provider-id=%s region=%s zone=%s\n' \
      "$cluster" "$node" "$hostname" "$provider_id" "$region" "$zone"
  done
  host_kubectl get storageclass local-path >/dev/null 2>&1 ||
    fail "host cluster must provide the local-path StorageClass used by this disposable profile"
  known_cni=$(host_kubectl get daemonsets -A -o json | jq '[.items[] | .metadata.name | select(test("calico|cilium|kube-router"))] | length')
  if test "$known_cni" -eq 0 && test "${FIDUCIA_CONFIRM_NETWORKPOLICY_CNI:-}" != "verified-networkpolicy-enforcement"; then
    fail "no known NetworkPolicy-enforcing CNI was detected; verify independently and set FIDUCIA_CONFIRM_NETWORKPOLICY_CNI=verified-networkpolicy-enforcement"
  fi
  printf 'host-cluster-uid=%s ready-nodes=%s networkpolicy-cni-matches=%s\n' \
    "$host_uid" "$(jq '[.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length' <<<"$nodes")" "$known_cni"
}

helm_arguments() {
  local cluster=$1 node hostname namespace release
  node=$(node_for "$cluster")
  hostname=$(host_kubectl get node "$node" -o jsonpath='{.metadata.labels.kubernetes\.io/hostname}')
  namespace=$(namespace_for "$cluster")
  release=$(release_for "$cluster")
  ensure_chart
  HELM_ARGS=(
    "$release" "$CHART_FILE"
    --namespace "$namespace"
    --values "$PROFILE_ROOT/values/common.yaml"
    --values "$PROFILE_ROOT/values/$cluster.yaml"
    --set-string "sync.fromHost.nodes.selector.labels.kubernetes\\.io/hostname=$hostname"
    --set-string "controlPlane.statefulSet.scheduling.nodeSelector.kubernetes\\.io/hostname=$hostname"
  )
}

plan_fleet() {
  local plan_id=$1 plan_dir cluster manifest digest host_uid manifests_json source_sha dirty
  [[ "$plan_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail "plan-id has unsafe characters"
  host_preflight
  plan_dir="$STATE_DIR/plans/$plan_id"
  test ! -e "$plan_dir" || fail "plan already exists and is immutable: $plan_dir"
  mkdir -p "$plan_dir"
  chmod 700 "$plan_dir"
  manifests_json='{}'
  for cluster in "${CLUSTERS[@]}"; do
    helm_arguments "$cluster"
    manifest="$plan_dir/$cluster.yaml"
    helm template "${HELM_ARGS[@]}" --include-crds |
      tee "$manifest" |
      openssl dgst -sha256
    if rg -n '^\s*type:\s*(NodePort|LoadBalancer)\s*$' "$manifest" >/dev/null; then
      fail "$cluster chart render exposes a forbidden host NodePort or LoadBalancer"
    fi
    rg -q 'ghcr.io/loft-sh/vcluster-oss:0.35.1@sha256:' "$manifest" ||
      fail "$cluster chart render lost the pinned vCluster image digest"
    digest=$(openssl dgst -sha256 "$manifest" | awk '{print $NF}')
    manifests_json=$(jq -cn --argjson values "$manifests_json" --arg cluster "$cluster" --arg digest "sha256:$digest" '$values + {($cluster): $digest}')
  done
  host_uid=$(host_kubectl get namespace kube-system -o jsonpath='{.metadata.uid}')
  source_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)
  dirty=false
  test -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" || dirty=true
  jq -n \
    --arg plan_id "$plan_id" \
    --arg host_cluster_uid "$host_uid" \
    --arg chart_version "$CHART_VERSION" \
    --arg source_sha "$source_sha" \
    --arg location_evidence_source "$HCLOUD_LOCATION_EVIDENCE_SOURCE" \
    --argjson source_dirty "$dirty" \
    --argjson node_map "$NODE_MAP" \
    --argjson expected_failure_domains "$EXPECTED_FAILURE_DOMAINS" \
    --argjson host_nodes "$HOST_NODE_INVENTORY" \
    --argjson manifests "$manifests_json" '
      {
        schema_version: 2,
        mode: "three-vclusters-on-existing-hetzner-host",
        plan_id: $plan_id,
        host_cluster_uid: $host_cluster_uid,
        chart: {repository: "https://charts.loft.sh", name: "vcluster", version: $chart_version, sha256: "ec1db9e9faf2da674eba5df3594b9d209861ee8e5889be850a9bb60861158c5b"},
        source: {commit: $source_sha, dirty: $source_dirty},
        node_map: $node_map,
        expected_failure_domains: $expected_failure_domains,
        host_nodes: $host_nodes,
        hcloud_location_evidence: {source: $location_evidence_source},
        manifests: $manifests
      }' | tee "$plan_dir/plan.json" | openssl dgst -sha256
  chmod 600 "$plan_dir"/*
  printf 'non-mutating plan saved under %s; review every manifest before install\n' "$plan_dir"
}

verify_plan() {
  local plan_id=$1 plan_dir metadata host_uid source_sha cluster manifest expected actual fresh
  plan_dir="$STATE_DIR/plans/$plan_id"
  metadata="$plan_dir/plan.json"
  test -f "$metadata" || fail "missing reviewed plan: $metadata"
  jq -e \
    --arg plan_id "$plan_id" \
    --argjson node_map "$NODE_MAP" \
    --argjson expected_failure_domains "$EXPECTED_FAILURE_DOMAINS" \
    --argjson host_nodes "$HOST_NODE_INVENTORY" '
    .schema_version == 2 and .mode == "three-vclusters-on-existing-hetzner-host" and
    .plan_id == $plan_id and .chart.version == "0.35.1" and .node_map == $node_map and
    .expected_failure_domains == $expected_failure_domains and .host_nodes == $host_nodes and
    (.hcloud_location_evidence.source == "live-hcloud-api" or .hcloud_location_evidence.source == "reviewed-inventory-file") and
    .source.dirty == false
  ' "$metadata" >/dev/null || fail "plan metadata does not match this invocation"
  host_uid=$(host_kubectl get namespace kube-system -o jsonpath='{.metadata.uid}')
  test "$host_uid" = "$(jq -er .host_cluster_uid "$metadata")" || fail "plan belongs to a different host cluster"
  source_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)
  test "$source_sha" = "$(jq -er .source.commit "$metadata")" || fail "source commit changed after plan"
  test -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" || fail "install requires a clean committed source tree"
  for cluster in "${CLUSTERS[@]}"; do
    manifest="$plan_dir/$cluster.yaml"
    expected=$(jq -er --arg cluster "$cluster" '.manifests[$cluster] | sub("^sha256:"; "")' "$metadata")
    actual=$(openssl dgst -sha256 "$manifest" | awk '{print $NF}')
    test "$actual" = "$expected" || fail "$cluster planned manifest changed"
    helm_arguments "$cluster"
    fresh=$(helm template "${HELM_ARGS[@]}" --include-crds | openssl dgst -sha256 | awk '{print $NF}')
    test "$fresh" = "$expected" || fail "$cluster no longer renders byte-for-byte like the reviewed plan"
  done
}

install_fleet() {
  local plan_id=$1 cluster namespace fleet_owner logical_owner
  test "${FIDUCIA_CONFIRM_VCLUSTER_INSTALL:-}" = "install-three-logical-vclusters-no-new-servers" ||
    fail "set FIDUCIA_CONFIRM_VCLUSTER_INSTALL=install-three-logical-vclusters-no-new-servers after reviewing the plan"
  host_preflight
  verify_plan "$plan_id"
  for cluster in "${CLUSTERS[@]}"; do
    namespace=$(namespace_for "$cluster")
    if host_kubectl get namespace "$namespace" >/dev/null 2>&1; then
      test "${FIDUCIA_ALLOW_VCLUSTER_UPGRADE:-}" = "upgrade-owned-three-vcluster-fleet" ||
        fail "$namespace already exists; a reviewed upgrade requires FIDUCIA_ALLOW_VCLUSTER_UPGRADE=upgrade-owned-three-vcluster-fleet"
      fleet_owner=$(host_kubectl get namespace "$namespace" -o jsonpath='{.metadata.labels.fiducia\.cloud/vcluster-fleet}')
      logical_owner=$(host_kubectl get namespace "$namespace" -o jsonpath='{.metadata.labels.fiducia\.cloud/logical-cluster}')
      test "$fleet_owner" = "hetzner-e2e" && test "$logical_owner" = "$cluster" ||
        fail "refusing to adopt pre-existing or mismatched namespace $namespace"
    fi
  done
  for cluster in "${CLUSTERS[@]}"; do
    namespace=$(namespace_for "$cluster")
    host_kubectl create namespace "$namespace" --dry-run=client -o yaml |
      host_kubectl apply -f - >/dev/null
    host_kubectl label namespace "$namespace" \
      fiducia.cloud/vcluster-fleet=hetzner-e2e \
      fiducia.cloud/logical-cluster="$cluster" \
      pod-security.kubernetes.io/enforce=baseline \
      pod-security.kubernetes.io/audit=restricted \
      pod-security.kubernetes.io/warn=restricted \
      --overwrite >/dev/null
    helm_arguments "$cluster"
    helm upgrade --install "${HELM_ARGS[@]}" \
      "${HELM_HOST_ARGS[@]}" \
      --atomic --wait --timeout 10m --history-max 5
  done
  status_fleet
}

status_fleet() {
  local cluster namespace release expected_node pod_node
  host_preflight
  for cluster in "${CLUSTERS[@]}"; do
    namespace=$(namespace_for "$cluster")
    release=$(release_for "$cluster")
    expected_node=$(node_for "$cluster")
    test "$(host_kubectl get namespace "$namespace" -o jsonpath='{.metadata.labels.fiducia\.cloud/vcluster-fleet}')" = "hetzner-e2e" ||
      fail "$namespace is not owned by this test fleet"
    helm status "$release" --namespace "$namespace" "${HELM_HOST_ARGS[@]}" >/dev/null
    host_kubectl -n "$namespace" rollout status statefulset/"$release" --timeout=5m
    pod_node=$(host_kubectl -n "$namespace" get pod -l "app=vcluster,release=$release" -o json |
      jq -er '.items | if length == 1 then .[0].spec.nodeName else error("expected one vCluster control-plane pod") end')
    test "$pod_node" = "$expected_node" || fail "$cluster control plane landed on $pod_node, expected $expected_node"
    host_kubectl -n "$namespace" get resourcequota,limitrange,networkpolicy >/dev/null
    test "$(host_kubectl -n "$namespace" get service -o json | jq '[.items[] | select(.spec.type == "NodePort" or .spec.type == "LoadBalancer")] | length')" -eq 0 ||
      fail "$namespace exposes a host NodePort or LoadBalancer"
    printf 'healthy logical cluster %s namespace=%s host-node=%s\n' "$cluster" "$namespace" "$pod_node"
  done
}

destroy_fleet() {
  local cluster namespace release fleet_owner logical_owner
  test "${FIDUCIA_CONFIRM_VCLUSTER_DESTROY:-}" = "destroy-three-logical-vclusters" ||
    fail "set FIDUCIA_CONFIRM_VCLUSTER_DESTROY=destroy-three-logical-vclusters"
  test "${FIDUCIA_CONFIRM_EVIDENCE_CAPTURED:-}" = "evidence-captured" ||
    fail "capture proof evidence first, then set FIDUCIA_CONFIRM_EVIDENCE_CAPTURED=evidence-captured"
  host_preflight
  for cluster in "${CLUSTERS[@]}"; do
    namespace=$(namespace_for "$cluster")
    release=$(release_for "$cluster")
    fleet_owner=$(host_kubectl get namespace "$namespace" -o jsonpath='{.metadata.labels.fiducia\.cloud/vcluster-fleet}')
    logical_owner=$(host_kubectl get namespace "$namespace" -o jsonpath='{.metadata.labels.fiducia\.cloud/logical-cluster}')
    test "$fleet_owner" = "hetzner-e2e" && test "$logical_owner" = "$cluster" ||
      fail "refusing to destroy unowned namespace $namespace"
    helm status "$release" --namespace "$namespace" "${HELM_HOST_ARGS[@]}" >/dev/null
  done
  for cluster in "${CLUSTERS[@]}"; do
    namespace=$(namespace_for "$cluster")
    release=$(release_for "$cluster")
    helm uninstall "$release" --namespace "$namespace" "${HELM_HOST_ARGS[@]}" --wait --timeout 10m
    host_kubectl delete namespace "$namespace" --wait=true --timeout=10m
  done
}

command=${1:-}
argument=${2:-}
case "$command" in
  preflight) host_preflight ;;
  plan) test -n "$argument" || fail "plan-id is required"; plan_fleet "$argument" ;;
  install) test -n "$argument" || fail "plan-id is required"; install_fleet "$argument" ;;
  status) status_fleet ;;
  destroy) destroy_fleet ;;
  *) usage >&2; exit 2 ;;
esac
