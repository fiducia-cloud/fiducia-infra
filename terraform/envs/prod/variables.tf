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
  default     = 1
  description = "Worker machines per cluster. Must be >= topology.toml node_replicas (currently 1 — starter tier, one big machine per cloud) so the required one-node-pod-per-machine anti-affinity schedules all node pods. Full design = 5; keep this in lockstep with topology.toml."

  validation {
    condition     = var.node_count >= 1
    error_message = "node_count must be >= topology node_replicas (currently 1; one node pod per machine)."
  }
}

variable "hetzner_ssh_public_key" {
  type        = string
  default     = ""
  description = "SSH public key material (required when enable_hetzner = true; enforced by a precondition in modules/hetzner so it fails clearly instead of sending an empty key to the provider)."
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
