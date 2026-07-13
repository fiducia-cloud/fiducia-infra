output "name" {
  value       = civo_kubernetes_cluster.this.name
  description = "Cluster name."
}

output "endpoint" {
  value       = civo_kubernetes_cluster.this.api_endpoint
  description = "Civo Kubernetes API server endpoint."
}

output "ca_certificate" {
  value       = civo_kubernetes_cluster.this.ca_certificate
  description = "Cluster CA certificate."
  sensitive   = true
}

output "kubeconfig_hint" {
  value       = "terraform output -raw kubeconfig > ${var.cluster_name}.kubeconfig  # (Civo exposes the full kubeconfig)"
  description = "Civo returns a ready kubeconfig via civo_kubernetes_cluster.this.kubeconfig."
}

output "kubeconfig" {
  value       = civo_kubernetes_cluster.this.kubeconfig
  description = "Full kubeconfig for the Civo cluster."
  sensitive   = true
}
