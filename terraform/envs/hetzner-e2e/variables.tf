variable "enable_optional_new_servers" {
  type        = bool
  default     = false
  description = "Create the optional three-server fleet. Default false is the supported zero-new-server posture."
}

variable "new_server_creation_confirmation" {
  type        = string
  default     = ""
  sensitive   = false
  description = "Second Terraform-native guard. When enable_optional_new_servers is true this must equal create-three-additional-hetzner-servers."
}

variable "owner_slug" {
  type        = string
  description = "Lowercase operator/team label recorded on every billable resource."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,62}$", var.owner_slug))
    error_message = "owner_slug must be 2-63 lowercase label-safe characters."
  }
}

variable "expires_on" {
  type        = string
  description = "Mandatory YYYY-MM-DD review/teardown marker recorded on every resource. This is an alerting marker, never an automatic destroy trigger."

  validation {
    condition     = can(regex("^20[0-9]{2}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$", var.expires_on)) && can(formatdate("YYYY-MM-DD", "${var.expires_on}T00:00:00Z"))
    error_message = "expires_on must be a real YYYY-MM-DD date."
  }
}

variable "operator_cidrs" {
  type        = list(string)
  description = "Explicit public source CIDRs allowed to SSH and reach the k3s APIs. NodePorts are never opened by this environment."

  validation {
    condition = (
      length(var.operator_cidrs) > 0 &&
      alltrue([for cidr in var.operator_cidrs : can(cidrhost(cidr, 0))]) &&
      !contains(var.operator_cidrs, "0.0.0.0/0") &&
      !contains(var.operator_cidrs, "::/0")
    )
    error_message = "operator_cidrs must be non-empty, valid, and restricted; world-open access is forbidden."
  }
}

variable "ssh_public_key" {
  type        = string
  default     = ""
  description = "SSH public key material to upload. Set exactly one of this or ssh_key_name."
}

variable "ssh_key_name" {
  type        = string
  default     = ""
  description = "Existing Hetzner-project SSH key name. Set exactly one of this or ssh_public_key."
}

variable "server_type" {
  type        = string
  default     = "cx33"
  description = "Per-region VM type. Verify availability and price in all three locations before plan/apply."

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.server_type))
    error_message = "server_type must be a valid lowercase Hetzner server type id."
  }
}
