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
