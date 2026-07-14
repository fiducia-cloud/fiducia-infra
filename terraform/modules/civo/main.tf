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
# We create the rules explicitly, sourced from var.allowed_cidrs, and reject
# world-open (mirrors the hetzner firewall contract).
resource "civo_firewall" "this" {
  name                 = "${var.cluster_name}-fw"
  region               = var.region
  network_id           = civo_network.this.id
  create_default_rules = false

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

# Kubernetes API server.
resource "civo_firewall_rule" "api" {
  firewall_id = civo_firewall.this.id
  protocol    = "tcp"
  start_port  = "6443"
  end_port    = "6443"
  cidr        = var.allowed_cidrs
  direction   = "ingress"
  label       = "k8s-api"
}

# NodePort range (kept for the LB / cross-cluster mesh reachability).
resource "civo_firewall_rule" "nodeports" {
  firewall_id = civo_firewall.this.id
  protocol    = "tcp"
  start_port  = "30000"
  end_port    = "32767"
  cidr        = var.allowed_cidrs
  direction   = "ingress"
  label       = "nodeports"
}
