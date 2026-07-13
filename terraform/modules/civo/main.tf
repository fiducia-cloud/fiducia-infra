# Civo "cluster" for a fiducia failure domain.
# Civo offers managed Kubernetes (k3s under the hood), so this is a single
# managed cluster + one worker pool. Note `cni = cilium`: Cluster Mesh (the
# topology's default cross-cluster connectivity) requires Cilium, and Civo lets
# you select it at creation. The module INTERFACE matches every other provider
# module, so a cluster is swappable by re-pointing its env stanza. Requires
# CIVO_TOKEN in the env.

terraform {
  required_version = ">= 1.5"
  required_providers {
    civo = {
      source  = "civo/civo"
      version = "~> 1.1"
    }
  }
}

resource "civo_network" "this" {
  label = "${var.cluster_name}-net"
}

resource "civo_kubernetes_cluster" "this" {
  name       = var.cluster_name
  region     = var.region
  network_id = civo_network.this.id
  cni        = var.cni
  firewall_id = civo_firewall.this.id

  pools {
    label      = "${var.cluster_name}-workers"
    size       = var.node_size
    node_count = var.node_count
  }
}

resource "civo_firewall" "this" {
  name                 = "${var.cluster_name}-fw"
  region               = var.region
  network_id           = civo_network.this.id
  create_default_rules = true
}
