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
  source                  = "../../modules/gke"
  count                   = var.enable_gcp ? 1 : 0
  cluster_name            = "fiducia-e2e-gcp"
  location                = "us-central1"
  project_id              = var.gcp_project_id
  node_count              = var.node_count
  labels                  = local.labels
  deletion_protection     = var.gcp_deletion_protection
  enable_private_cluster  = var.gcp_enable_private_cluster
  enable_private_endpoint = var.gcp_enable_private_endpoint
  master_ipv4_cidr_block  = var.gcp_master_ipv4_cidr_block
  authorized_api_cidrs    = var.gcp_authorized_api_cidrs
  enable_network_policy   = var.gcp_enable_network_policy
}

module "aws" {
  source                  = "../../modules/eks"
  count                   = var.enable_aws ? 1 : 0
  cluster_name            = "fiducia-e2e-aws"
  location                = "us-east-1"
  node_count              = var.node_count
  labels                  = local.labels
  subnet_ids              = var.aws_subnet_ids
  endpoint_public_access  = var.aws_endpoint_public_access
  endpoint_private_access = var.aws_endpoint_private_access
  authorized_api_cidrs    = var.aws_authorized_api_cidrs
}

module "azure" {
  source                = "../../modules/aks"
  count                 = var.enable_azure ? 1 : 0
  cluster_name          = "fiducia-e2e-azure"
  location              = "eastus"
  node_count            = var.node_count
  labels                = local.labels
  authorized_api_cidrs  = var.azure_authorized_api_cidrs
  enable_network_policy = var.azure_enable_network_policy
}

module "hetzner" {
  source                 = "../../modules/hetzner"
  count                  = var.enable_hetzner ? 1 : 0
  cluster_name           = "fiducia-e2e-hetzner"
  location               = "nbg1"
  node_count             = var.node_count
  ssh_public_key         = var.hetzner_ssh_public_key
  labels                 = local.labels
  enable_firewall        = var.hetzner_enable_firewall
  firewall_allowed_cidrs = var.hetzner_firewall_allowed_cidrs
}
