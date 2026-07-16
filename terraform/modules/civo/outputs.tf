output "name" {
  value       = civo_kubernetes_cluster.this.name
  description = "Cluster name."
}

output "endpoint" {
  value       = civo_kubernetes_cluster.this.api_endpoint
  description = "Civo Kubernetes API server endpoint."
}

output "ca_certificate" {
  # civo_kubernetes_cluster exports no CA attribute — the CA is embedded in the
  # returned kubeconfig. Extract it so this module honors the shared interface
  # (name/endpoint/ca_certificate/kubeconfig). try() keeps plan working before the
  # cluster (and its kubeconfig) exists.
  value       = try(yamldecode(civo_kubernetes_cluster.this.kubeconfig).clusters[0].cluster["certificate-authority-data"], null)
  description = "Cluster CA certificate (base64, extracted from the Civo kubeconfig)."
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
