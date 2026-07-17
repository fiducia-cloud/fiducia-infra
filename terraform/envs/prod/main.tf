# fiducia PROD fleet — the three failure domains from ../../topology.toml
# (hetzner + vultr + civo), each behind an enable_<cloud> toggle. Cluster
# names/regions mirror topology.toml so the deployed clusters line up with the
# kustomize overlays in ../../clusters.
#
# node_count defaults to 1 (STARTER TIER, mirrors topology node_replicas = 1):
# one big worker machine per cloud carrying node + brain + LB + observability.
# Hetzner is k3s on raw VMs, so its cluster is node_count workers + 1 small
# control-plane VM; Vultr (VKE) and Civo control planes are provider-managed.
# Full design = node_count 5 (one-node-pod-per-machine anti-affinity ⇒ >= 5
# workers); the brain member may share a machine with a node.
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
  source                 = "../../modules/hetzner"
  count                  = var.enable_hetzner ? 1 : 0
  cluster_name           = "fiducia-prod-hetzner"
  location               = "nbg1"
  network_zone           = "eu-central"
  node_count             = var.node_count
  server_type            = var.hetzner_server_type
  ssh_public_key         = var.hetzner_ssh_public_key
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
  labels       = local.labels
}

# ── civo (brain member) — managed k3s, Cilium CNI for Cluster Mesh ────────────
module "civo" {
  source        = "../../modules/civo"
  count         = var.enable_civo ? 1 : 0
  cluster_name  = "fiducia-prod-civo"
  region        = "LON1"
  node_count    = var.node_count
  cni           = "cilium"
  allowed_cidrs = var.civo_allowed_cidrs
  labels        = local.labels
}
