output "name" {
  value       = vultr_kubernetes.this.label
  description = "Cluster name."
}

output "endpoint" {
  value       = vultr_kubernetes.this.endpoint
  description = "VKE API server endpoint."
}

output "ca_certificate" {
  # The cluster CA (NOT the client cert): this is what a kubeconfig's
  # certificate-authority-data must be. The previous value wired the admin CLIENT
  # certificate here, so any consumer building a kubeconfig from it got TLS
  # verification failures against the API server.
  value       = vultr_kubernetes.this.cluster_ca_certificate
  description = "Cluster CA certificate (for kubeconfig certificate-authority-data)."
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
