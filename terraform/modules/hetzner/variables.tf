variable "cluster_name" {
  type        = string
  description = "Cluster id (e.g. fiducia-e2e-hetzner)."
}

variable "location" {
  type        = string
  default     = "nbg1"
  description = "hcloud location (nbg1/fsn1/hel1). topology.toml's 'eu-central' maps here."
}

variable "network_zone" {
  type        = string
  default     = "eu-central"
  description = "hcloud network zone for the private subnet."
}

variable "node_count" {
  type        = number
  default     = 3
  description = "Number of k3s AGENT servers (workers) joined to the control plane."
}

variable "server_type" {
  type        = string
  default     = "cx32"
  description = "hcloud server type for control-plane + agents (e2e-grade default)."
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key material authorized on the servers (also needed to fetch the kubeconfig)."
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Labels applied to the servers."
}
