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
