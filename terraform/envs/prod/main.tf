# fiducia PROD fleet — the three failure domains from ../../topology.toml
# (hetzner + vultr + civo), each behind an enable_<cloud> toggle. Cluster
# names/regions mirror topology.toml so the deployed clusters line up with the
# kustomize overlays in ../../clusters.
#
# node_count defaults to 1 — the single-VM-per-cloud bootstrap (topology
# node_replicas = 1): one machine per cluster runs node + brain + load-balance
# + otel together, so it must be big — see hetzner_server_type / vultr_plan /
# civo_node_size in variables.tf (>= 4 vCPU / 16 GB, 8 vCPU preferred). The
# one-node-pod-per-machine anti-affinity means node_count must track topology
# node_replicas when scaling up (full design = 5). On hetzner the schedulable
# k3s control plane counts as that machine (agents = node_count - 1); vultr and
# civo have provider-managed control planes, so node_count is the VM count.
#
# ── Swapping a provider ──────────────────────────────────────────────────────
# Every module shares one interface (cluster_name/region/node_count → name/
# endpoint/ca_certificate/kubeconfig). To move, say, vultr → digitalocean:
# change module "vultr"'s `source` to ../../modules/digitalocean, set its region,
# update topology.toml's platform + region for that cluster, re-apply, re-render.
# Nothing in ../../base or the app changes. See ../../README.md and
# ../../docs/multi-cluster-architecture.md.

terraform {
  required_version = ">= 1.5"
  required_providers {
    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.48" }
    vultr  = { source = "vultr/vultr", version = "~> 2.21" }
    civo   = { source = "civo/civo", version = "~> 1.1" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

# Credentials come from each provider's standard env auth:
#   HCLOUD_TOKEN, VULTR_API_KEY, CIVO_TOKEN.
provider "hcloud" {}
provider "vultr" {}
provider "civo" {
  region = "LON1"
}
provider "random" {}

locals {
  labels = { project = "fiducia", env = "prod", managed_by = "terraform" }
}

# ── hetzner (brain member) — k3s on raw VMs ──────────────────────────────────
module "hetzner" {
<<<<<<< HEAD
  source                 = "../../modules/hetzner"
  count                  = var.enable_hetzner ? 1 : 0
  cluster_name           = "fiducia-prod-hetzner"
  location               = "nbg1"
  network_zone           = "eu-central"
  node_count             = var.node_count
  server_type            = var.hetzner_server_type
=======
  source       = "../../modules/hetzner"
  count        = var.enable_hetzner ? 1 : 0
  cluster_name = "fiducia-prod-hetzner"
  location     = "nbg1"
  network_zone = "eu-central"
  # The k3s control plane is schedulable and counts as one of the node_count
  # machines, so agents = node_count - 1 (node_count = 1 ⇒ a single server).
  node_count             = var.node_count - 1
  cni                    = "cilium" # topology connectivity = clustermesh needs Cilium; install it before first use (see module NOTE)
>>>>>>> origin/main
  ssh_public_key         = var.hetzner_ssh_public_key
  ssh_key_name           = var.hetzner_ssh_key_name
  labels                 = local.labels
  enable_firewall        = var.hetzner_enable_firewall
  firewall_allowed_cidrs = var.hetzner_firewall_allowed_cidrs
}

# ── vultr (brain member) — managed VKE ───────────────────────────────────────
module "vultr" {
  source       = "../../modules/vultr"
  count        = var.enable_vultr ? 1 : 0
  cluster_name = "fiducia-prod-vultr"
  region       = "fra"
  node_count   = var.node_count
  plan         = var.vultr_plan
  labels       = local.labels
}

# ── civo (brain member) — managed k3s, Cilium CNI for Cluster Mesh ────────────
module "civo" {
  source        = "../../modules/civo"
  count         = var.enable_civo ? 1 : 0
  cluster_name  = "fiducia-prod-civo"
  region        = "LON1"
  node_count    = var.node_count
  node_size     = var.civo_node_size
  cni           = "cilium"
  allowed_cidrs = var.civo_allowed_cidrs
  labels        = local.labels
}
