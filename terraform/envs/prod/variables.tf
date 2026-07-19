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
  description = "Schedulable machines per cluster. Must be >= topology node_replicas so the required one-node-pod-per-machine anti-affinity schedules all node pods. Default 1 = the single-VM-per-cloud bootstrap (topology node_replicas = 1); on hetzner the schedulable k3s control plane is that machine (agents = node_count - 1). Full design = 5; keep this in lockstep with topology.toml."

  validation {
    condition     = var.node_count >= 1
    error_message = "node_count must be >= 1 (and >= topology.toml node_replicas, one node pod per machine)."
  }
}

# Starter-tier machine sizes: at node_count = 1 the single worker carries
# node + brain + 2×LB + sidecar + observability, so it must be big — >= 4 vCPU /
# 16 GB, 8 vCPU preferred. Verify exact ids against the live catalogs before
# apply (`hcloud server-type list` / `vultr-cli plans list` / `civo size list`);
# at node_count = 5 these can drop back to the small per-machine defaults.
variable "hetzner_server_type" {
  type        = string
  default     = "cx42"
  description = "hcloud server type (cx42 = 8 vCPU / 16 GB shared)."
}
variable "vultr_plan" {
  type        = string
  default     = "vc2-6c-16gb"
  description = "Vultr plan (vc2-6c-16gb = 6 vCPU / 16 GB)."
}
variable "civo_node_size" {
  type        = string
  default     = "g4s.kube.xlarge"
  description = "Civo instance size (g4s.kube.xlarge = 16 GB tier)."
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
  description = "Source CIDRs permitted to SSH and :6443 on Hetzner (required when hetzner_enable_firewall = true; world-open is rejected). NodePorts remain private unless separately opted in at module level."
}
