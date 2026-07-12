output "name" {
  value       = google_container_cluster.this.name
  description = "Provisioned cluster name."
}

output "endpoint" {
  value       = "https://${google_container_cluster.this.endpoint}"
  description = "Kubernetes API server URL."
}

output "ca_certificate" {
  value       = google_container_cluster.this.master_auth[0].cluster_ca_certificate
  description = "base64 cluster CA certificate."
  sensitive   = true
}

output "kubeconfig_hint" {
  value       = "gcloud container clusters get-credentials ${google_container_cluster.this.name} --region ${var.location} --project ${var.project_id}"
  description = "One-liner to write a kubeconfig context for this cluster."
}
