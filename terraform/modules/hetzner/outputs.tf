output "name" {
  value       = var.cluster_name
  description = "Cluster name (logical; Hetzner has no managed cluster object)."
}

output "endpoint" {
  value       = "https://${hcloud_server.control_plane.ipv4_address}:6443"
  description = "k3s API server URL (control-plane public IP)."
}

output "ca_certificate" {
  value       = "" # k3s generates its CA on first boot; fetch it with the kubeconfig below.
  description = "Not exported by Terraform for k3s; retrieve via kubeconfig_hint."
}

output "kubeconfig_hint" {
  value       = "ssh root@${hcloud_server.control_plane.ipv4_address} 'cat /etc/rancher/k3s/k3s.yaml' | sed 's/127.0.0.1/${hcloud_server.control_plane.ipv4_address}/' > ${var.cluster_name}.kubeconfig"
  description = "Fetch the k3s kubeconfig and rewrite its server address to the public IP."
}
