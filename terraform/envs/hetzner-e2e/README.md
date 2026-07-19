# Optional future Hetzner E2E fleet — three additional k3s servers

> **Disabled by default.** The current test plan creates zero new machines and
> uses three isolated vClusters on the existing five-node Hetzner kubeadm
> cluster. Follow [`../../../vcluster/hetzner-e2e`](../../../vcluster/hetzner-e2e)
> for the supported path. The wrapper for this Terraform root refuses to run
> unless an operator explicitly opts into creating three additional servers.
> Terraform itself also expands to zero resources unless both
> `enable_optional_new_servers=true` and the exact
> `new_server_creation_confirmation` are supplied.

This Terraform root creates exactly three disposable, single-node k3s clusters:
`hetzner-fsn1`, `hetzner-nbg1`, and `hetzner-hel1`. They share one isolated
private HCloud network only for Fiducia peer traffic. Each member has its own
k3s API server, datastore, cluster UID, and failure-domain identity.

This optional environment must never target, delete, or repurpose the existing
`dd-k8s-*` five-node kubeadm cluster. Its future purpose is to upgrade the proof
from logical isolation to three physically independent Kubernetes clusters.

## Current blocker

The last audited `dd-hetzner` provision attempt reported a five-server quota with
five existing servers. Do not work around that by deleting or repurposing
`dd-k8s-*`. Revisit this profile only with approved additional capacity or a
dedicated `fiducia-e2e` Hetzner project and token.

## Security boundary

- Terraform state and tfvars live outside the checkout under
  `~/.local/state/fiducia/hetzner-e2e` by default.
- The state contains k3s server/agent tokens. Back up and protect it as a secret.
- Public ingress is default-denied. Only SSH and `:6443` are allowed from the
  explicit `operator_cidrs` list.
- NodePorts are private. The operator reaches each plaintext test LB through an
  SSH tunnel; fixed local-emulator secrets must never be used here.
- `expires_on` is a mandatory review marker, not an auto-destroy mechanism.

Use the guarded scripts documented in `../../../k3s/hetzner-e2e/README.md`.
No CI job applies or destroys this environment.
