terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.0"
    }
  }
}

variable "repository_name" {
  description = "OCI repository name used by ECR and Artifact Registry."
  type        = string
  default     = "fiducia"
}

variable "enable_aws_ecr" {
  description = "Create a private AWS ECR repository."
  type        = bool
  default     = false
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "enable_gcp_artifact_registry" {
  description = "Create a GCP Artifact Registry Docker repository."
  type        = bool
  default     = false
}

variable "gcp_project_id" {
  description = "GCP project that owns Artifact Registry. Required when enabled."
  type        = string
  default     = null
  nullable    = true
}

variable "gcp_location" {
  type    = string
  default = "us-central1"
}

variable "enable_azure_acr" {
  description = "Create an Azure Container Registry."
  type        = bool
  default     = false
}

variable "azure_subscription_id" {
  description = "Azure subscription ID. May also be supplied through ARM_SUBSCRIPTION_ID."
  type        = string
  default     = null
  nullable    = true
}

variable "azure_location" {
  type    = string
  default = "East US"
}

variable "azure_resource_group_name" {
  type    = string
  default = "fiducia-oci"
}

variable "create_azure_resource_group" {
  type    = bool
  default = true
}

variable "azure_registry_name" {
  description = "Globally unique, lowercase alphanumeric ACR name (5-50 characters)."
  type        = string
  default     = "fiduciaoci"

  validation {
    condition     = can(regex("^[a-z0-9]{5,50}$", var.azure_registry_name))
    error_message = "azure_registry_name must be 5-50 lowercase alphanumeric characters."
  }
}

variable "enable_cloudflare_r2_archive" {
  description = "Create an R2 bucket for OCI-layout archives/build cache; R2 is not a native pull-through container registry."
  type        = bool
  default     = false
}

variable "cloudflare_account_id" {
  type        = string
  default     = null
  nullable    = true
  description = "Cloudflare account ID. Required when the R2 archive bucket is enabled."
}

variable "r2_bucket_name" {
  type    = string
  default = "fiducia-oci-archive"
}

provider "aws" {
  region = var.aws_region
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_location
}

provider "azurerm" {
  features {}
  subscription_id = var.azure_subscription_id
}

provider "cloudflare" {}

check "gcp_project_is_set" {
  assert {
    condition     = !var.enable_gcp_artifact_registry || var.gcp_project_id != null
    error_message = "gcp_project_id is required when enable_gcp_artifact_registry is true."
  }
}

check "cloudflare_account_is_set" {
  assert {
    condition     = !var.enable_cloudflare_r2_archive || var.cloudflare_account_id != null
    error_message = "cloudflare_account_id is required when enable_cloudflare_r2_archive is true."
  }
}

resource "aws_ecr_repository" "this" {
  count = var.enable_aws_ecr ? 1 : 0

  name                 = var.repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    ManagedBy = "terraform"
    Purpose   = "oci-images"
  }
}

resource "google_artifact_registry_repository" "this" {
  count = var.enable_gcp_artifact_registry ? 1 : 0

  project       = var.gcp_project_id
  location      = var.gcp_location
  repository_id = var.repository_name
  description   = "OCI images for fiducia"
  format        = "DOCKER"

  docker_config {
    immutable_tags = true
  }

  labels = {
    managed_by = "terraform"
    purpose    = "oci-images"
  }
}

resource "azurerm_resource_group" "oci" {
  count = var.enable_azure_acr && var.create_azure_resource_group ? 1 : 0

  name     = var.azure_resource_group_name
  location = var.azure_location

  tags = {
    ManagedBy = "terraform"
    Purpose   = "oci-images"
  }
}

locals {
  azure_resource_group_name = var.create_azure_resource_group ? azurerm_resource_group.oci[0].name : var.azure_resource_group_name
}

resource "azurerm_container_registry" "this" {
  count = var.enable_azure_acr ? 1 : 0

  name                          = var.azure_registry_name
  resource_group_name           = local.azure_resource_group_name
  location                      = var.azure_location
  sku                           = "Basic"
  admin_enabled                 = false
  public_network_access_enabled = true

  tags = {
    ManagedBy = "terraform"
    Purpose   = "oci-images"
  }
}

resource "cloudflare_r2_bucket" "oci_archive" {
  count = var.enable_cloudflare_r2_archive ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name
}

output "aws_ecr_repository_url" {
  value = try(aws_ecr_repository.this[0].repository_url, null)
}

output "gcp_artifact_registry_repository" {
  value = try(google_artifact_registry_repository.this[0].name, null)
}

output "azure_container_registry_login_server" {
  value = try(azurerm_container_registry.this[0].login_server, null)
}

output "cloudflare_r2_archive_bucket" {
  value = try(cloudflare_r2_bucket.oci_archive[0].name, null)
}
