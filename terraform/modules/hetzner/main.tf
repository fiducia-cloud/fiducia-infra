# Hetzner "cluster" for a fiducia failure domain.
# Hetzner Cloud has no managed Kubernetes in the core provider, so this brings up
# hcloud servers and installs k3s via cloud-init: one control-plane + N agents.
# e2e/test-grade baseline. For production, prefer kube-hetzner or Hetzner's
# managed offering.
#
# Firewall hardening is OPT-IN via var.enable_firewall (default false → the
# servers' public IPs are unfiltered, matching current e2e behavior, so the k3s
# API :6443 and NodePorts are reachable publicly). When enabled, an
# hcloud_firewall is attached that default-denies inbound and only permits SSH,
# :6443 and the NodePort range from var.firewall_allowed_cidrs. Agent join stays
# on the private network, which hcloud firewalls do not filter.

terraform {
  required_version = ">= 1.5"
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

# Shared secret so agents can join the control-plane's k3s.
resource "random_password" "k3s_token" {
  length  = 48
  special = false
}

resource "hcloud_ssh_key" "this" {
  name       = "${var.cluster_name}-key"
  public_key = var.ssh_public_key
}

resource "hcloud_network" "this" {
  name     = "${var.cluster_name}-net"
  ip_range = "10.10.0.0/16"
}

resource "hcloud_network_subnet" "this" {
  network_id   = hcloud_network.this.id
  type         = "cloud"
  network_zone = var.network_zone
  ip_range     = "10.10.1.0/24"
}

# OPT-IN public firewall. count=0 by default → e2e servers keep unfiltered public
# IPs. When enabled, an hcloud_firewall default-denies inbound and allows only the
# ports below from var.firewall_allowed_cidrs; it is attached to the servers via
# their firewall_ids.
resource "hcloud_firewall" "this" {
  count  = var.enable_firewall ? 1 : 0
  name   = "${var.cluster_name}-fw"
  labels = var.labels

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.firewall_allowed_cidrs
    description = "SSH (kubeconfig fetch + management)"
  }
  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "6443"
    source_ips  = var.firewall_allowed_cidrs
    description = "k3s API server"
  }
  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "30000-32767"
    source_ips  = var.firewall_allowed_cidrs
    description = "Kubernetes NodePort range"
  }
}

# Control plane: k3s server, TLS SAN for the public IP so a fetched kubeconfig works.
resource "hcloud_server" "control_plane" {
  name         = "${var.cluster_name}-cp"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.this.id]
  labels       = var.labels
  firewall_ids = var.enable_firewall ? [hcloud_firewall.this[0].id] : []

  user_data = <<-EOF
    #cloud-config
    runcmd:
      - curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --disable traefik --tls-san $(curl -s ifconfig.me) --token ${random_password.k3s_token.result}" sh -
  EOF

  network {
    network_id = hcloud_network.this.id
  }
  depends_on = [hcloud_network_subnet.this]
}

# Agents join the control plane over the private network.
resource "hcloud_server" "agent" {
  count        = var.node_count
  name         = "${var.cluster_name}-agent-${count.index}"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.this.id]
  labels       = var.labels
  firewall_ids = var.enable_firewall ? [hcloud_firewall.this[0].id] : []

  user_data = <<-EOF
    #cloud-config
    runcmd:
      - curl -sfL https://get.k3s.io | K3S_URL="https://${one(hcloud_server.control_plane.network).ip}:6443" K3S_TOKEN="${random_password.k3s_token.result}" sh -
  EOF

  network {
    network_id = hcloud_network.this.id
  }
  depends_on = [hcloud_server.control_plane]
}
