# terraform — provisioning real independent clusters

This is the **physical-cluster tier** of the fiducia test/deploy infrastructure: Infrastructure-as-Code
that stands up the actual Kubernetes clusters the multi-cluster topology
runs on. (Tier 1 — ephemeral local `kind` clusters for CI conformance/chaos runs
that need no cloud spend — lives in [`../kind`](../kind); the zero-new-server
Hetzner proof tier lives in [`../vcluster/hetzner-e2e`](../vcluster/hetzner-e2e).)

> **The kustomize overlays in [`../clusters`](../clusters) assume the clusters
> already exist.** This directory is how they come to exist. `terraform` provisions
> the clusters + node pools; `kustomize` deploys fiducia onto them; the
> [`topology.toml`](../topology.toml) endpoints wire them together.

## Layout

```
terraform/
  modules/                 one dir per provider — SAME interface, so a cluster's
                           cloud is a drop-in swap (see "Swapping a provider")
    hetzner/   Hetzner — hcloud servers + k3s via cloud-init (no managed k8s there)
    vultr/     Vultr   — vultr_kubernetes (managed VKE)
    civo/      Civo    — civo_kubernetes_cluster (managed k3s, Cilium CNI)
    gke/       Google  — google_container_cluster + node pool     ┐ additional
    eks/       AWS     — aws_eks_cluster + managed node group      │ drop-in swap
    aks/       Azure   — azurerm_kubernetes_cluster                ┘ targets
  envs/
    prod/      THE 3-cluster prod fleet — hetzner + vultr + civo (node_count 5),
               each behind an enable_<cloud> toggle → see envs/prod/README.md
    e2e/       real-hyperscaler TEST fleet (gke/eks/aks/hetzner, node_count 3) for
               the fiducia-e2e suite; emits kubeconfigs + LB endpoints
    hetzner-e2e/ OPTIONAL FUTURE fleet of three additional single-node Hetzner
                 k3s clusters; disabled while the existing-host vCluster path is used
```

The **prod** fleet mirrors [`../topology.toml`](../topology.toml)
(hetzner/vultr/civo); the **e2e** fleet exists to exercise the same manifests on
managed hyperscalers. Because every module shares one interface, swapping a prod
cluster to another cloud (DigitalOcean/Scaleway/Akamai/…) is a `source =` change,
not a rewrite — see **Swapping a provider** below.

Every module honors the **same variable/output contract** so the env can treat
them uniformly:

| Variable        | Meaning                                             |
|-----------------|-----------------------------------------------------|
| `cluster_name`  | cluster id (e.g. `fiducia-e2e-gcp`)                 |
| `location`      | region/zone (matches the cluster's `region` in topology.toml) |
| `node_count`    | worker machines (e2e modules default 3; the prod trio defaults **5** — topology `node_replicas`=5, one node pod per machine) |
| `k8s_version`   | Kubernetes minor (e.g. `1.30`)                      |
| `labels`        | tags/labels applied to cluster + nodes              |

| Output            | Meaning                                           |
|-------------------|---------------------------------------------------|
| `name`            | provisioned cluster name                          |
| `endpoint`        | API server URL                                    |
| `ca_certificate`  | base64 cluster CA (for kubeconfig)                |
| `kubeconfig_hint` | one-line command to fetch a kubeconfig for this cluster |

## Cost & safety

- These modules are **e2e/test-grade baselines**, not turnkey hardened prod.
  They favor the smallest footprint that runs fiducia (RF=3 → ≥3 schedulable
  nodes ideal). Provider hardening controls are wired below; the Hetzner
  firewall is secure-by-default while several managed-cloud controls remain
  opt-in for compatibility. Node
  auto-repair/upgrade and remote state locking remain review items.
- **`terraform apply` here spends real money and creates real infrastructure.**
  It is never run in CI. CI validates with `terraform fmt -check` + `terraform
  validate` only (see the infra CI workflow). Real-cloud e2e is an operator-run,
  `workflow_dispatch`-gated job.
- Remote state: `envs/e2e/backend.tf.example` shows an S3/GCS backend with locking.
  Do not commit real state; the default local state is for throwaway runs only.

## Provisioning the prod fleet

The production 3-cluster fleet (hetzner + vultr + civo) lives in
[`envs/prod`](envs/prod) and has its own runbook — see
[`envs/prod/README.md`](envs/prod/README.md). In short:

```sh
export HCLOUD_TOKEN=…  VULTR_API_KEY=…  CIVO_TOKEN=…
cd terraform/envs/prod
terraform init && terraform apply \
  -var 'hetzner_ssh_public_key=ssh-ed25519 AAAA…' \
  -var 'hetzner_firewall_allowed_cidrs=["203.0.113.0/24"]'
```

Then register the three kubeconfigs, run
[`../../tools/clustermesh.sh`](../tools/clustermesh.sh) to stitch them into a
Cilium Cluster Mesh, set `topology.toml`'s `*_endpoint`s to the mesh global-service
DNS, `node ../../tools/render.mjs`, and let ArgoCD sync the overlays. Full picture:
[`../docs/multi-cluster-architecture.md`](../docs/multi-cluster-architecture.md).

## Swapping a provider

Every module honors the **same variable/output contract** (above), so a cluster's
cloud is a `source =` change, not a rewrite. To move a prod cluster (say
vultr → digitalocean):

1. add `modules/digitalocean` implementing the contract (copy the shape of
   `modules/vultr`; drop-in targets: digitalocean, scaleway, akamai/LKE, or the
   `gke`/`eks`/`aks` modules already here);
2. in `envs/prod/main.tf`, point `module "vultr"`'s `source` at it and set its
   `region`;
3. update that cluster's `platform` + `region` in [`../topology.toml`](../topology.toml);
4. `terraform apply`, then re-point its `*_endpoint` and `node ../../tools/render.mjs`.

Nothing in [`../base`](../base) or the app code changes — the platform only decides
where the VMs live and the `storage_class` name.

## Provisioning the e2e fleet

```sh
cd terraform/envs/e2e
cp terraform.tfvars.example terraform.tfvars   # fill in project ids, credentials source
terraform init
terraform apply -var enable_gcp=true -var enable_aws=true -var enable_azure=true -var enable_hetzner=true
# then, per cluster, fetch a kubeconfig (see each module's kubeconfig_hint output)
# and deploy fiducia:  kubectl --context <ctx> apply -k ../../clusters/<cloud>
terraform output endpoints    # the FIDUCIA_E2E_ENDPOINTS list for fiducia-e2e
```

Toggle any subset with the `enable_*` vars — e.g. bring up only GCP+AWS+Hetzner as
a real-hyperscaler test fleet, or add `enable_azure=true` for a 4th failure domain.
(The real prod trio is hetzner/vultr/civo in `envs/prod`, above.)

## Provider hardening controls

Each module exposes explicit hardening inputs. The `envs/e2e` environment threads
them through as `<cloud>_<name>` variables. Hetzner now fails closed with its
firewall enabled by default, requires restricted operator CIDRs, and exposes no
public NodePorts. Several managed-cloud inputs retain test-compatible defaults,
so review the complete plan before production use:

> **In `envs/prod`** the hetzner firewall is the relevant knob and defaults **on**
> (`hetzner_enable_firewall = true`), so you must pass `hetzner_firewall_allowed_cidrs`
> (world-open is rejected). Vultr VKE and Civo are managed control planes, so their
> API-server hardening is provider-side, not a module input. The rows below are the
> full catalog across every module (prod trio + hyperscaler swap targets).

| Module | Variable (module → `envs/e2e`) | Default (e2e) | Set for prod |
|--------|--------------------------------|---------------|--------------|
| `eks` | `subnet_ids` → `aws_subnet_ids` | `[]` → account **default VPC** subnets | dedicated/private VPC subnet ids |
| `eks` | `endpoint_public_access` → `aws_endpoint_public_access` | `true` | `false` (private-only, with private subnets) |
| `eks` | `endpoint_private_access` → `aws_endpoint_private_access` | `false` | `true` |
| `eks` | `authorized_api_cidrs` → `aws_authorized_api_cidrs` | `[]` → `0.0.0.0/0` | operator/admin CIDRs |
| `gke` | `deletion_protection` → `gcp_deletion_protection` | `false` | `true` |
| `gke` | `enable_private_cluster` → `gcp_enable_private_cluster` | `false` | `true` (uses `master_ipv4_cidr_block`, and `enable_private_endpoint`) |
| `gke` | `authorized_api_cidrs` → `gcp_authorized_api_cidrs` | `[]` → unrestricted | operator/admin CIDRs (master authorized networks) |
| `gke` | `enable_network_policy` → `gcp_enable_network_policy` | `false` | `true` (Calico dataplane enforcement) |
| `aks` | `authorized_api_cidrs` → `azure_authorized_api_cidrs` | `[]` → open | operator/admin CIDRs (`api_server_access_profile`) |
| `aks` | `enable_network_policy` → `azure_enable_network_policy` | `false` | `true` (`network_plugin=azure`, `network_policy=azure`) |
| `hetzner` | `enable_firewall` → `hetzner_enable_firewall` | `true` → default-deny public ingress | keep `true`; restricted SSH/`:6443` only |
| `hetzner` | `firewall_allowed_cidrs` → `hetzner_firewall_allowed_cidrs` | `[]` | **required** when `enable_firewall=true` — explicit restricted operator/mesh CIDRs (world-open `0.0.0.0/0`·`::/0` is rejected) |

Example — a hardened GCP + Hetzner pair from the e2e env:

```sh
terraform apply \
  -var enable_gcp=true \
  -var gcp_deletion_protection=true \
  -var gcp_enable_private_cluster=true \
  -var 'gcp_authorized_api_cidrs=["203.0.113.0/24"]' \
  -var gcp_enable_network_policy=true \
  -var enable_hetzner=true \
  -var hetzner_enable_firewall=true \
  -var 'hetzner_firewall_allowed_cidrs=["203.0.113.0/24","10.10.0.0/16"]'
```

Enabling `gke`/`aks` `enable_network_policy` (or running a CNI with a policy
dataplane) is what makes the fiducia `NetworkPolicy` default-deny actually
enforced. The Kubernetes `NetworkPolicy` objects in `../base` are only enforced by
a CNI that implements them: GKE/AKS need `enable_network_policy` (or an equivalent
dataplane); EKS needs the VPC-CNI network-policy feature or Cilium; the Hetzner
k3s baseline needs a policy-capable CNI (the topology's declared Cilium).
