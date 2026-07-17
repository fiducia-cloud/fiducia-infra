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
  default     = "cx33"
  description = "hcloud server type for control-plane + agents (4 vCPU / 8 GB shared x86; cx32 was retired from the hcloud catalog)."
}

variable "k8s_version" {
  type        = string
  default     = "v1.30.5+k3s1"
  description = "Pinned k3s version (INSTALL_K3S_VERSION) for control-plane + agents. Pin it so nodes provisioned at different times don't drift to a different 'latest'. See https://github.com/k3s-io/k3s/releases."
}

variable "cni" {
  type        = string
  default     = "flannel"
  description = "CNI baseline. \"flannel\" keeps k3s's default (e2e behavior). \"cilium\" starts k3s with --flannel-backend=none --disable-network-policy so Cilium can be installed — required for the prod topology's Cluster Mesh. NOTE: with \"cilium\" the nodes stay NotReady until `cilium install` runs against the cluster."

  validation {
    condition     = contains(["flannel", "cilium"], var.cni)
    error_message = "cni must be \"flannel\" or \"cilium\"."
  }
}

variable "ssh_public_key" {
  type        = string
  default     = ""
  description = "SSH public key material to UPLOAD and authorize on the servers (also needed to fetch the kubeconfig). Leave empty and set ssh_key_name instead to reuse a key already registered in the hcloud project (Hetzner rejects re-uploading a duplicate fingerprint)."
}

variable "ssh_key_name" {
  type        = string
  default     = ""
  description = "Name of an EXISTING hcloud ssh key to authorize on the servers, instead of uploading var.ssh_public_key. Exactly one of the two must be set."
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
