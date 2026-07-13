variable "cluster_name" {
  type        = string
  description = "Cluster id (e.g. fiducia-e2e-azure)."
}

variable "location" {
  type        = string
  description = "Azure region, e.g. eastus. Matches topology.toml region."
}

variable "node_count" {
  type        = number
  default     = 3
  description = "Default node pool size."
}

variable "vm_size" {
  type        = string
  default     = "Standard_D2s_v5"
  description = "Node VM size (e2e-grade default)."
}

variable "k8s_version" {
  type        = string
  default     = "1.30"
  description = "AKS Kubernetes version."
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Tags applied to the resource group + cluster."
}

# --- prod-hardening (opt-in; defaults reproduce the e2e-grade baseline) ------

variable "authorized_api_cidrs" {
  type        = list(string)
  default     = []
  description = "CIDRs allowed to reach the AKS API server (api_server_access_profile.authorized_ip_ranges). Empty (default) leaves the endpoint open (e2e). Set to operator/admin CIDRs to harden."
}

variable "enable_network_policy" {
  type        = bool
  default     = false
  description = "Enable Azure network-policy enforcement (network_plugin=azure, network_policy=azure). Default false so e2e uses the AKS default profile; true to enforce the fiducia NetworkPolicies at the dataplane."
}
