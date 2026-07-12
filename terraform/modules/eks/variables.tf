variable "cluster_name" {
  type        = string
  description = "Cluster id (e.g. fiducia-e2e-aws)."
}

variable "location" {
  type        = string
  description = "AWS region, e.g. us-east-1. Matches topology.toml region. (Set the provider region to this in the env.)"
}

variable "node_count" {
  type        = number
  default     = 3
  description = "Managed node group size."
}

variable "instance_type" {
  type        = string
  default     = "t3.large"
  description = "Worker instance type (e2e-grade default)."
}

variable "k8s_version" {
  type        = string
  default     = "1.30"
  description = "EKS Kubernetes version."
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Tags applied to cluster + nodes."
}
