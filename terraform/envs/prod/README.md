# terraform/envs/prod — the 3-cluster production fleet

Instantiates the three failure domains from `../../topology.toml`:

| Cluster | Module | Kind | Brain member |
| --- | --- | --- | --- |
| hetzner | `../../modules/hetzner` | k3s on raw hcloud VMs | yes |
| vultr | `../../modules/vultr` | managed VKE | yes |
| civo | `../../modules/civo` | managed k3s (Cilium CNI) | yes |

Each provisions **one machine** (`node_count = 1`, the single-VM-per-cloud
bootstrap matching topology `node_replicas = 1`): that machine runs the
`fiducia-node` pod, the `fiducia-brain` member, `fiducia-load-balance` and the
otel agent together. On hetzner the schedulable k3s control plane *is* the
machine (agents = `node_count - 1`); vultr/civo control planes are
provider-managed. To scale a cluster out, raise `node_count` and topology
`node_replicas` together — the required one-node-pod-per-machine anti-affinity
places each `fiducia-node` pod on its own machine.

## Apply

```sh
export HCLOUD_TOKEN=…  VULTR_API_KEY=…  CIVO_TOKEN=…
cd terraform/envs/prod
terraform init
terraform apply \
  -var 'hetzner_ssh_public_key=ssh-ed25519 AAAA…' \
  -var 'hetzner_firewall_allowed_cidrs=["203.0.113.0/24"]'
```

Then: fetch each kubeconfig (see `terraform output`), register the three
contexts, run `../../tools/clustermesh.sh` to stitch them into a Cilium Cluster
Mesh, set `topology.toml`'s `*_endpoint` values to the mesh global-service DNS,
`node ../../tools/render.mjs`, and let ArgoCD (`../../argocd`) sync the overlays.
Full runbook: `../../docs/ROLLOUT.md` and `../../docs/multi-cluster-architecture.md`.

## Swapping a provider

Point a module's `source` at a different provider module (same interface) and
update that cluster's `platform`/`region` in `topology.toml`. Drop-in targets
live under `../../modules/` (add `digitalocean`/`scaleway`/`akamai` from the
templates in `../../README.md`). Nothing in `../../base` or the app changes.
