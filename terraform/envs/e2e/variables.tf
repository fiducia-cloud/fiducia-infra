variable "enable_gcp" {
  type        = bool
  default     = false
  description = "Provision the GKE cluster."
}
variable "enable_aws" {
  type        = bool
  default     = false
  description = "Provision the EKS cluster."
}
variable "enable_azure" {
  type        = bool
  default     = false
  description = "Provision the AKS cluster."
}
variable "enable_hetzner" {
  type        = bool
  default     = false
  description = "Provision the Hetzner k3s cluster."
}

variable "node_count" {
  type        = number
  default     = 3
  description = "Worker nodes per cluster (RF=3 → 3 is the natural minimum for one fiducia-node replica per node)."
}

variable "gcp_project_id" {
  type        = string
  default     = ""
  description = "GCP project id (required when enable_gcp = true)."
}

variable "hetzner_ssh_public_key" {
  type        = string
  default     = ""
  description = "SSH public key material (required when enable_hetzner = true)."
}
