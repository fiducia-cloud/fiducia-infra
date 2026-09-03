terraform {
  required_version = ">= 1.5.7"

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
  }
}

provider "azurerm" {
  features {}
}

variable "image_repository_name" {
  description = "Cloud-portable OCI repository name. Keep it lowercase and stable across registries."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._/-]*[a-z0-9]$", var.image_repository_name))
    error_message = "image_repository_name must be lowercase and contain only letters, digits, dots, underscores, slashes, or hyphens."
  }
}

variable "enable_aws_ecr" {
  description = "Create an AWS ECR private repository."
  type        = bool
  default     = false
}

variable "enable_gcp_artifact_registry" {
  description = "Create a Google Artifact Registry Docker repository."
  type        = bool
  default     = false
}

variable "enable_azure_container_registry" {
  description = "Create an Azure Container Registry."
  type        = bool
  default     = false
}

variable "gcp_project_id" {
  description = "GCP project that owns Artifact Registry. Required when enable_gcp_artifact_registry is true."
  type        = string
  default     = ""
}

variable "gcp_location" {
  description = "Artifact Registry location, for example us-central1."
  type        = string
  default     = "us-central1"
}

variable "gcp_repository_id" {
  description = "Optional Artifact Registry repository ID. Defaults to image_repository_name with slashes replaced by hyphens."
  type        = string
  default     = ""
}

variable "gcp_immutable_tags" {
  description = "Prevent an existing Artifact Registry image tag from being moved."
  type        = bool
  default     = true
}

variable "azure_resource_group_name" {
  description = "Existing Azure resource group for ACR. Required when enable_azure_container_registry is true."
  type        = string
  default     = ""
}

variable "azure_location" {
  description = "Azure region for ACR."
  type        = string
  default     = "eastus"
}

variable "azure_registry_name" {
  description = "Globally unique alphanumeric ACR name. Required when enable_azure_container_registry is true."
  type        = string
  default     = ""
}

variable "azure_sku" {
  description = "Azure Container Registry SKU."
  type        = string
  default     = "Basic"

  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.azure_sku)
    error_message = "azure_sku must be Basic, Standard, or Premium."
  }
}

variable "dockerhub_namespace" {
  description = "Optional Docker Hub organization/user namespace. Docker Hub is authenticated and pushed by scripts/publish-oci.sh."
  type        = string
  default     = ""
}

variable "r2_bucket" {
  description = "Optional Cloudflare R2 bucket for immutable OCI archive backups; R2 is not used as a live registry endpoint."
  type        = string
  default     = ""
}

variable "r2_endpoint_url" {
  description = "Optional R2 S3 endpoint. Keep credentials outside Terraform and source control."
  type        = string
  default     = ""
}

variable "aws_untagged_image_keep_count" {
  description = "Number of untagged ECR images to retain."
  type        = number
  default     = 20

  validation {
    condition     = var.aws_untagged_image_keep_count >= 1
    error_message = "aws_untagged_image_keep_count must be at least 1."
  }
}

variable "common_tags" {
  description = "Non-secret ownership and cost-allocation tags."
  type        = map(string)
  default = {
    "managed-by" = "terraform"
    workload     = "oci-registry"
  }
}

locals {
  gcp_repository_id = var.gcp_repository_id != "" ? var.gcp_repository_id : replace(var.image_repository_name, "/", "-")
}

resource "aws_ecr_repository" "this" {
  count = var.enable_aws_ecr ? 1 : 0

  name                 = var.image_repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = var.common_tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  count = var.enable_aws_ecr ? 1 : 0

  repository = aws_ecr_repository.this[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the newest untagged images and expire older build leftovers"
      selection = {
        tagStatus   = "untagged"
        countType   = "imageCountMoreThan"
        countNumber = var.aws_untagged_image_keep_count
      }
      action = {
        type = "expire"
      }
    }]
  })
}

resource "google_artifact_registry_repository" "this" {
  count = var.enable_gcp_artifact_registry ? 1 : 0

  project       = var.gcp_project_id
  location      = var.gcp_location
  repository_id = local.gcp_repository_id
  description   = "OCI/Docker images for ${var.image_repository_name}"
  format        = "DOCKER"

  docker_config {
    immutable_tags = var.gcp_immutable_tags
  }

  labels = var.common_tags

  lifecycle {
    precondition {
      condition     = !var.enable_gcp_artifact_registry || trimspace(var.gcp_project_id) != ""
      error_message = "gcp_project_id is required when enable_gcp_artifact_registry is true."
    }
  }
}

resource "azurerm_container_registry" "this" {
  count = var.enable_azure_container_registry ? 1 : 0

  name                = var.azure_registry_name != "" ? var.azure_registry_name : "disabledregistry"
  resource_group_name = var.azure_resource_group_name != "" ? var.azure_resource_group_name : "disabled"
  location            = var.azure_location
  sku                 = var.azure_sku
  admin_enabled       = false
  tags                = var.common_tags

  lifecycle {
    precondition {
      condition = !var.enable_azure_container_registry || (
        trimspace(var.azure_resource_group_name) != "" &&
        can(regex("^[A-Za-z0-9]{5,50}$", var.azure_registry_name))
      )
      error_message = "azure_resource_group_name and a globally unique 5-50 character alphanumeric azure_registry_name are required when enable_azure_container_registry is true."
    }
  }
}

output "aws_ecr_repository_url" {
  description = "AWS ECR push/deploy URL."
  value       = try(aws_ecr_repository.this[0].repository_url, null)
}

output "gcp_artifact_registry_docker_prefix" {
  description = "Google Artifact Registry Docker prefix."
  value = var.enable_gcp_artifact_registry ? (
    "${var.gcp_location}-docker.pkg.dev/${var.gcp_project_id}/${local.gcp_repository_id}"
  ) : null
}

output "azure_container_registry_login_server" {
  description = "Azure Container Registry login server."
  value       = try(azurerm_container_registry.this[0].login_server, null)
}

output "dockerhub_repository" {
  description = "Docker Hub image repository assembled for the publish script."
  value       = var.dockerhub_namespace != "" ? "${var.dockerhub_namespace}/${var.image_repository_name}" : null
}

output "r2_oci_archive_prefix" {
  description = "S3 URI used for OCI archive backups after a successful registry push."
  value       = var.r2_bucket != "" ? "s3://${var.r2_bucket}/oci/${var.image_repository_name}" : null
}
