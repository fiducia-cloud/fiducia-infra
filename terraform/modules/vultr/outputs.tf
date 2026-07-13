output "name" {
  value       = vultr_kubernetes.this.label
  description = "Cluster name."
}

output "endpoint" {
  value       = vultr_kubernetes.this.endpoint
  description = "VKE API server endpoint."
}

output "ca_certificate" {
  value       = base64decode(vultr_kubernetes.this.client_certificate)
  description = "Cluster client certificate (from the managed kubeconfig)."
  sensitive   = true
}

output "kubeconfig_hint" {
  value       = "terraform output -raw kubeconfig > ${var.cluster_name}.kubeconfig  # (VKE exposes the full kubeconfig)"
  description = "VKE returns a ready kubeconfig via vultr_kubernetes.this.kube_config."
}

output "kubeconfig" {
  value       = vultr_kubernetes.this.kube_config
  description = "Full base64 kubeconfig for the VKE cluster."
  sensitive   = true
}
