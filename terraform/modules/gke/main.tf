# GKE cluster for a fiducia failure domain (Google Cloud).
# e2e/test-grade baseline — see terraform/README.md "Cost & safety".

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
  deletion_protection      = false # e2e clusters are disposable; TODO: true for prod

  min_master_version = var.k8s_version
  resource_labels    = var.labels

  # TODO(prod): private_cluster_config + master_authorized_networks; network_policy.
  release_channel {
    channel = "REGULAR"
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
