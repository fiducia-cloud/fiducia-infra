variable "cluster_name" {
  type        = string
  description = "Cluster id (e.g. fiducia-e2e-hetzner)."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,62}$", var.cluster_name))
    error_message = "cluster_name must be a 1-63 character lowercase DNS label."
  }
}

variable "location" {
  type        = string
  default     = "nbg1"
  description = "hcloud location (nbg1/fsn1/hel1). topology.toml's 'eu-central' maps here."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,31}$", var.location))
    error_message = "location must be a lowercase Hetzner location id."
  }
}

variable "network_zone" {
  type        = string
  default     = "eu-central"
  description = "hcloud network zone for the private subnet."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,31}$", var.network_zone))
    error_message = "network_zone must be a lowercase Hetzner network-zone id."
  }
}

variable "node_count" {
  type        = number
  default     = 3
  description = "Number of k3s AGENT servers (workers) joined to the control plane. Zero creates an independent single-node k3s cluster whose server is schedulable."

  validation {
    condition     = var.node_count >= 0 && floor(var.node_count) == var.node_count
    error_message = "node_count must be a non-negative integer."
  }
}

variable "server_type" {
  type        = string
  default     = "cx33"
  description = "hcloud server type for control-plane + agents (4 vCPU / 8 GB shared x86; cx32 was retired from the hcloud catalog)."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,31}$", var.server_type))
    error_message = "server_type must be a lowercase Hetzner server type id."
  }
}

variable "k8s_version" {
  type        = string
  default     = "v1.36.1+k3s1"
  description = "Pinned k3s version (INSTALL_K3S_VERSION) for control-plane + agents. Pin it so nodes provisioned at different times don't drift to a different 'latest'. See https://github.com/k3s-io/k3s/releases."

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+\\+k3s[0-9]+$", var.k8s_version))
    error_message = "k8s_version must be an exact release such as v1.36.1+k3s1."
  }
}

variable "k3s_install_script_commit" {
  type        = string
  default     = "a9663261a7ff40522542485a6b2f81916b6d72f9"
  description = "Exact k3s-io/k3s install-script commit downloaded from raw.githubusercontent.com."

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.k3s_install_script_commit))
    error_message = "k3s_install_script_commit must be a full lowercase Git commit SHA."
  }
}

variable "k3s_install_script_sha256" {
  type        = string
  default     = "46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad"
  description = "Reviewed SHA-256 of the pinned official k3s install script. The VM verifies this before execution."

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.k3s_install_script_sha256))
    error_message = "k3s_install_script_sha256 must be 64 lowercase hexadecimal characters."
  }
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

variable "existing_network_id" {
  type        = number
  default     = null
  nullable    = true
  description = "Existing hcloud network id to attach. When null, this module creates its own network and subnet. Use this for several independent clusters sharing one isolated private network."
}

variable "create_network" {
  type        = bool
  default     = true
  description = "Create a dedicated hcloud network/subnet. Set false with existing_network_id for a reviewed shared test network. This explicit switch keeps Terraform counts plan-time-known."
}

variable "control_plane_private_ip" {
  type        = string
  default     = null
  nullable    = true
  description = "Optional fixed private IPv4 for the k3s server on existing_network_id. When set, k3s uses it for --node-ip, --advertise-address, and a TLS SAN."

  validation {
    condition = var.control_plane_private_ip == null || (
      can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", var.control_plane_private_ip)) &&
      can(cidrhost("${var.control_plane_private_ip}/32", 0))
    )
    error_message = "control_plane_private_ip must be a valid IPv4 address or null."
  }
}

variable "network_ip_range" {
  type        = string
  default     = "10.10.0.0/16"
  description = "Private network CIDR when this module creates the hcloud network."

  validation {
    condition     = can(cidrhost(var.network_ip_range, 0))
    error_message = "network_ip_range must be a valid CIDR."
  }
}

variable "subnet_ip_range" {
  type        = string
  default     = "10.10.1.0/24"
  description = "Private subnet CIDR when this module creates the hcloud network."

  validation {
    condition     = can(cidrhost(var.subnet_ip_range, 0))
    error_message = "subnet_ip_range must be a valid CIDR."
  }
}

# --- public-edge hardening ----------------------------------------------------

variable "enable_firewall" {
  type        = bool
  default     = true
  description = "Attach a default-deny inbound hcloud firewall. Secure default is true; disabling it is an explicit legacy compatibility escape hatch."
}

variable "firewall_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = "Explicit operator CIDRs permitted to reach public SSH and the k3s API when enable_firewall is true. World-open CIDRs are rejected. This does not expose NodePorts."

  validation {
    condition     = alltrue([for cidr in var.firewall_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "firewall_allowed_cidrs must contain valid IPv4 or IPv6 CIDRs."
  }
}

variable "public_nodeport_cidrs" {
  type        = list(string)
  default     = []
  description = "Optional restricted CIDRs allowed to reach the four Fiducia test NodePorts. Empty (the secure default) keeps every NodePort private; prefer SSH tunnels."

  validation {
    condition = (
      alltrue([for cidr in var.public_nodeport_cidrs : can(cidrhost(cidr, 0))]) &&
      !contains(var.public_nodeport_cidrs, "0.0.0.0/0") &&
      !contains(var.public_nodeport_cidrs, "::/0")
    )
    error_message = "public_nodeport_cidrs must contain valid restricted CIDRs; world-open CIDRs are rejected."
  }
}
