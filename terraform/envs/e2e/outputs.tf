# The API-server endpoints of whatever clusters were enabled, keyed by cloud.
output "cluster_endpoints" {
  value = merge(
    var.enable_gcp ? { gcp = module.gcp[0].endpoint } : {},
    var.enable_aws ? { aws = module.aws[0].endpoint } : {},
    var.enable_azure ? { azure = module.azure[0].endpoint } : {},
    var.enable_hetzner ? { hetzner = module.hetzner[0].endpoint } : {},
  )
  description = "cloud -> Kubernetes API server URL for each provisioned cluster."
}

# kubeconfig fetch one-liners, keyed by cloud.
output "kubeconfig_hints" {
  value = merge(
    var.enable_gcp ? { gcp = module.gcp[0].kubeconfig_hint } : {},
    var.enable_aws ? { aws = module.aws[0].kubeconfig_hint } : {},
    var.enable_azure ? { azure = module.azure[0].kubeconfig_hint } : {},
    var.enable_hetzner ? { hetzner = module.hetzner[0].kubeconfig_hint } : {},
  )
  description = "cloud -> command to write a kubeconfig context for that cluster."
}

# The fiducia LB endpoints (from topology.toml) that fiducia-e2e consumes as
# FIDUCIA_E2E_ENDPOINTS once fiducia + its load balancer are deployed on each
# cluster. These are the PUBLIC service endpoints, not the k8s API servers above.
output "endpoints" {
  value = join(",", compact([
    var.enable_gcp ? "https://gcp.lb.fiducia.cloud" : "",
    var.enable_aws ? "https://aws.lb.fiducia.cloud" : "",
    var.enable_azure ? "https://azure.lb.fiducia.cloud" : "",
    var.enable_hetzner ? "https://hetzner.lb.fiducia.cloud" : "",
  ]))
  description = "Comma-separated fiducia LB endpoints for FIDUCIA_E2E_ENDPOINTS."
}
