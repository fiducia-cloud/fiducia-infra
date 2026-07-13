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

# --- prod-hardening (opt-in; defaults reproduce the e2e-grade baseline) ------

variable "enable_firewall" {
  type        = bool
  default     = false
  description = "Attach an hcloud_firewall to the servers. Default false so e2e servers keep unfiltered public IPs (k3s :6443 + NodePorts reachable publicly). When true, inbound is default-denied except SSH/:6443/NodePorts from var.firewall_allowed_cidrs."
}

variable "firewall_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = "Source CIDRs permitted to SSH / :6443 / NodePorts when var.enable_firewall is true. Must be explicit and restricted; world-open CIDRs are rejected. Include operator/admin and trusted edge/mesh ranges as required."

  validation {
    condition     = alltrue([for cidr in var.firewall_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "firewall_allowed_cidrs must contain valid IPv4 or IPv6 CIDRs."
  }
}
