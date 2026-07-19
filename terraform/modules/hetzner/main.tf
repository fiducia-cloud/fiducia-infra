# Hetzner "cluster" for a fiducia failure domain.
# Hetzner Cloud has no managed Kubernetes in the core provider, so this brings up
# hcloud servers and installs k3s via cloud-init: one control-plane + N agents.
# e2e/test-grade baseline. For production, prefer kube-hetzner or a reviewed
# managed offering. The module can either own a private network or attach an
# independent cluster to a shared, isolated network with a fixed server IP.
#
# Firewall hardening defaults ON. Public ingress is denied except SSH and :6443
# from explicit operator CIDRs. Fiducia NodePorts remain private unless a caller
# separately supplies restricted public_nodeport_cidrs; SSH tunnels are preferred.

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
  ssh_key_ids        = var.ssh_key_name != "" ? [data.hcloud_ssh_key.existing[0].id] : [hcloud_ssh_key.this[0].id]
  network_id         = var.create_network ? hcloud_network.this[0].id : var.existing_network_id
  install_script_url = "https://raw.githubusercontent.com/k3s-io/k3s/${var.k3s_install_script_commit}/install.sh"
  cni_server_flags   = var.cni == "cilium" ? " --flannel-backend=none --disable-network-policy" : ""
  private_server_flags = var.control_plane_private_ip == null ? "" : join("", [
    " --node-ip ${var.control_plane_private_ip}",
    " --advertise-address ${var.control_plane_private_ip}",
    " --tls-san ${var.control_plane_private_ip}",
  ])
}

resource "hcloud_network" "this" {
  count    = var.create_network ? 1 : 0
  name     = "${var.cluster_name}-net"
  ip_range = var.network_ip_range
  labels   = var.labels
}

resource "hcloud_network_subnet" "this" {
  count        = var.create_network ? 1 : 0
  network_id   = hcloud_network.this[0].id
  type         = "cloud"
  network_zone = var.network_zone
  ip_range     = var.subnet_ip_range
}

# Default-on public firewall. count=0 is only the explicit legacy opt-out.
# When enabled, an hcloud_firewall default-denies inbound and allows only the
# ports below from explicit restricted CIDRs; it is attached via firewall_ids.
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
  dynamic "rule" {
    for_each = length(var.public_nodeport_cidrs) == 0 ? toset([]) : toset(["30080", "30088", "30090", "30095"])
    content {
      direction   = "in"
      protocol    = "tcp"
      port        = rule.value
      source_ips  = var.public_nodeport_cidrs
      description = "Explicitly opted-in Fiducia test NodePort"
    }
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

  lifecycle {
    precondition {
      condition = (
        (var.create_network && var.existing_network_id == null) ||
        (!var.create_network && var.existing_network_id != null)
      )
      error_message = "Use create_network=true with no existing_network_id, or create_network=false with an existing_network_id."
    }
  }

  # k3s and its official installer are BOTH pinned. The installer is downloaded
  # from an exact k3s-io/k3s commit and SHA-256 verified before execution. The
  # public IP for the serving-cert SAN
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
      - |
        set -eu
        INSTALL_SCRIPT=/run/k3s-install.sh
        curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location \
          '${local.install_script_url}' --output "$INSTALL_SCRIPT"
        printf '%s  %s\n' '${var.k3s_install_script_sha256}' "$INSTALL_SCRIPT" | sha256sum --check --status -
        PUBIP=$(curl --fail --silent http://169.254.169.254/hetzner/v1/metadata/public-ipv4)
        INSTALL_K3S_VERSION='${var.k8s_version}' \
          INSTALL_K3S_EXEC="server --disable traefik --disable servicelb --tls-san $PUBIP --token ${random_password.k3s_token.result} --agent-token ${random_password.k3s_agent_token.result}${local.cni_server_flags}${local.private_server_flags}" \
          sh "$INSTALL_SCRIPT"
  EOF

  network {
    network_id = local.network_id
    ip         = var.control_plane_private_ip
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
      - |
        set -eu
        INSTALL_SCRIPT=/run/k3s-install.sh
        curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location \
          '${local.install_script_url}' --output "$INSTALL_SCRIPT"
        printf '%s  %s\n' '${var.k3s_install_script_sha256}' "$INSTALL_SCRIPT" | sha256sum --check --status -
        INSTALL_K3S_VERSION='${var.k8s_version}' \
          K3S_URL='https://${one(hcloud_server.control_plane.network).ip}:6443' \
          K3S_TOKEN='${random_password.k3s_agent_token.result}' \
          sh "$INSTALL_SCRIPT"
  EOF

  network {
    network_id = local.network_id
  }
  depends_on = [hcloud_server.control_plane]
}
