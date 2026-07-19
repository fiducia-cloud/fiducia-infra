# Disposable, isolated Hetzner test fleet: three independent single-node k3s
# clusters in FSN1, NBG1, and HEL1. This is deliberately separate from the
# existing dd kubeadm cluster and from terraform/envs/prod.

terraform {
  required_version = ">= 1.5"

  # Operator scripts initialize this backend with an absolute path below
  # ~/.local/state. State contains k3s join tokens and must never land in the repo.
  backend "local" {}

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "hcloud" {}
provider "random" {}

locals {
  optional_server_creation_enabled = (
    var.enable_optional_new_servers &&
    var.new_server_creation_confirmation == "create-three-additional-hetzner-servers"
  )

  # Exactly three independent Kubernetes control planes. Keep this map static:
  # RF=3 needs three distinct failure-domain identities, not three namespaces.
  clusters = {
    hetzner-fsn1 = {
      location         = "fsn1"
      private_ip       = "10.30.0.11"
      node_tunnel_port = 18003
      lb_tunnel_port   = 18103
    }
    hetzner-nbg1 = {
      location         = "nbg1"
      private_ip       = "10.30.0.12"
      node_tunnel_port = 18004
      lb_tunnel_port   = 18104
    }
    hetzner-hel1 = {
      location         = "hel1"
      private_ip       = "10.30.0.13"
      node_tunnel_port = 18005
      lb_tunnel_port   = 18105
    }
  }

  common_labels = {
    project      = "fiducia"
    environment  = "hetzner-e2e"
    purpose      = "locks-leases-proof"
    managed_by   = "terraform"
    owner        = var.owner_slug
    expires_on   = var.expires_on
    isolated     = "true"
    do_not_reuse = "true"
  }
}

check "exactly_three_clusters" {
  assert {
    condition     = length(local.clusters) == 3 && length(toset([for cluster in values(local.clusters) : cluster.private_ip])) == 3
    error_message = "hetzner-e2e must define exactly three members with distinct fixed private IPs."
  }
}

check "ssh_key_selection" {
  assert {
    condition = !var.enable_optional_new_servers || (
      (trimspace(var.ssh_public_key) != "") != (trimspace(var.ssh_key_name) != "")
    )
    error_message = "When optional server creation is enabled, set exactly one of ssh_public_key or ssh_key_name."
  }
}

check "explicit_server_creation_confirmation" {
  assert {
    condition = !var.enable_optional_new_servers || (
      var.new_server_creation_confirmation == "create-three-additional-hetzner-servers"
    )
    error_message = "Server creation requires new_server_creation_confirmation=create-three-additional-hetzner-servers."
  }
}

resource "hcloud_network" "fleet" {
  count    = local.optional_server_creation_enabled ? 1 : 0
  name     = "fiducia-e2e-regions-net"
  ip_range = "10.30.0.0/16"
  labels   = local.common_labels
}

resource "hcloud_network_subnet" "fleet" {
  count        = local.optional_server_creation_enabled ? 1 : 0
  network_id   = hcloud_network.fleet[0].id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.30.0.0/24"
}

module "cluster" {
  source   = "../../modules/hetzner"
  for_each = local.optional_server_creation_enabled ? local.clusters : {}

  cluster_name             = "fiducia-e2e-${each.key}"
  location                 = each.value.location
  network_zone             = "eu-central"
  create_network           = false
  existing_network_id      = hcloud_network.fleet[0].id
  control_plane_private_ip = each.value.private_ip

  # One schedulable k3s server and no agents = one independent Kubernetes
  # cluster per region. Do not turn this into one multi-server k3s cluster.
  node_count  = 0
  server_type = var.server_type
  cni         = "flannel"

  ssh_public_key = var.ssh_public_key
  ssh_key_name   = var.ssh_key_name
  labels = merge(local.common_labels, {
    cluster = each.key
    region  = each.value.location
  })

  enable_firewall        = true
  firewall_allowed_cidrs = var.operator_cidrs

  # Cross-cluster NodePorts travel only over the shared private network.
  # Operators reach the LBs through SSH tunnels; no public NodePort rule exists.
  public_nodeport_cidrs = []

  depends_on = [hcloud_network_subnet.fleet]
}
