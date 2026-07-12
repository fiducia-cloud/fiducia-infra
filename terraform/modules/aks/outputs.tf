output "name" {
  value       = azurerm_kubernetes_cluster.this.name
  description = "Provisioned cluster name."
}

output "endpoint" {
  value       = azurerm_kubernetes_cluster.this.kube_config[0].host
  description = "Kubernetes API server URL."
}

output "ca_certificate" {
  value       = azurerm_kubernetes_cluster.this.kube_config[0].cluster_ca_certificate
  description = "base64 cluster CA certificate."
  sensitive   = true
}

output "kubeconfig_hint" {
  value       = "az aks get-credentials --resource-group ${azurerm_resource_group.this.name} --name ${azurerm_kubernetes_cluster.this.name}"
  description = "One-liner to write a kubeconfig context for this cluster."
}
