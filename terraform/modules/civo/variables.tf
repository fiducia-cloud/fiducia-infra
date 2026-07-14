variable "cluster_name" {
  type        = string
  description = "Cluster id (e.g. fiducia-prod-civo)."
}

variable "region" {
  type        = string
  default     = "LON1"
  description = "Civo region (LON1/FRA1/NYC1). topology.toml's region maps here (upper-cased)."
}

variable "node_count" {
  type        = number
  default     = 5
  description = "Worker nodes in the Civo pool. Must be >= topology node_replicas (5) so the one-node-pod-per-machine anti-affinity can schedule."
}

variable "node_size" {
  type        = string
  default     = "g4s.kube.medium"
  description = "Civo instance size for the worker pool."
}

variable "cni" {
  type        = string
  default     = "cilium"
  description = "CNI plugin. Cilium is required for Cluster Mesh (topology connectivity = clustermesh)."
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Labels applied to the worker pool + as space-joined k:v tags on the cluster."
}

variable "k8s_version" {
  type        = string
  default     = "1.30.5-k3s1"
  description = "Pinned Civo Kubernetes (k3s) version. Pin it so a re-apply/replace cannot silently jump minors. `civo kubernetes versions` lists available values."
}

variable "allowed_cidrs" {
  type        = list(string)
  default     = []
  description = "REQUIRED. Source CIDRs permitted to reach the k8s API (6443) + NodePorts. World-open (0.0.0.0/0 / ::/0) is rejected. Include operator + trusted mesh/edge ranges."
}
