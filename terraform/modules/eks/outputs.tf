output "name" {
  value       = aws_eks_cluster.this.name
  description = "Provisioned cluster name."
}

output "endpoint" {
  value       = aws_eks_cluster.this.endpoint
  description = "Kubernetes API server URL."
}

output "ca_certificate" {
  value       = aws_eks_cluster.this.certificate_authority[0].data
  description = "base64 cluster CA certificate."
  sensitive   = true
}

output "kubeconfig_hint" {
  value       = "aws eks update-kubeconfig --name ${aws_eks_cluster.this.name} --region ${var.location}"
  description = "One-liner to write a kubeconfig context for this cluster."
}
