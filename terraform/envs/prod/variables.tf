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
  description = "Schedulable machines per cluster. Must be >= topology node_replicas so the required one-node-pod-per-machine anti-affinity schedules all node pods. Default 1 = the single-VM-per-cloud bootstrap (topology node_replicas = 1); on hetzner the schedulable k3s control plane is that machine (agents = node_count - 1)."

  validation {
    condition     = var.node_count >= 1
    error_message = "node_count must be >= 1 (and >= topology.toml node_replicas, one node pod per machine)."
  }
}

variable "hetzner_ssh_public_key" {
  type        = string
  default     = ""
  description = "SSH public key material to upload (one of this or hetzner_ssh_key_name is required when enable_hetzner = true; enforced by a precondition in modules/hetzner)."
}

variable "hetzner_ssh_key_name" {
  type        = string
  default     = ""
  description = "Name of an ssh key ALREADY registered in the hcloud project to authorize instead of uploading hetzner_ssh_public_key (Hetzner rejects duplicate fingerprints, so use this when the operator key is already registered)."
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
