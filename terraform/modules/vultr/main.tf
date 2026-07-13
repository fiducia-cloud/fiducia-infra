# Vultr "cluster" for a fiducia failure domain.
# Unlike the Hetzner module (k3s on raw hcloud servers), Vultr offers managed
# Kubernetes (VKE), so this is a single managed cluster + one worker node pool.
# The module INTERFACE (inputs cluster_name/region/node_count/..., outputs
# name/endpoint/ca_certificate/kubeconfig_hint) matches every other provider
# module, so a cluster can be swapped between providers by pointing its stanza at
# a different module — nothing else changes. Requires VULTR_API_KEY in the env.

terraform {
  required_version = ">= 1.5"
  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.21"
    }
  }
}

resource "vultr_kubernetes" "this" {
  label   = var.cluster_name
  region  = var.region
  version = var.k8s_version

  node_pools {
    node_quantity = var.node_count
    plan          = var.plan
    label         = "${var.cluster_name}-workers"
    auto_scaler   = false
    tag           = try(var.labels["fiducia.cloud/role"], "fiducia-node")
  }
}
