{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fiducia.laptopHost;
  inherit (lib) mkEnableOption mkIf mkOption optionals types;

  audit = pkgs.writeShellApplication {
    name = "fiducia-laptop-host-audit";
    runtimeInputs = with pkgs; [
      coreutils
      gnugrep
      gnused
      systemd
      util-linux
    ];
    text = ''
      set -euo pipefail
      umask 077

      failures=0
      check() {
        local message="$1"
        shift
        if "$@"; then
          printf 'PASS %s\n' "$message"
        else
          printf 'FAIL %s\n' "$message" >&2
          failures=$((failures + 1))
        fi
      }

      config_file=/etc/rancher/k3s/config.yaml
      check "K3s config exists" test -f "$config_file"
      if [[ -f "$config_file" ]]; then
        mode="$(stat -c '%a' "$config_file")"
        check "K3s config is root-private" test "$mode" = 600
        check "K3s node identity matches this appliance" grep -Eq '^node-name:[[:space:]]*${cfg.clusterName}$' "$config_file"
        check "Kubernetes secret encryption is enabled" grep -Eq '^secrets-encryption:[[:space:]]*true$' "$config_file"
        check "K3s ServiceLB is disabled" grep -Eq '^[[:space:]]*-[[:space:]]*servicelb$' "$config_file"
        check "Bundled Traefik is disabled" grep -Eq '^[[:space:]]*-[[:space:]]*traefik$' "$config_file"
        check "S3 snapshot config is Secret-backed" grep -Eq '^etcd-s3-config-secret:[[:space:]]*k3s-etcd-snapshot-s3-config$' "$config_file"
      fi

      check "OpenSSH is enabled" systemctl is-enabled --quiet sshd.service
      check "Tailscale is enabled" systemctl is-enabled --quiet tailscaled.service
      check "SMART monitoring is enabled" systemctl is-enabled --quiet smartd.service
      check "Time synchronization is enabled" systemctl is-enabled --quiet systemd-timesyncd.service

      root_source="$(findmnt -n -o SOURCE / || true)"
      root_type="$(lsblk -n -o TYPE "$root_source" 2>/dev/null | head -n1 || true)"
      check "Root filesystem is backed by a dm-crypt mapping" test "$root_type" = crypt

      disk_used="$(df --output=pcent / | tail -n1 | tr -dc '0-9')"
      check "Root disk is below critical utilization" test "$disk_used" -lt ${toString cfg.diskCriticalPercent}

      mkdir -p /var/lib/fiducia-host-audit
      {
        printf 'FIDUCIA_HOST_AUDIT_CLUSTER=%q\n' '${cfg.clusterName}'
        printf 'FIDUCIA_HOST_AUDIT_FAILURES=%q\n' "$failures"
        printf 'FIDUCIA_HOST_AUDIT_EPOCH=%q\n' "$(date +%s)"
        printf 'FIDUCIA_HOST_DISK_USED_PERCENT=%q\n' "$disk_used"
      } > /var/lib/fiducia-host-audit/status.env

      if ((failures > 0)); then
        exit 1
      fi
    '';
  };
in
{
  options.fiducia.laptopHost = {
    enable = mkEnableOption "the dedicated Fiducia laptop production-appliance baseline";

    clusterName = mkOption {
      type = types.enum [
        "laptop-aws-sim"
        "laptop-gcp-sim"
        "laptop-azure-sim"
      ];
      description = "Stable Fiducia laptop cluster and host identity.";
    };

    operatorUser = mkOption {
      type = types.strMatching "[a-z_][a-z0-9_-]{0,31}";
      description = "Existing non-root operator account allowed to use SSH.";
    };

    meshInterface = mkOption {
      type = types.strMatching "[a-zA-Z0-9_.-]{1,15}";
      default = "tailscale0";
      description = "Private management interface receiving SSH and K3s API access.";
    };

    enableThermald = mkOption {
      type = types.bool;
      default = pkgs.stdenv.hostPlatform.isx86;
      description = "Enable thermald on supported x86 laptop hardware.";
    };

    diskWarningPercent = mkOption {
      type = types.ints.between 60 75;
      default = 70;
      description = "Warning threshold mirrored into inventory and monitoring.";
    };

    diskCriticalPercent = mkOption {
      type = types.ints.between 80 90;
      default = 85;
      description = "Critical disk threshold enforced by the host audit.";
    };

    wireGuardFallback = {
      enable = mkEnableOption "a separately provisioned plain WireGuard recovery interface";
      interface = mkOption {
        type = types.strMatching "[a-zA-Z0-9_.-]{1,15}";
        default = "wg-fiducia";
        description = "WireGuard fallback interface name; private keys are managed outside Nix.";
      };
      listenPort = mkOption {
        type = types.port;
        default = 51820;
        description = "Narrow host UDP port used only when the fallback is enabled.";
      };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.operatorUser != "root";
        message = "fiducia.laptopHost.operatorUser must be a non-root account";
      }
      {
        assertion = cfg.diskWarningPercent < cfg.diskCriticalPercent;
        message = "Fiducia disk warning threshold must be below the critical threshold";
      }
    ];

    networking.hostName = lib.mkDefault cfg.clusterName;
    networking.firewall = {
      enable = true;
      allowPing = false;
      allowedTCPPorts = [ ];
      allowedUDPPorts = optionals cfg.wireGuardFallback.enable [ cfg.wireGuardFallback.listenPort ];
      interfaces.${cfg.meshInterface}.allowedTCPPorts = [
        22
        6443
      ];
    };

    services.openssh = {
      enable = true;
      openFirewall = false;
      settings = {
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
        PermitRootLogin = "no";
        AllowUsers = [ cfg.operatorUser ];
        X11Forwarding = false;
        AllowAgentForwarding = false;
        AllowTcpForwarding = false;
        PermitTunnel = false;
      };
    };

    services.tailscale.enable = true;
    services.smartd = {
      enable = true;
      autodetect = true;
    };
    services.fstrim.enable = true;
    services.timesyncd.enable = true;
    services.thermald.enable = cfg.enableThermald;

    services.logind.settings.Login = {
      HandleLidSwitch = "ignore";
      HandleLidSwitchExternalPower = "ignore";
      HandleLidSwitchDocked = "ignore";
      IdleAction = "ignore";
    };

    environment.etc."systemd/sleep.conf.d/90-fiducia-laptop.conf".text = ''
      [Sleep]
      AllowSuspend=no
      AllowHibernation=no
      AllowSuspendThenHibernate=no
      AllowHybridSleep=no
    '';

    systemd.settings.Manager = {
      RuntimeWatchdogSec = "60s";
      RebootWatchdogSec = "10min";
    };

    boot.kernel.sysctl = {
      "kernel.dmesg_restrict" = 1;
      "kernel.kptr_restrict" = 2;
      "fs.protected_hardlinks" = 1;
      "fs.protected_symlinks" = 1;
      "net.ipv4.conf.all.accept_redirects" = 0;
      "net.ipv4.conf.default.accept_redirects" = 0;
      "net.ipv4.conf.all.send_redirects" = 0;
      "net.ipv4.conf.default.send_redirects" = 0;
      "net.ipv6.conf.all.accept_redirects" = 0;
      "net.ipv6.conf.default.accept_redirects" = 0;
    };

    security.sudo.wheelNeedsPassword = true;
    system.autoUpgrade.enable = false;
    nix.settings.auto-optimise-store = true;
    nix.gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 14d";
    };

    environment.systemPackages = with pkgs; [
      ethtool
      jq
      lm_sensors
      nvme-cli
      smartmontools
      tailscale
      wireguard-tools
    ];

    systemd.services.fiducia-laptop-host-audit = {
      description = "Audit the dedicated Fiducia laptop host baseline";
      after = [
        "local-fs.target"
        "network-online.target"
      ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${audit}/bin/fiducia-laptop-host-audit";
        User = "root";
        Group = "root";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ "/var/lib/fiducia-host-audit" ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        LockPersonality = true;
        RestrictSUIDSGID = true;
        MemoryDenyWriteExecute = true;
      };
    };

    systemd.timers.fiducia-laptop-host-audit = {
      description = "Run the Fiducia laptop host audit every 15 minutes";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "5min";
        OnUnitActiveSec = "15min";
        RandomizedDelaySec = "30s";
        Persistent = true;
      };
    };
  };
}
