terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 8.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.0, < 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.19, < 6.0"
    }
  }
}

# Every provider authenticates through its standard environment variables,
# workload identity, or an operator-selected local profile. No credentials are
# accepted as Terraform variables because variables, plans, and state are not
# secret stores.
provider "aws" {
  region = var.aws_region
}

provider "google" {
  project = var.gcp_project != "" ? var.gcp_project : null
}

provider "azurerm" {
  features {}
}

provider "cloudflare" {}

variable "registry_name" {
  description = "Portable repository identifier shared by ECR and Artifact Registry."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.registry_name))
    error_message = "registry_name must be 3-63 lowercase alphanumeric or hyphen characters."
  }
}

variable "aws_enabled" {
  type    = bool
  default = false
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "gcp_enabled" {
  type    = bool
  default = false
}

variable "gcp_project" {
  type    = string
  default = ""
}

variable "gcp_location" {
  type    = string
  default = "us-central1"
}

variable "azure_enabled" {
  type    = bool
  default = false
}

variable "azure_registry_name" {
  description = "Globally unique ACR name: 5-50 alphanumeric characters."
  type        = string
  default     = ""

  validation {
    condition     = var.azure_registry_name == "" || can(regex("^[A-Za-z0-9]{5,50}$", var.azure_registry_name))
    error_message = "azure_registry_name must contain 5-50 alphanumeric characters."
  }
}

variable "azure_resource_group_name" {
  type    = string
  default = ""
}

variable "azure_location" {
  type    = string
  default = "eastus"
}

variable "r2_archive_enabled" {
  description = "Create an R2 object bucket for immutable OCI-layout archives. R2 is not a pullable OCI registry."
  type        = bool
  default     = false
}

variable "cloudflare_account_id" {
  type    = string
  default = ""
}

variable "r2_bucket_name" {
  type    = string
  default = ""
}

check "aws_configuration" {
  assert {
    condition     = !var.aws_enabled || trimspace(var.aws_region) != ""
    error_message = "aws_region is required when aws_enabled is true."
  }
}

check "gcp_configuration" {
  assert {
    condition = !var.gcp_enabled || (
      trimspace(var.gcp_project) != "" && trimspace(var.gcp_location) != ""
    )
    error_message = "gcp_project and gcp_location are required when gcp_enabled is true."
  }
}

check "azure_configuration" {
  assert {
    condition = !var.azure_enabled || (
      trimspace(var.azure_registry_name) != "" &&
      trimspace(var.azure_resource_group_name) != "" &&
      trimspace(var.azure_location) != ""
    )
    error_message = "azure_registry_name, azure_resource_group_name, and azure_location are required when azure_enabled is true."
  }
}

check "r2_configuration" {
  assert {
    condition = !var.r2_archive_enabled || (
      trimspace(var.cloudflare_account_id) != "" &&
      trimspace(var.r2_bucket_name) != ""
    )
    error_message = "cloudflare_account_id and r2_bucket_name are required when r2_archive_enabled is true."
  }
}

resource "aws_ecr_repository" "oci" {
  count = var.aws_enabled ? 1 : 0

  name                 = var.registry_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "oci" {
  count = var.aws_enabled ? 1 : 0

  repository = aws_ecr_repository.oci[0].name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Retain the newest 50 tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 50
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "google_artifact_registry_repository" "oci" {
  count = var.gcp_enabled ? 1 : 0

  project       = var.gcp_project
  location      = var.gcp_location
  repository_id = var.registry_name
  description   = "OCI images managed by the repository infrastructure contract"
  format        = "DOCKER"

  docker_config {
    immutable_tags = true
  }
}

resource "azurerm_container_registry" "oci" {
  count = var.azure_enabled ? 1 : 0

  name                = var.azure_registry_name
  resource_group_name = var.azure_resource_group_name
  location            = var.azure_location
  sku                 = "Basic"
  admin_enabled       = false
}

# R2 stores OCI-layout tar archives for backup, promotion evidence, or cache
# seeding. Lambda, Cloud Run, Kubernetes, and other runtimes must pull from a
# real registry implementing the OCI Distribution API.
resource "cloudflare_r2_bucket" "oci_archive" {
  count = var.r2_archive_enabled ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name
}

output "aws_ecr_repository_url" {
  value = try(aws_ecr_repository.oci[0].repository_url, null)
}

output "gcp_artifact_registry_repository" {
  value = var.gcp_enabled ? "${var.gcp_location}-docker.pkg.dev/${var.gcp_project}/${google_artifact_registry_repository.oci[0].repository_id}" : null
}

output "azure_acr_login_server" {
  value = try(azurerm_container_registry.oci[0].login_server, null)
}

output "r2_archive_bucket" {
  value = try(cloudflare_r2_bucket.oci_archive[0].name, null)
}
