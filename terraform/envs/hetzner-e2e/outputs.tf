output "fleet" {
  value = {
    for name, cluster in module.cluster : name => {
      kubernetes_context = "fiducia-e2e-${name}"
      location           = local.clusters[name].location
      public_ipv4        = cluster.public_ipv4
      private_ipv4       = cluster.private_ipv4
      api_endpoint       = cluster.endpoint
      node_tunnel_url    = "http://127.0.0.1:${local.clusters[name].node_tunnel_port}"
      lb_tunnel_url      = "http://127.0.0.1:${local.clusters[name].lb_tunnel_port}"
    }
  }
  description = "Non-secret connection inventory consumed by the guarded operator scripts."
}

output "expected_cluster_count" {
  value       = length(module.cluster)
  description = "Zero while the optional profile is disabled; exactly three after an explicitly confirmed enable."
}

output "network_id" {
  value       = try(hcloud_network.fleet[0].id, null)
  description = "Shared isolated private network for inter-cluster Raft NodePorts."
}

output "expires_on" {
  value       = var.expires_on
  description = "Manual review/teardown marker. No automation destroys this fleet."
}
