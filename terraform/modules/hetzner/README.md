# modules/hetzner — Hetzner k3s "cluster"

Terraform module for a fiducia failure domain on Hetzner Cloud. Hetzner has no managed
Kubernetes in the core provider, so this brings up hcloud servers and installs **k3s via
cloud-init** (one control-plane + N agents). Honors the shared module contract (see
`../../README.md`) so the e2e env treats every cloud uniformly. The official k3s
installer and k3s release are pinned, its checksum is verified before execution,
the public firewall defaults on, and public NodePorts default off. It remains an
e2e/test-grade baseline; for production prefer kube-hetzner or a reviewed managed
offering and use dedicated private networking.

The current Hetzner locks/leases proof creates **no servers** and instead uses
[`../../../vcluster/hetzner-e2e`](../../../vcluster/hetzner-e2e). The optional
`terraform/envs/hetzner-e2e` root uses this module only if future physically
independent test capacity is approved.
