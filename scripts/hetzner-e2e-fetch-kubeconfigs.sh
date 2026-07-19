#!/usr/bin/env bash
set -euo pipefail

# Fetch k3s-generated kubeconfigs over SSH. Client certificates stay below the
# external state directory and are never emitted to stdout.
# Optional future new-server profile only; the existing-host vCluster profile
# uses hetzner-e2e-fetch-vcluster-kubeconfigs.sh.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
TF_ROOT="$REPO_ROOT/terraform/envs/hetzner-e2e"
STATE_DIR=${FIDUCIA_HETZNER_E2E_STATE_DIR:-"$HOME/.local/state/fiducia/hetzner-e2e"}
STATE_FILE="$STATE_DIR/terraform.tfstate"
KUBECONFIG_DIR="$STATE_DIR/kubeconfigs"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

test "${FIDUCIA_ENABLE_OPTIONAL_NEW_SERVERS:-}" = "create-three-additional-hetzner-servers" ||
  fail "new-server SSH fetch is disabled; use the vCluster kubeconfig fetcher"

command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
test -f "$STATE_FILE" || fail "missing Terraform state: $STATE_FILE"
case "$STATE_DIR" in
  /*) ;;
  *) fail "FIDUCIA_HETZNER_E2E_STATE_DIR must be absolute" ;;
esac
mkdir -p "$KUBECONFIG_DIR"
chmod 700 "$STATE_DIR" "$KUBECONFIG_DIR"
umask 077

if test -n "${FIDUCIA_HETZNER_SSH_KEY:-}"; then
  SSH_KEY=$FIDUCIA_HETZNER_SSH_KEY
elif test -f "$HOME/.ssh/id_hetzner"; then
  SSH_KEY="$HOME/.ssh/id_hetzner"
elif test -f "$HOME/.ssh/id_ed25519"; then
  SSH_KEY="$HOME/.ssh/id_ed25519"
else
  fail "set FIDUCIA_HETZNER_SSH_KEY to a private key below ~/.ssh"
fi
test -f "$SSH_KEY" || fail "SSH key does not exist: $SSH_KEY"
case "$(cd "$(dirname "$SSH_KEY")" && pwd -P)/$(basename "$SSH_KEY")" in
  "$HOME/.ssh"/*) ;;
  *) fail "the SSH key must be below ~/.ssh" ;;
esac

KNOWN_HOSTS="$STATE_DIR/known_hosts"
touch "$KNOWN_HOSTS"
chmod 600 "$KNOWN_HOSTS"
strict_host_key_checking=yes
if test "${FIDUCIA_SSH_ACCEPT_NEW_HOST_KEYS:-}" = "1"; then
  strict_host_key_checking=accept-new
fi
ssh_options=(
  -i "$SSH_KEY"
  -o "IdentitiesOnly=yes"
  -o "StrictHostKeyChecking=$strict_host_key_checking"
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
  -o "ConnectTimeout=10"
  -o "ServerAliveInterval=15"
  -o "ServerAliveCountMax=3"
)

inventory=$(terraform -chdir="$TF_ROOT" output -state="$STATE_FILE" -json fleet)
test "$(jq 'length' <<<"$inventory")" -eq 3 || fail "Terraform output must contain exactly three clusters"
expected='["hetzner-fsn1","hetzner-hel1","hetzner-nbg1"]'
test "$(jq -c 'keys' <<<"$inventory")" = "$expected" || fail "unexpected cluster inventory"

paths=()
for cluster in hetzner-fsn1 hetzner-nbg1 hetzner-hel1; do
  public_ipv4=$(jq -er --arg cluster "$cluster" '.[$cluster].public_ipv4' <<<"$inventory")
  context=$(jq -er --arg cluster "$cluster" '.[$cluster].kubernetes_context' <<<"$inventory")
  destination="$KUBECONFIG_DIR/$cluster.kubeconfig"

  printf 'fetching %s over SSH...\n' "$cluster"
  # openssl consumes the second copy from tee, so the kubeconfig itself is never
  # printed. Its fingerprint gives the operator a non-secret audit handle.
  ssh "${ssh_options[@]}" "root@$public_ipv4" \
    'test -s /etc/rancher/k3s/k3s.yaml && cat /etc/rancher/k3s/k3s.yaml' |
    sed "s#https://127.0.0.1:6443#https://$public_ipv4:6443#" |
    tee "$destination" |
    openssl dgst -sha256
  chmod 600 "$destination"
  kubectl --kubeconfig="$destination" config rename-context default "$context" >/dev/null
  paths+=("$destination")
done

joined=$(IFS=:; printf '%s' "${paths[*]}")
printf 'fetched three kubeconfigs; use this shell-local value:\n'
printf 'export KUBECONFIG=%q\n' "$joined"
printf 'First connection only: review each host fingerprint, then set FIDUCIA_SSH_ACCEPT_NEW_HOST_KEYS=1.\n'
