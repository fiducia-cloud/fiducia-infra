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

# Server (cluster-admin-equivalent) join token AND a SEPARATE agent token, so a
# compromised worker cannot recover the server token and join as a control-plane.
resource "random_password" "k3s_token" {
  length  = 48
  special = false
}
resource "random_password" "k3s_agent_token" {
  length  = 48
  special = false
}

# Either reuse an already-registered project key (ssh_key_name) or upload the
# given material. Hetzner rejects uploading a key whose fingerprint already
# exists in the project, so reuse is the path when the operator's key is
# registered (e.g. by another cluster in the same project).
data "hcloud_ssh_key" "existing" {
  count = var.ssh_key_name != "" ? 1 : 0
  name  = var.ssh_key_name
}

resource "hcloud_ssh_key" "this" {
  count      = var.ssh_key_name == "" ? 1 : 0
  name       = "${var.cluster_name}-key"
  public_key = var.ssh_public_key

  lifecycle {
    precondition {
      condition     = length(trimspace(var.ssh_public_key)) > 0
      error_message = "Set ssh_public_key (key material to upload) or ssh_key_name (existing project key) — needed to fetch the kubeconfig and manage the cluster."
    }
  }
}

locals {
  ssh_key_ids = var.ssh_key_name != "" ? [data.hcloud_ssh_key.existing[0].id] : [hcloud_ssh_key.this[0].id]
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

  lifecycle {
    precondition {
      condition = (
        length(var.firewall_allowed_cidrs) > 0 &&
        !contains(var.firewall_allowed_cidrs, "0.0.0.0/0") &&
        !contains(var.firewall_allowed_cidrs, "::/0")
      )
      error_message = "enable_firewall requires explicit restricted firewall_allowed_cidrs; world-open CIDRs are rejected."
    }
  }
}

# Control plane: k3s server, TLS SAN for the public IP so a fetched kubeconfig works.
resource "hcloud_server" "control_plane" {
  name         = "${var.cluster_name}-cp"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = local.ssh_key_ids
  labels       = var.labels
  firewall_ids = var.enable_firewall ? [hcloud_firewall.this[0].id] : []

  # k3s install, PINNED to var.k8s_version (INSTALL_K3S_VERSION) so control-plane
  # and agents can't drift to whatever "latest" get.k3s.io resolves to at each boot,
  # and re-provisioning is reproducible. The public IP for the serving-cert SAN
  # comes from Hetzner's metadata service (169.254.169.254), not a third-party
  # `curl ifconfig.me` whose failure would silently produce a cert the kubeconfig
  # can't verify. Agents get a SEPARATE token (--agent-token).
  # NOTE: var.cni = "flannel" (default) installs k3s's default flannel CNI.
  # The prod topology's Cluster Mesh needs Cilium — var.cni = "cilium" starts the
  # server with --flannel-backend=none --disable-network-policy; run
  # `cilium install` against the cluster afterwards (nodes are NotReady until then).
  user_data = <<-EOF
    #cloud-config
    runcmd:
      - PUBIP=$(curl -sf http://169.254.169.254/hetzner/v1/metadata/public-ipv4)
      - curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="${var.k8s_version}" INSTALL_K3S_EXEC="server --disable traefik --tls-san $PUBIP --token ${random_password.k3s_token.result} --agent-token ${random_password.k3s_agent_token.result}${var.cni == "cilium" ? " --flannel-backend=none --disable-network-policy" : ""}" sh -
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
  ssh_keys     = local.ssh_key_ids
  labels       = var.labels
  firewall_ids = var.enable_firewall ? [hcloud_firewall.this[0].id] : []

  user_data = <<-EOF
    #cloud-config
    runcmd:
      - curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="${var.k8s_version}" K3S_URL="https://${one(hcloud_server.control_plane.network).ip}:6443" K3S_TOKEN="${random_password.k3s_agent_token.result}" sh -
  EOF

  network {
    network_id = hcloud_network.this.id
  }
  depends_on = [hcloud_server.control_plane]
}
