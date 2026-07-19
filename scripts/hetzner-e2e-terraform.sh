#!/usr/bin/env bash
set -euo pipefail

# Guarded Terraform entry point for the disposable three-cluster Hetzner fleet.
# It never performs an implicit apply or destroy and never stores state in Git.
# OPTIONAL FUTURE CAPACITY PATH ONLY: the supported default is vCluster on the
# existing five-node host. This wrapper is inert unless the operator explicitly
# opts back into buying three servers.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
TF_ROOT="$REPO_ROOT/terraform/envs/hetzner-e2e"
STATE_DIR=${FIDUCIA_HETZNER_E2E_STATE_DIR:-"$HOME/.local/state/fiducia/hetzner-e2e"}
TFVARS=${FIDUCIA_HETZNER_E2E_TFVARS:-"$STATE_DIR/terraform.tfvars"}
TF_ENABLE_ARGS=(
  -var enable_optional_new_servers=true
  -var new_server_creation_confirmation=create-three-additional-hetzner-servers
)

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

test "${FIDUCIA_ENABLE_OPTIONAL_NEW_SERVERS:-}" = "create-three-additional-hetzner-servers" ||
  fail "new-server Terraform is disabled; use scripts/hetzner-e2e-vclusters.sh"

usage() {
  printf '%s\n' \
    'usage: scripts/hetzner-e2e-terraform.sh init' \
    '       scripts/hetzner-e2e-terraform.sh plan [saved-plan]' \
    '       scripts/hetzner-e2e-terraform.sh apply <saved-plan>' \
    '       scripts/hetzner-e2e-terraform.sh plan-destroy [saved-plan]' \
    '       scripts/hetzner-e2e-terraform.sh apply-destroy <saved-plan>'
}

case "$STATE_DIR" in
  /*) ;;
  *) fail "FIDUCIA_HETZNER_E2E_STATE_DIR must be an absolute path" ;;
esac
mkdir -p "$STATE_DIR" "$STATE_DIR/plans" "$STATE_DIR/terraform-data"
chmod 700 "$STATE_DIR" "$STATE_DIR/plans" "$STATE_DIR/terraform-data"
STATE_DIR=$(cd "$STATE_DIR" && pwd -P)
case "$STATE_DIR" in
  "$REPO_ROOT"|"$REPO_ROOT"/*) fail "Terraform state must remain outside $REPO_ROOT" ;;
esac

STATE_FILE="$STATE_DIR/terraform.tfstate"
export TF_DATA_DIR="$STATE_DIR/terraform-data"
umask 077

terraform_init() {
  terraform -chdir="$TF_ROOT" init -reconfigure -input=false \
    -backend-config="path=$STATE_FILE"
}

require_token() {
  test -n "${HCLOUD_TOKEN:-}" || fail "HCLOUD_TOKEN must name the isolated Hetzner test project"
}

require_tfvars() {
  test -f "$TFVARS" || fail "copy terraform.tfvars.example to $TFVARS and edit it first"
  local tfvars_dir canonical_tfvars
  tfvars_dir=$(cd "$(dirname "$TFVARS")" && pwd -P)
  canonical_tfvars="$tfvars_dir/$(basename "$TFVARS")"
  case "$canonical_tfvars" in
    "$REPO_ROOT"|"$REPO_ROOT"/*) fail "tfvars must remain outside the repository" ;;
  esac
}

command=${1:-}
case "$command" in
  init)
    terraform_init
    ;;
  plan)
    require_token
    require_tfvars
    terraform_init
    plan_file=${2:-"$STATE_DIR/plans/create.tfplan"}
    case "$plan_file" in "$STATE_DIR"/*) ;; *) fail "saved plan must be below $STATE_DIR" ;; esac
    terraform -chdir="$TF_ROOT" plan -input=false -lock-timeout=5m \
      -var-file="$TFVARS" "${TF_ENABLE_ARGS[@]}" -out="$plan_file"
    printf 'review with: terraform -chdir=%q show %q\n' "$TF_ROOT" "$plan_file"
    ;;
  apply)
    require_token
    plan_file=${2:-}
    test -n "$plan_file" && test -f "$plan_file" || fail "apply requires an existing saved plan"
    case "$plan_file" in "$STATE_DIR"/*) ;; *) fail "saved plan must be below $STATE_DIR" ;; esac
    test "${FIDUCIA_CONFIRM_APPLY:-}" = "apply-hetzner-e2e" || \
      fail "set FIDUCIA_CONFIRM_APPLY=apply-hetzner-e2e after reviewing the saved plan"
    terraform_init
    terraform -chdir="$TF_ROOT" apply -input=false -lock-timeout=5m "$plan_file"
    ;;
  plan-destroy)
    require_token
    require_tfvars
    terraform_init
    plan_file=${2:-"$STATE_DIR/plans/destroy.tfplan"}
    case "$plan_file" in "$STATE_DIR"/*) ;; *) fail "saved plan must be below $STATE_DIR" ;; esac
    terraform -chdir="$TF_ROOT" plan -destroy -input=false -lock-timeout=5m \
      -var-file="$TFVARS" "${TF_ENABLE_ARGS[@]}" -out="$plan_file"
    printf 'destroy has NOT run; review with: terraform -chdir=%q show %q\n' "$TF_ROOT" "$plan_file"
    ;;
  apply-destroy)
    require_token
    plan_file=${2:-}
    test -n "$plan_file" && test -f "$plan_file" || fail "apply-destroy requires an existing saved destroy plan"
    case "$plan_file" in "$STATE_DIR"/*) ;; *) fail "saved plan must be below $STATE_DIR" ;; esac
    test "${FIDUCIA_CONFIRM_DESTROY:-}" = "destroy-hetzner-e2e" || \
      fail "set FIDUCIA_CONFIRM_DESTROY=destroy-hetzner-e2e after reviewing the saved destroy plan"
    terraform_init
    terraform -chdir="$TF_ROOT" apply -input=false -lock-timeout=5m "$plan_file"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
