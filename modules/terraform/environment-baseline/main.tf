terraform {
  required_version = ">= 1.8.0, < 2.0.0"
}

variable "project_slug" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.project_slug))
    error_message = "project_slug must be lowercase kebab-case."
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["preview", "staging", "production"], var.environment)
    error_message = "environment must be preview, staging, or production."
  }
}

variable "cloudflare_root_directories" {
  type    = list(string)
  default = []
  validation {
    condition     = alltrue([for path in var.cloudflare_root_directories : startswith(path, "modules/cloudflare/")])
    error_message = "Cloudflare roots must live under modules/cloudflare/."
  }
}

locals {
  provider_sync = {
    supabase_working_directory = "modules"
    neon_working_directory     = "modules/neon"
    cloudflare_root_directories = var.cloudflare_root_directories
  }
  tags = {
    project     = var.project_slug
    environment = var.environment
    managed_by  = "terraform"
    layout      = "modules-first"
  }
}

output "provider_sync" { value = local.provider_sync }
output "tags" { value = local.tags }
