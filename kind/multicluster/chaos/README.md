# Chaos manifest

`networkchaos.yaml` is the optional Chaos Mesh fault definition for the local
three-cluster emulator. It complements the host-driven `netem.sh` and
`partition.sh` scenarios when a test environment already has Chaos Mesh
installed.

Do not apply this manifest to production clusters. Keep selectors scoped to the
emulator's `fiducia` namespace and confirm the fault has been removed before
interpreting post-recovery results.
