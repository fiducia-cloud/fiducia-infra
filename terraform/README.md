# terraform — provisioning the real managed clusters

This is **Tier 2** of the fiducia test/deploy infrastructure: Infrastructure-as-Code
that stands up the actual managed Kubernetes clusters the multi-cluster topology
runs on. (Tier 1 — ephemeral local `kind` clusters for CI conformance/chaos runs
that need no cloud spend — lives in [`../kind`](../kind).)

> **The kustomize overlays in [`../clusters`](../clusters) assume the clusters
> already exist.** This directory is how they come to exist. `terraform` provisions
> the clusters + node pools; `kustomize` deploys fiducia onto them; the
> [`topology.toml`](../topology.toml) endpoints wire them together.

## Layout

```
terraform/
  modules/
    gke/       Google  — google_container_cluster + node pool
    eks/       AWS     — aws_eks_cluster + managed node group (default VPC)
    aks/       Azure   — azurerm_kubernetes_cluster
    hetzner/   Hetzner — hcloud servers + k3s via cloud-init (no managed k8s there)
  envs/
    e2e/       instantiates all four (each behind an enable_<cloud> toggle) and
               emits the kubeconfigs + LB endpoints that feed topology.toml
```

Every module honors the **same variable/output contract** so the env can treat
them uniformly:

| Variable        | Meaning                                             |
|-----------------|-----------------------------------------------------|
| `cluster_name`  | cluster id (e.g. `fiducia-e2e-gcp`)                 |
| `location`      | region/zone (matches the cluster's `region` in topology.toml) |
| `node_count`    | worker node count (default 3 — one fiducia-node replica can schedule per node) |
| `k8s_version`   | Kubernetes minor (e.g. `1.30`)                      |
| `labels`        | tags/labels applied to cluster + nodes              |

| Output            | Meaning                                           |
|-------------------|---------------------------------------------------|
| `name`            | provisioned cluster name                          |
| `endpoint`        | API server URL                                    |
| `ca_certificate`  | base64 cluster CA (for kubeconfig)                |
| `kubeconfig_hint` | one-line command to fetch a kubeconfig for this cluster |

## Cost & safety

- These modules are **e2e/test-grade baselines**, not hardened prod. They favor
  the smallest footprint that runs fiducia (RF=3 → ≥3 schedulable nodes ideal).
  Review before any long-lived use: private endpoints, network policy, node
  auto-repair/upgrade, and remote state locking are called out inline as TODO.
- **`terraform apply` here spends real money and creates real infrastructure.**
  It is never run in CI. CI validates with `terraform fmt -check` + `terraform
  validate` only (see the infra CI workflow). Real-cloud e2e is an operator-run,
  `workflow_dispatch`-gated job.
- Remote state: `envs/e2e/backend.tf.example` shows an S3/GCS backend with locking.
  Do not commit real state; the default local state is for throwaway runs only.

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

Toggle any subset with the `enable_*` vars — e.g. bring up only GCP+AWS+Hetzner to
mirror the original 3-cluster prod baseline, or add `enable_azure=true` for the
4th failure domain.
