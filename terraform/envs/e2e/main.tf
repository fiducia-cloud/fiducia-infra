# fiducia e2e fleet — instantiates each cloud module behind an enable_<cloud> toggle.
# Cluster names/regions mirror ../../topology.toml so the deployed clusters line up
# with the kustomize overlays in ../../clusters and the endpoints below feed
# fiducia-e2e's FIDUCIA_E2E_ENDPOINTS.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google  = { source = "hashicorp/google", version = "~> 6.0" }
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    hcloud  = { source = "hetznercloud/hcloud", version = "~> 1.48" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

# Credentials come from each provider's standard env/CLI auth (ADC, AWS_*, az login,
# HCLOUD_TOKEN). Region for AWS is set here to match the aws module's `location`.
provider "google" {
  project = var.gcp_project_id
  region  = "us-central1"
}
provider "aws" {
  region = "us-east-1"
}
provider "azurerm" {
  features {}
}
provider "hcloud" {}
provider "random" {}

locals {
  labels = { project = "fiducia", env = "e2e", managed_by = "terraform" }
}

module "gcp" {
  source       = "../../modules/gke"
  count        = var.enable_gcp ? 1 : 0
  cluster_name = "fiducia-e2e-gcp"
  location     = "us-central1"
  project_id   = var.gcp_project_id
  node_count   = var.node_count
  labels       = local.labels
}

module "aws" {
  source       = "../../modules/eks"
  count        = var.enable_aws ? 1 : 0
  cluster_name = "fiducia-e2e-aws"
  location     = "us-east-1"
  node_count   = var.node_count
  labels       = local.labels
}

module "azure" {
  source       = "../../modules/aks"
  count        = var.enable_azure ? 1 : 0
  cluster_name = "fiducia-e2e-azure"
  location     = "eastus"
  node_count   = var.node_count
  labels       = local.labels
}

module "hetzner" {
  source         = "../../modules/hetzner"
  count          = var.enable_hetzner ? 1 : 0
  cluster_name   = "fiducia-e2e-hetzner"
  location       = "nbg1"
  node_count     = var.node_count
  ssh_public_key = var.hetzner_ssh_public_key
  labels         = local.labels
}
