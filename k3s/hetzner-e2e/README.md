# Optional future three-VM Hetzner profile

This directory contains the workload topology for three physically independent,
single-node k3s clusters in FSN1, NBG1, and HEL1. It is retained as a future
upgrade from the shared-host proof, **not** as the current operator path.

The supported zero-new-server proof uses
[`../../vcluster/hetzner-e2e`](../../vcluster/hetzner-e2e). The Terraform,
kubeconfig-fetch, tunnel, and deploy wrappers for this directory all refuse to
run unless the operator sets the exact opt-in
`FIDUCIA_ENABLE_OPTIONAL_NEW_SERVERS=create-three-additional-hetzner-servers`.
The Terraform root independently defaults to zero resources and requires a
second exact confirmation. No CI job applies this profile.

Revisit it only after approved capacity exists in a dedicated Hetzner test
project or quota has been raised. Never delete, resize, or repurpose the existing
`dd-k8s-*` host cluster to make room. Its Terraform state, credentials, rendered
releases, kubeconfigs, and evidence must remain outside Git under the guarded
external state directory.

The checked-in overlays and renderer remain CI-validated so this future path
does not silently rot, but validation creates no cloud resources.
