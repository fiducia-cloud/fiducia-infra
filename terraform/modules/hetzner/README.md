# modules/hetzner — Hetzner k3s "cluster"

Terraform module for a fiducia failure domain on Hetzner Cloud. Hetzner has no managed
Kubernetes in the core provider, so this brings up hcloud servers and installs **k3s via
cloud-init** (one control-plane + N agents). Honors the shared module contract (see
`../../README.md`) so the e2e env treats every cloud uniformly. e2e/test-grade baseline —
for production prefer kube-hetzner or a managed offering and harden firewall/private network.
