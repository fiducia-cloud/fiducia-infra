variable "enable_hetzner" {
  type        = bool
  default     = true
  description = "Provision the Hetzner k3s cluster (brain member)."
}
variable "enable_vultr" {
  type        = bool
  default     = true
  description = "Provision the Vultr VKE cluster (brain member)."
}
variable "enable_civo" {
  type        = bool
  default     = true
  description = "Provision the Civo Kubernetes cluster (brain member)."
}

variable "node_count" {
  type        = number
  default     = 5
  description = "Worker machines per cluster. Must be >= topology node_replicas (5) so the required one-node-pod-per-machine anti-affinity schedules all node pods."

  validation {
    condition     = var.node_count >= 5
    error_message = "node_count must be >= 5 (topology node_replicas = 5, one node pod per machine)."
  }
}

variable "hetzner_ssh_public_key" {
  type        = string
  default     = ""
  description = "SSH public key material (required when enable_hetzner = true)."

  validation {
    # enable_hetzner defaults true, so a bare `apply` would otherwise send an empty
    # public_key into hcloud_ssh_key and fail opaquely at provider time (with no way
    # to fetch a kubeconfig afterwards).
    condition     = !var.enable_hetzner || length(trimspace(var.hetzner_ssh_public_key)) > 0
    error_message = "hetzner_ssh_public_key must be set when enable_hetzner = true."
  }
}

variable "civo_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = "Source CIDRs permitted to reach the Civo k8s API + NodePorts (required when enable_civo = true; world-open is rejected by the module). Operator + trusted mesh/edge ranges."
}

variable "hetzner_enable_firewall" {
  type        = bool
  default     = true
  description = "Attach the opt-in public firewall to Hetzner servers (recommended in prod)."
}

variable "hetzner_firewall_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = "Source CIDRs permitted to SSH / :6443 / NodePorts on Hetzner (required when hetzner_enable_firewall = true; world-open is rejected). Include operator + trusted mesh/edge ranges."
}
