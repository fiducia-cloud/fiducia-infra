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

# Optional hardening controls. Defaults preserve the disposable e2e behavior;
# production-like runs must opt in explicitly and provide their own network
# ranges. Each value is passed through to the corresponding cloud module.

variable "gcp_deletion_protection" {
  type        = bool
  default     = false
  description = "Protect the GKE cluster from deletion."
}
variable "gcp_enable_private_cluster" {
  type        = bool
  default     = false
  description = "Use private GKE nodes. Requires suitable VPC egress/NAT."
}
variable "gcp_enable_private_endpoint" {
  type        = bool
  default     = false
  description = "Make the GKE control-plane endpoint private-only; requires gcp_enable_private_cluster."
}
variable "gcp_master_ipv4_cidr_block" {
  type        = string
  default     = "172.16.0.0/28"
  description = "Private /28 used by the GKE control plane when private-cluster mode is enabled."
}
variable "gcp_authorized_api_cidrs" {
  type        = list(string)
  default     = []
  description = "CIDRs allowed to reach the GKE API server. Empty preserves the unrestricted e2e default."
}
variable "gcp_enable_network_policy" {
  type        = bool
  default     = false
  description = "Enable GKE Calico NetworkPolicy enforcement."
}

variable "aws_subnet_ids" {
  type        = list(string)
  default     = []
  description = "Dedicated EKS subnet ids. Empty uses default-VPC subnets for e2e."
}
variable "aws_endpoint_public_access" {
  type        = bool
  default     = true
  description = "Expose the EKS API publicly."
}
variable "aws_endpoint_private_access" {
  type        = bool
  default     = false
  description = "Expose the EKS API inside its VPC."
}
variable "aws_authorized_api_cidrs" {
  type        = list(string)
  default     = []
  description = "CIDRs allowed to reach the public EKS API. Empty preserves the world-open e2e default."
}

variable "azure_authorized_api_cidrs" {
  type        = list(string)
  default     = []
  description = "IPv4 CIDRs allowed to reach the AKS API server. Empty preserves the unrestricted e2e default."
}
variable "azure_enable_network_policy" {
  type        = bool
  default     = false
  description = "Enable Azure NetworkPolicy enforcement for AKS."
}

variable "hetzner_enable_firewall" {
  type        = bool
  default     = true
  description = "Attach the default-deny public firewall to Hetzner nodes. The explicit legacy opt-out is unsafe."
}
variable "hetzner_firewall_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = "Restricted operator CIDRs allowed to SSH and the k3s API when the firewall is enabled. NodePorts remain private."
}
