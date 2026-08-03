#!/usr/bin/env bash
# Capture a redacted, read-only host evidence packet. The output intentionally
# excludes serial numbers, MAC addresses, IP addresses, public endpoints, keys,
# tokens, environment variables, Kubernetes Secrets, and file contents.
set -euo pipefail
umask 077

cluster=""
output=""
allow_unprivileged="false"

usage() {
  cat <<'EOF'
usage:
  sudo scripts/capture-laptop-host-evidence.sh \
    --cluster laptop-aws-sim \
    --output /secure/evidence/laptop-aws-sim-host.json

Use --allow-unprivileged only for a preliminary packet; production evidence must
be captured as root so disk, Secure Boot, firewall, and service checks are not
silently incomplete.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --allow-unprivileged) allow_unprivileged="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$cluster" in
  laptop-aws-sim|laptop-gcp-sim|laptop-azure-sim) ;;
  *) fail "--cluster must name one of the three laptop identities" ;;
esac
[[ -n "$output" ]] || fail "--output is required"
[[ "$output" = /* ]] || fail "--output must be an absolute path"
[[ "$allow_unprivileged" == "true" || "$EUID" -eq 0 ]] \
  || fail "production evidence capture must run as root"

for command in awk date df findmnt grep hostname jq lsblk nproc sha256sum ss stat systemctl uname; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

mkdir -p "$(dirname "$output")"
[[ ! -L "$output" ]] || fail "refusing to overwrite a symlink: $output"
temporary="$(mktemp "${output}.tmp.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

json_string() {
  jq -Rn --arg value "$1" '$value'
}

service_state() {
  local unit="$1"
  jq -n \
    --arg enabled "$(systemctl is-enabled "$unit" 2>/dev/null || true)" \
    --arg active "$(systemctl is-active "$unit" 2>/dev/null || true)" \
    '{enabled: $enabled, active: $active}'
}

read_integer_file() {
  local file="$1"
  if [[ -r "$file" ]]; then
    tr -dc '0-9' <"$file"
  fi
}

os_id="unknown"
os_version="unknown"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  os_id="${ID:-unknown}"
  os_version="${VERSION_ID:-unknown}"
fi

memory_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
memory_mib="$((memory_kib / 1024))"
root_source="$(findmnt -n -o SOURCE / || true)"
root_source="${root_source%%[*}"
root_type="$(lsblk -n -o TYPE "$root_source" 2>/dev/null | head -n1 || true)"
root_fstype="$(findmnt -n -o FSTYPE / || true)"
root_used_percent="$(df --output=pcent / | tail -n1 | tr -dc '0-9')"

secure_boot_state="unknown"
if command -v mokutil >/dev/null; then
  secure_boot_output="$(mokutil --sb-state 2>/dev/null || true)"
  if grep -qi 'SecureBoot enabled' <<<"$secure_boot_output"; then
    secure_boot_state="enabled"
  elif grep -qi 'SecureBoot disabled' <<<"$secure_boot_output"; then
    secure_boot_state="disabled"
  fi
fi

tpm_present="false"
[[ -e /dev/tpmrm0 || -e /dev/tpm0 ]] && tpm_present="true"

battery_present="false"
battery_health_percent="null"
battery_cycle_count="null"
for battery in /sys/class/power_supply/BAT*; do
  [[ -d "$battery" ]] || continue
  battery_present="true"
  energy_full="$(read_integer_file "$battery/energy_full")"
  energy_design="$(read_integer_file "$battery/energy_full_design")"
  if [[ -z "$energy_full" || -z "$energy_design" ]]; then
    energy_full="$(read_integer_file "$battery/charge_full")"
    energy_design="$(read_integer_file "$battery/charge_full_design")"
  fi
  if [[ -n "$energy_full" && -n "$energy_design" && "$energy_design" -gt 0 ]]; then
    battery_health_percent="$(awk -v full="$energy_full" -v design="$energy_design" 'BEGIN { printf "%.2f", (full / design) * 100 }')"
  fi
  cycles="$(read_integer_file "$battery/cycle_count")"
  [[ -n "$cycles" ]] && battery_cycle_count="$cycles"
  break
done

k3s_config=/etc/rancher/k3s/config.yaml
k3s_exists="false"
k3s_mode="null"
k3s_sha256="null"
k3s_node_match="false"
k3s_secret_encryption="false"
k3s_snapshot_secret="false"
k3s_servicelb_disabled="false"
k3s_traefik_disabled="false"
if [[ -f "$k3s_config" ]]; then
  k3s_exists="true"
  k3s_mode="$(stat -c '%a' "$k3s_config")"
  k3s_sha256="$(sha256sum "$k3s_config" | awk '{print $1}')"
  grep -Eq "^node-name:[[:space:]]*$cluster$" "$k3s_config" && k3s_node_match="true"
  grep -Eq '^secrets-encryption:[[:space:]]*true$' "$k3s_config" && k3s_secret_encryption="true"
  grep -Eq '^etcd-s3-config-secret:[[:space:]]*k3s-etcd-snapshot-s3-config$' "$k3s_config" && k3s_snapshot_secret="true"
  grep -Eq '^[[:space:]]*-[[:space:]]*servicelb$' "$k3s_config" && k3s_servicelb_disabled="true"
  grep -Eq '^[[:space:]]*-[[:space:]]*traefik$' "$k3s_config" && k3s_traefik_disabled="true"
fi

firewall_backend="unknown"
firewall_ruleset_sha256="null"
firewall_rule_lines="null"
if command -v nft >/dev/null; then
  firewall_backend="nftables"
  rules="$(nft list ruleset 2>/dev/null || true)"
  if [[ -n "$rules" ]]; then
    firewall_ruleset_sha256="$(printf '%s' "$rules" | sha256sum | awk '{print $1}')"
    firewall_rule_lines="$(printf '%s\n' "$rules" | wc -l | tr -d ' ')"
  fi
elif command -v iptables-save >/dev/null; then
  firewall_backend="iptables"
  rules="$(iptables-save 2>/dev/null || true)"
  if [[ -n "$rules" ]]; then
    firewall_ruleset_sha256="$(printf '%s' "$rules" | sha256sum | awk '{print $1}')"
    firewall_rule_lines="$(printf '%s\n' "$rules" | wc -l | tr -d ' ')"
  fi
fi

# Record only protocol and port, not listening addresses or owning processes.
listening_ports="$(
  ss -H -lntu \
    | awk '{endpoint=$5; sub(/^.*:/, "", endpoint); print tolower(substr($1,1,3)) ":" endpoint}' \
    | grep -E '^(tcp|udp):[0-9]+$' \
    | sort -u \
    | jq -Rsc 'split("\n") | map(select(length > 0))'
)"

interfaces="$(
  for interface in /sys/class/net/*; do
    name="$(basename "$interface")"
    [[ "$name" == "lo" ]] && continue
    state="unknown"
    [[ -r "$interface/operstate" ]] && state="$(cat "$interface/operstate")"
    jq -nc --arg name "$name" --arg state "$state" '{name: $name, state: $state}'
  done | jq -sc 'sort_by(.name)'
)"

disks="$(
  lsblk -J -b -o NAME,PATH,TYPE,SIZE,ROTA,TRAN,FSTYPE,MOUNTPOINTS \
    | jq '[.blockdevices[] | {name, path, type, sizeBytes: .size, rotational: .rota, transport: .tran, filesystem: .fstype, mountpoints}]'
)"

jq -n \
  --argjson schemaVersion 1 \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg clusterName "$cluster" \
  --arg hostname "$(hostname --short)" \
  --arg osId "$os_id" \
  --arg osVersion "$os_version" \
  --arg kernel "$(uname -r)" \
  --arg architecture "$(uname -m)" \
  --argjson logicalCpuCount "$(nproc)" \
  --argjson memoryMiB "$memory_mib" \
  --arg rootSourceType "$root_type" \
  --arg rootFilesystem "$root_fstype" \
  --argjson rootUsedPercent "$root_used_percent" \
  --arg secureBoot "$secure_boot_state" \
  --argjson tpmPresent "$tpm_present" \
  --argjson batteryPresent "$battery_present" \
  --argjson batteryHealthPercent "$battery_health_percent" \
  --argjson batteryCycleCount "$battery_cycle_count" \
  --argjson disks "$disks" \
  --argjson interfaces "$interfaces" \
  --arg firewallBackend "$firewall_backend" \
  --argjson firewallRulesetSha256 "$firewall_ruleset_sha256" \
  --argjson firewallRuleLines "$firewall_rule_lines" \
  --argjson listeningPorts "$listening_ports" \
  --argjson sshd "$(service_state sshd.service)" \
  --argjson tailscaled "$(service_state tailscaled.service)" \
  --argjson smartd "$(service_state smartd.service)" \
  --argjson timesyncd "$(service_state systemd-timesyncd.service)" \
  --argjson k3s "$(service_state k3s.service)" \
  --argjson k3sConfigExists "$k3s_exists" \
  --argjson k3sConfigMode "$k3s_mode" \
  --argjson k3sConfigSha256 "$k3s_sha256" \
  --argjson k3sNodeMatch "$k3s_node_match" \
  --argjson k3sSecretEncryption "$k3s_secret_encryption" \
  --argjson k3sSnapshotSecret "$k3s_snapshot_secret" \
  --argjson k3sServiceLbDisabled "$k3s_servicelb_disabled" \
  --argjson k3sTraefikDisabled "$k3s_traefik_disabled" \
  '{
    schemaVersion: $schemaVersion,
    evidenceMode: "local-capture",
    capturedAt: $capturedAt,
    clusterName: $clusterName,
    hostname: $hostname,
    os: {id: $osId, version: $osVersion, kernel: $kernel, architecture: $architecture},
    capacity: {logicalCpuCount: $logicalCpuCount, memoryMiB: $memoryMiB},
    root: {sourceType: $rootSourceType, filesystem: $rootFilesystem, usedPercent: $rootUsedPercent},
    firmware: {secureBoot: $secureBoot, tpmPresent: $tpmPresent},
    battery: {present: $batteryPresent, healthPercent: $batteryHealthPercent, cycleCount: $batteryCycleCount},
    disks: $disks,
    network: {interfaces: $interfaces, listeningProtocolPorts: $listeningPorts},
    firewall: {backend: $firewallBackend, rulesetSha256: $firewallRulesetSha256, ruleLines: $firewallRuleLines},
    services: {sshd: $sshd, tailscaled: $tailscaled, smartd: $smartd, timesyncd: $timesyncd, k3s: $k3s},
    k3sConfig: {
      exists: $k3sConfigExists,
      mode: $k3sConfigMode,
      sha256: $k3sConfigSha256,
      nodeIdentityMatches: $k3sNodeMatch,
      secretEncryption: $k3sSecretEncryption,
      snapshotSecret: $k3sSnapshotSecret,
      serviceLbDisabled: $k3sServiceLbDisabled,
      traefikDisabled: $k3sTraefikDisabled
    },
    redaction: {
      serialNumbers: "excluded",
      macAddresses: "excluded",
      ipAddresses: "excluded",
      publicEndpoints: "excluded",
      credentials: "excluded",
      environment: "excluded",
      kubernetesSecrets: "excluded",
      rawFirewallRules: "hashed-not-stored"
    }
  }' >"$temporary"

chmod 600 "$temporary"
mv -f "$temporary" "$output"
trap - EXIT
printf 'wrote redacted host evidence: %s\n' "$output"
