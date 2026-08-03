# Import this function from the real host configuration with concrete values.
# Hardware configuration, disk layout, operator user creation, SSH public keys,
# K3s package/version pinning, Tailscale OAuth, and WireGuard private keys remain
# separate deployment inputs and must not be copied into this repository.
{
  clusterName,
  operatorUser,
  enableThermald ? true,
  enableWireGuardFallback ? false,
  wireGuardListenPort ? 51820,
}:
{
  imports = [ ../modules/fiducia-laptop-host.nix ];

  fiducia.laptopHost = {
    enable = true;
    inherit clusterName operatorUser enableThermald;
    meshInterface = "tailscale0";
    diskWarningPercent = 70;
    diskCriticalPercent = 85;
    wireGuardFallback = {
      enable = enableWireGuardFallback;
      interface = "wg-fiducia";
      listenPort = wireGuardListenPort;
    };
  };
}
