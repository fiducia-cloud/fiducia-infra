terraform {
  required_version = ">= 1.7.0"
}

locals {
  registry_modules_commit = "698c675f57fd70ebe24a8a08f963599c4c84fa5a"
}

variable "repository_name" {
  description = "Lowercase OCI repository identifier shared where provider naming rules overlap."
  type        = string
  default     = "fiducia"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.repository_name))
    error_message = "repository_name must be 3-63 lowercase letters, digits, dots, underscores, or hyphens."
  }
}

variable "description" {
  type    = string
  default = "Fiducia service and Lambda OCI images"
}

variable "tags" {
  type = map(string)
  default = {
    ManagedBy = "terraform"
    Purpose   = "oci-images"
    Product   = "fiducia-cloud"
  }
}

variable "enable_aws_ecr" {
  type    = bool
  default = false
}

variable "enable_gcp_artifact_registry" {
  type    = bool
  default = false
}

variable "enable_azure_acr" {
  type    = bool
  default = false
}

variable "enable_cloudflare_r2_archive" {
  description = "Create an R2 archive bucket. R2 is not a direct runtime OCI registry."
  type        = bool
  default     = false
}

variable "gcp_project_id" {
  type     = string
  default  = null
  nullable = true
}

variable "gcp_location" {
  type    = string
  default = "us-central1"
}

variable "azure_registry_name" {
  type    = string
  default = "fiduciaoci"

  validation {
    condition     = can(regex("^[A-Za-z0-9]{5,50}$", var.azure_registry_name))
    error_message = "azure_registry_name must be 5-50 alphanumeric characters."
  }
}

variable "azure_resource_group_name" {
  type    = string
  default = "fiducia-oci"
}

variable "azure_location" {
  type    = string
  default = "eastus"
}

variable "cloudflare_account_id" {
  type      = string
  default   = null
  nullable  = true
  sensitive = true
}

variable "r2_bucket_name" {
  type    = string
  default = "fiducia-oci-archive"
}

variable "r2_location" {
  type    = string
  default = "enam"
}

variable "r2_jurisdiction" {
  type    = string
  default = "default"
}

variable "r2_storage_class" {
  type    = string
  default = "InfrequentAccess"

  validation {
    condition     = contains(["Standard", "InfrequentAccess"], var.r2_storage_class)
    error_message = "r2_storage_class must be Standard or InfrequentAccess."
  }
}

module "aws_ecr" {
  count  = var.enable_aws_ecr ? 1 : 0
  source = "git::https://github.com/zed-pkg/zed-infra.git//terraform/modules/oci-registry-fleet/aws-ecr?ref=698c675f57fd70ebe24a8a08f963599c4c84fa5a"

  repository_name = var.repository_name
  oci_role        = "lambda"
  tags            = var.tags
}

module "gcp_artifact_registry" {
  count  = var.enable_gcp_artifact_registry ? 1 : 0
  source = "git::https://github.com/zed-pkg/zed-infra.git//terraform/modules/oci-registry-fleet/gcp-artifact-registry?ref=698c675f57fd70ebe24a8a08f963599c4c84fa5a"

  project_id    = coalesce(var.gcp_project_id, "disabled-project")
  location      = var.gcp_location
  repository_id = var.repository_name
  description   = var.description
  oci_role      = "cloud-run"
  labels = {
    managed-by = "terraform"
    oci-role   = "cloud-run"
    product    = "fiducia-cloud"
  }
}

module "azure_acr" {
  count  = var.enable_azure_acr ? 1 : 0
  source = "git::https://github.com/zed-pkg/zed-infra.git//terraform/modules/oci-registry-fleet/azure-acr?ref=698c675f57fd70ebe24a8a08f963599c4c84fa5a"

  registry_name       = var.azure_registry_name
  resource_group_name = var.azure_resource_group_name
  location            = var.azure_location
  sku                 = "Basic"
  oci_role            = "azure-mirror"
  tags                = var.tags
}

module "cloudflare_r2_archive" {
  count  = var.enable_cloudflare_r2_archive ? 1 : 0
  source = "git::https://github.com/zed-pkg/zed-infra.git//terraform/modules/oci-registry-fleet/cloudflare-r2?ref=698c675f57fd70ebe24a8a08f963599c4c84fa5a"

  account_id    = coalesce(var.cloudflare_account_id, "disabled-account")
  bucket_name   = var.r2_bucket_name
  location      = var.r2_location
  jurisdiction  = var.r2_jurisdiction
  storage_class = var.r2_storage_class
}

check "provider_specific_inputs" {
  assert {
    condition = !var.enable_gcp_artifact_registry || (
      trimspace(coalesce(var.gcp_project_id, "")) != ""
    )
    error_message = "gcp_project_id is required when enable_gcp_artifact_registry is true."
  }

  assert {
    condition = !var.enable_cloudflare_r2_archive || (
      trimspace(coalesce(var.cloudflare_account_id, "")) != "" &&
      trimspace(var.r2_bucket_name) != ""
    )
    error_message = "cloudflare_account_id and r2_bucket_name are required when enable_cloudflare_r2_archive is true."
  }
}

output "registry_modules_commit" {
  description = "Exact merged Zed Infra commit supplying the provider-specific modules."
  value       = local.registry_modules_commit
}

output "aws_ecr_repository_url" {
  value = try(module.aws_ecr[0].repository_url, null)
}

output "gcp_artifact_registry_host" {
  value = var.enable_gcp_artifact_registry ? "${var.gcp_location}-docker.pkg.dev" : null
}

output "gcp_artifact_registry_repository" {
  value = try(module.gcp_artifact_registry[0].docker_repository, null)
}

output "azure_container_registry_login_server" {
  value = try(module.azure_acr[0].login_server, null)
}

output "cloudflare_r2_archive_bucket" {
  value = try(module.cloudflare_r2_archive[0].bucket_name, null)
}

output "cloudflare_r2_direct_oci_registry" {
  description = "Always false: R2 is archive/blob storage, not an OCI Distribution endpoint."
  value       = false
}
