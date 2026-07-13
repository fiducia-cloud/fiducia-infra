variable "cluster_name" {
  type        = string
  description = "Cluster id (e.g. fiducia-prod-vultr)."
}

variable "region" {
  type        = string
  default     = "fra"
  description = "Vultr region slug (e.g. fra=Frankfurt). topology.toml's region maps here."
}

variable "node_count" {
  type        = number
  default     = 5
  description = "Worker VMs in the VKE node pool. Must be >= topology node_replicas (5) so the one-node-pod-per-machine anti-affinity can schedule."
}

variable "plan" {
  type        = string
  default     = "vc2-2c-4gb"
  description = "Vultr plan for the worker nodes."
}

variable "k8s_version" {
  type        = string
  default     = "v1.31.4+1"
  description = "VKE Kubernetes version (see `vultr-cli kubernetes versions`)."
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Tag applied to the cluster (Vultr supports a single label/tag)."
}
