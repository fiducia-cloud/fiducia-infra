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

# --- prod-hardening (opt-in; defaults reproduce the e2e-grade baseline) ------

variable "subnet_ids" {
  type        = list(string)
  default     = []
  description = "Subnets for the cluster + node group. Empty (default) uses the account's DEFAULT VPC subnets (e2e-grade). Set to a dedicated/private VPC's subnet ids to harden for prod."
}

variable "endpoint_public_access" {
  type        = bool
  default     = true
  description = "Whether the EKS API server has a public endpoint. Default true (e2e). Set false for a fully private cluster (requires private subnets + endpoint_private_access)."
}

variable "endpoint_private_access" {
  type        = bool
  default     = false
  description = "Whether the EKS API server is reachable from within the VPC. Default false (e2e). Set true when hardening (typically alongside endpoint_public_access=false)."
}

variable "authorized_api_cidrs" {
  type        = list(string)
  default     = []
  description = "CIDRs allowed to reach the public API endpoint. Empty (default) means open to 0.0.0.0/0 (e2e). Set to operator/admin CIDRs to restrict for prod."
}
