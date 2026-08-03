#!/usr/bin/env bash
# Restore one single-node laptop K3s control plane from a verified local snapshot.
# The S3 Secret cannot be used while the API server is down, so operators must
# first retrieve the selected snapshot through an independently audited path.
set -euo pipefail
umask 077

cluster=""
snapshot=""
expected_sha256=""
token_file=""
apply="false"
ack_stop="false"
ack_reset="false"
ack_replace="false"

usage() {
  cat <<'EOF'
usage:
  sudo scripts/restore-laptop-k3s-snapshot.sh \
    --cluster laptop-aws-sim \
    --snapshot /secure/restore/etcd-snapshot \
    --snapshot-sha256 <64-character-sha256> \
    --token-file /secure/restore/k3s-server-token \
    [--ack-stop-k3s --ack-cluster-reset --ack-replace-cluster-state --apply]

Without --apply this validates the files and prints a redacted recovery plan.
The restore uses a local snapshot and --etcd-s3=false so no S3 credential is put
on the restore command line. The original server token is required to decrypt
bootstrap data contained in the snapshot.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --snapshot) snapshot="${2:-}"; shift 2 ;;
    --snapshot-sha256) expected_sha256="${2:-}"; shift 2 ;;
    --token-file) token_file="${2:-}"; shift 2 ;;
    --ack-stop-k3s) ack_stop="true"; shift ;;
    --ack-cluster-reset) ack_reset="true"; shift ;;
    --ack-replace-cluster-state) ack_replace="true"; shift ;;
    --apply) apply="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$cluster" in
  laptop-aws-sim|laptop-gcp-sim|laptop-azure-sim) ;;
  *) fail "--cluster must name one of the three laptop clusters" ;;
esac
[[ -f "$snapshot" && ! -L "$snapshot" && -s "$snapshot" ]] || fail "snapshot must be a non-empty regular file"
[[ "$expected_sha256" =~ ^[0-9a-fA-F]{64}$ ]] || fail "--snapshot-sha256 must contain 64 hexadecimal characters"
[[ -f "$token_file" && ! -L "$token_file" && -s "$token_file" ]] || fail "token file must be a non-empty regular file"

mode="$(stat -c '%a' "$token_file")"
(( (8#$mode & 8#077) == 0 )) || fail "token file must not be group/world accessible (mode $mode)"
actual_sha256="$(sha256sum "$snapshot" | awk '{print $1}')"
[[ "$actual_sha256" == "${expected_sha256,,}" ]] || fail "snapshot checksum mismatch"

config="/etc/rancher/k3s/config.yaml"
if [[ -f "$config" ]]; then
  grep -Eq "^node-name:[[:space:]]*$cluster$" "$config" \
    || fail "$config does not declare node-name $cluster"
fi
[[ ! -e /var/lib/rancher/k3s/server/db/reset-flag ]] \
  || fail "K3s reset-flag already exists; investigate the previous reset before continuing"

cat <<EOF
validated K3s restore plan
  cluster: $cluster
  snapshot: $(basename "$snapshot")
  snapshot sha256: ${expected_sha256,,}
  token: redacted file input
  action: stop K3s, restore local snapshot, reset single-member etcd, restart K3s
EOF

[[ "$apply" == "true" ]] || exit 0
[[ "$EUID" -eq 0 ]] || fail "--apply must run as root"
[[ "$ack_stop" == "true" ]] || fail "--apply requires --ack-stop-k3s"
[[ "$ack_reset" == "true" ]] || fail "--apply requires --ack-cluster-reset"
[[ "$ack_replace" == "true" ]] || fail "--apply requires --ack-replace-cluster-state"
command -v systemctl >/dev/null || fail "systemctl is required"
command -v k3s >/dev/null || fail "k3s is required"

systemctl stop k3s
k3s server \
  --cluster-reset \
  --cluster-reset-restore-path="$snapshot" \
  --etcd-s3=false \
  --token-file="$token_file"
systemctl start k3s

for _attempt in $(seq 1 60); do
  if systemctl is-active --quiet k3s; then
    echo "K3s restored and active for $cluster; proceed with node cleanup, GitOps reconciliation, and DEN-946 restore validation"
    exit 0
  fi
  sleep 2
done

systemctl status k3s --no-pager >&2 || true
fail "K3s did not become active after restore"
