variable "cluster_name" {
  type        = string
  description = "Cluster id (e.g. fiducia-e2e-gcp)."
}

variable "location" {
  type        = string
  description = "GCP region (regional cluster), e.g. us-central1. Matches topology.toml region."
}

variable "project_id" {
  type        = string
  description = "GCP project id."
}

variable "node_count" {
  type        = number
  default     = 3
  description = "Worker nodes per zone-managed pool. RF=3 fiducia-node schedules one replica per node ideally."
}

variable "machine_type" {
  type        = string
  default     = "e2-standard-2"
  description = "Node machine type (e2e-grade default)."
}

variable "k8s_version" {
  type        = string
  default     = "1.30"
  description = "Minimum master/Kubernetes version."
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Labels applied to cluster + nodes."
}

# --- prod-hardening (opt-in; defaults reproduce the e2e-grade baseline) ------

variable "deletion_protection" {
  type        = bool
  default     = false
  description = "Guard the cluster from deletion. Default false so e2e clusters stay disposable; set true for prod."
}

variable "enable_private_cluster" {
  type        = bool
  default     = false
  description = "Provision private nodes (no public node IPs). Default false (e2e). When true, private_cluster_config is emitted using var.master_ipv4_cidr_block."
}

variable "enable_private_endpoint" {
  type        = bool
  default     = false
  description = "When private cluster is enabled, also make the control-plane endpoint private-only. Ignored unless var.enable_private_cluster is true."
}

variable "master_ipv4_cidr_block" {
  type        = string
  default     = "172.16.0.0/28"
  description = "RFC1918 /28 for the private control plane. Only used when var.enable_private_cluster is true."

  validation {
    condition     = can(cidrnetmask(var.master_ipv4_cidr_block)) && endswith(var.master_ipv4_cidr_block, "/28")
    error_message = "master_ipv4_cidr_block must be a valid /28 CIDR."
  }
}

variable "authorized_api_cidrs" {
  type        = list(string)
  default     = []
  description = "CIDRs allowed to reach the API server (master_authorized_networks). Empty (default) leaves it unrestricted (e2e). Set to operator/admin CIDRs to harden."

  validation {
    condition     = alltrue([for cidr in var.authorized_api_cidrs : can(cidrhost(cidr, 0))])
    error_message = "authorized_api_cidrs must contain valid IPv4 or IPv6 CIDRs."
  }
}

variable "enable_network_policy" {
  type        = bool
  default     = false
  description = "Enable the GKE (Calico) network-policy addon for intra-cluster L3/L4 enforcement. Default false (e2e); true to enforce the fiducia NetworkPolicies at the dataplane."
}
