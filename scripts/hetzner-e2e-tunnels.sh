#!/usr/bin/env bash
set -euo pipefail

# Keep six loopback-only forwards alive: each cluster's node API and load
# balancer. The process stays in the foreground; stopping it closes the tunnels.
# Optional future new-server profile only.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
TF_ROOT="$REPO_ROOT/terraform/envs/hetzner-e2e"
STATE_DIR=${FIDUCIA_HETZNER_E2E_STATE_DIR:-"$HOME/.local/state/fiducia/hetzner-e2e"}
STATE_FILE="$STATE_DIR/terraform.tfstate"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

test "${FIDUCIA_ENABLE_OPTIONAL_NEW_SERVERS:-}" = "create-three-additional-hetzner-servers" ||
  fail "new-server SSH tunnels are disabled; use hetzner-e2e-vcluster-tunnels.sh"

command -v jq >/dev/null 2>&1 || fail "jq is required"
test -f "$STATE_FILE" || fail "missing Terraform state: $STATE_FILE"

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
test -f "$KNOWN_HOSTS" || fail "fetch kubeconfigs first so host keys are recorded"
inventory=$(terraform -chdir="$TF_ROOT" output -state="$STATE_FILE" -json fleet)
test "$(jq 'length' <<<"$inventory")" -eq 3 || fail "Terraform output must contain exactly three clusters"

pids=()
cleanup() {
  if test "${#pids[@]}" -gt 0; then
    kill "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for cluster in hetzner-fsn1 hetzner-nbg1 hetzner-hel1; do
  public_ipv4=$(jq -er --arg cluster "$cluster" '.[$cluster].public_ipv4' <<<"$inventory")
  private_ipv4=$(jq -er --arg cluster "$cluster" '.[$cluster].private_ipv4' <<<"$inventory")
  node_url=$(jq -er --arg cluster "$cluster" '.[$cluster].node_tunnel_url' <<<"$inventory")
  lb_url=$(jq -er --arg cluster "$cluster" '.[$cluster].lb_tunnel_url' <<<"$inventory")
  node_port=${node_url##*:}
  lb_port=${lb_url##*:}

  ssh -N \
    -i "$SSH_KEY" \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$KNOWN_HOSTS" \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -L "127.0.0.1:$node_port:$private_ipv4:30080" \
    -L "127.0.0.1:$lb_port:$private_ipv4:30088" \
    "root@$public_ipv4" &
  pids+=("$!")
  printf '%s node=%s lb=%s\n' "$cluster" "$node_url" "$lb_url"
done

printf 'Six loopback-only SSH forwards are active; press Ctrl-C to stop them.\n'
wait "${pids[@]}"
