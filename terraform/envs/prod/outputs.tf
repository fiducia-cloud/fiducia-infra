# Per-cluster endpoints, for wiring topology.toml's *_endpoint values and the
# kubectl contexts the clustermesh + argocd steps consume.

output "hetzner" {
  value = var.enable_hetzner ? {
    name            = module.hetzner[0].name
    endpoint        = module.hetzner[0].endpoint
    kubeconfig_hint = module.hetzner[0].kubeconfig_hint
  } : null
  description = "Hetzner cluster endpoint + kubeconfig hint."
}

output "vultr" {
  value = var.enable_vultr ? {
    name            = module.vultr[0].name
    endpoint        = module.vultr[0].endpoint
    kubeconfig_hint = module.vultr[0].kubeconfig_hint
  } : null
  description = "Vultr cluster endpoint + kubeconfig hint."
}

output "civo" {
  value = var.enable_civo ? {
    name            = module.civo[0].name
    endpoint        = module.civo[0].endpoint
    kubeconfig_hint = module.civo[0].kubeconfig_hint
  } : null
  description = "Civo cluster endpoint + kubeconfig hint."
}
