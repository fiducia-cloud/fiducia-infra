# Shared emulator resources

These manifests adapt the production base for the local three-Kind-cluster
environment. They expose the node and brain peer ports, apply emulator-specific
patches, and preserve the network-policy intent needed by policy-aware local
CNIs.

Provider overlays in `../hetzner`, `../vultr`, and `../civo` import this
directory. Keep cross-cluster behavior here when it must remain identical in all
three members; provider identity and generated peer values belong in the
individual overlays.
