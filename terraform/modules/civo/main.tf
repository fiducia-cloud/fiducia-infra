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
  name               = var.cluster_name
  region             = var.region
  network_id         = civo_network.this.id
  cni                = var.cni
  kubernetes_version = var.k8s_version
  firewall_id        = civo_firewall.this.id
  tags               = join(" ", [for k, v in var.labels : "${k}:${v}"])

  pools {
    label      = "${var.cluster_name}-workers"
    size       = var.node_size
    node_count = var.node_count
    labels     = var.labels
  }
}

# Firewall for the cluster. create_default_rules=true would open the k8s API
# (6443), 80/443 and the whole NodePort range to 0.0.0.0/0 — unacceptable on a
# production cluster and, unlike hetzner/the hyperscalers, civo had no CIDR knob.
# Rules are declared INLINE (the civo provider has no separate firewall_rule
# resource), sourced from var.allowed_cidrs, and world-open is rejected below
# (mirrors the hetzner firewall contract). Unmatched traffic is dropped, so with
# no default rules egress needs explicit allows or image pulls / provider APIs /
# mesh peers break.
resource "civo_firewall" "this" {
  name                 = "${var.cluster_name}-fw"
  region               = var.region
  network_id           = civo_network.this.id
  create_default_rules = false

  ingress_rule {
    label      = "k8s-api"
    protocol   = "tcp"
    port_range = "6443"
    cidr       = var.allowed_cidrs
    action     = "allow"
  }
  ingress_rule {
    label      = "nodeports"
    protocol   = "tcp"
    port_range = "30000-32767" # LB + cross-cluster mesh reachability
    cidr       = var.allowed_cidrs
    action     = "allow"
  }

  lifecycle {
    precondition {
      condition = (
        length(var.allowed_cidrs) > 0 &&
        !contains(var.allowed_cidrs, "0.0.0.0/0") &&
        !contains(var.allowed_cidrs, "::/0")
      )
      error_message = "civo module requires explicit restricted allowed_cidrs; world-open (0.0.0.0/0 / ::/0) is rejected."
    }
  }
}
