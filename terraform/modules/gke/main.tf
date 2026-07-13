# GKE cluster for a fiducia failure domain (Google Cloud).
# e2e/test-grade baseline — see terraform/README.md "Cost & safety".
#
# Prod-hardening is OPT-IN via variables that all DEFAULT to this e2e behavior
# (see variables.tf): var.deletion_protection, var.enable_private_cluster,
# var.authorized_api_cidrs and var.enable_network_policy. Existing e2e applies
# that pass none of these are unchanged.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

# Regional cluster with a separately-managed node pool (the recommended pattern:
# remove the default pool so node config is fully declared here).
resource "google_container_cluster" "this" {
  name     = var.cluster_name
  location = var.location
  project  = var.project_id

  remove_default_node_pool = true
  initial_node_count       = 1
  # e2e clusters are disposable so this defaults false; set var.deletion_protection
  # = true to guard prod clusters from `terraform destroy`.
  deletion_protection = var.deletion_protection

  min_master_version = var.k8s_version
  resource_labels    = var.labels

  # Prod-hardening, all opt-in and defaulted off so e2e behavior is unchanged:
  #  - private_cluster_config      → private nodes / endpoint (var.enable_private_cluster)
  #  - master_authorized_networks  → restrict API access     (var.authorized_api_cidrs)
  #  - network_policy              → intra-cluster L3/L4 enforcement (var.enable_network_policy)
  dynamic "private_cluster_config" {
    for_each = var.enable_private_cluster ? [1] : []
    content {
      enable_private_nodes    = true
      enable_private_endpoint = var.enable_private_endpoint
      master_ipv4_cidr_block  = var.master_ipv4_cidr_block
    }
  }

  dynamic "master_authorized_networks_config" {
    for_each = length(var.authorized_api_cidrs) > 0 ? [1] : []
    content {
      dynamic "cidr_blocks" {
        for_each = var.authorized_api_cidrs
        content {
          cidr_block   = cidr_blocks.value
          display_name = "authorized-${cidr_blocks.key}"
        }
      }
    }
  }

  dynamic "network_policy" {
    for_each = var.enable_network_policy ? [1] : []
    content {
      enabled  = true
      provider = "CALICO"
    }
  }

  # GKE requires both enforcement and the network-policy add-on. Keeping the
  # two blocks behind the same flag prevents a half-enabled cluster that accepts
  # NetworkPolicy objects but does not enforce them.
  dynamic "addons_config" {
    for_each = var.enable_network_policy ? [1] : []
    content {
      network_policy_config {
        disabled = false
      }
    }
  }

  release_channel {
    channel = "REGULAR"
  }

  lifecycle {
    precondition {
      condition     = !var.enable_private_endpoint || var.enable_private_cluster
      error_message = "enable_private_endpoint requires enable_private_cluster."
    }
  }
}

resource "google_container_node_pool" "primary" {
  name     = "${var.cluster_name}-np"
  cluster  = google_container_cluster.this.name
  location = var.location
  project  = var.project_id

  node_count = var.node_count

  node_config {
    machine_type = var.machine_type
    labels       = var.labels
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}
