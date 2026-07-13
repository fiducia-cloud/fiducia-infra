# AKS cluster for a fiducia failure domain (Azure).
# e2e/test-grade baseline. AKS is a single resource + a resource group.
#
# Prod-hardening is OPT-IN via variables that all DEFAULT to this e2e behavior
# (see variables.tf): var.authorized_api_cidrs restricts the API server, and
# var.enable_network_policy turns on dataplane network-policy enforcement.
# Existing e2e applies that pass none of these are unchanged.

terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

resource "azurerm_resource_group" "this" {
  name     = "${var.cluster_name}-rg"
  location = var.location
  tags     = var.labels
}

resource "azurerm_kubernetes_cluster" "this" {
  name                = var.cluster_name
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  dns_prefix          = var.cluster_name
  kubernetes_version  = var.k8s_version
  tags                = var.labels

  default_node_pool {
    name       = "sys"
    node_count = var.node_count
    vm_size    = var.vm_size
  }

  identity {
    type = "SystemAssigned"
  }

  # Prod-hardening, opt-in and defaulted off so e2e behavior is unchanged:
  #  - api_server_access_profile → restrict API access (var.authorized_api_cidrs)
  #  - network_profile           → Azure network-policy enforcement (var.enable_network_policy)
  dynamic "api_server_access_profile" {
    for_each = length(var.authorized_api_cidrs) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.authorized_api_cidrs
    }
  }

  dynamic "network_profile" {
    for_each = var.enable_network_policy ? [1] : []
    content {
      network_plugin = "azure"
      network_policy = "azure"
    }
  }
}
