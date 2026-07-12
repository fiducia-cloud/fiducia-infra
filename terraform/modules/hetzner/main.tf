# Hetzner "cluster" for a fiducia failure domain.
# Hetzner Cloud has no managed Kubernetes in the core provider, so this brings up
# hcloud servers and installs k3s via cloud-init: one control-plane + N agents.
# e2e/test-grade baseline. For production, prefer kube-hetzner or Hetzner's
# managed offering; harden firewall + private network below.

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

# Control plane: k3s server, TLS SAN for the public IP so a fetched kubeconfig works.
resource "hcloud_server" "control_plane" {
  name        = "${var.cluster_name}-cp"
  server_type = var.server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.this.id]
  labels      = var.labels

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
  count       = var.node_count
  name        = "${var.cluster_name}-agent-${count.index}"
  server_type = var.server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.this.id]
  labels      = var.labels

  user_data = <<-EOF
    #cloud-config
    runcmd:
      - curl -sfL https://get.k3s.io | K3S_URL="https://${hcloud_server.control_plane.network[0].ip}:6443" K3S_TOKEN="${random_password.k3s_token.result}" sh -
  EOF

  network {
    network_id = hcloud_network.this.id
  }
  depends_on = [hcloud_server.control_plane]
}
