# modules

One reusable Terraform module per managed-Kubernetes flavor (`gke/`, `eks/`,
`aks/`, `hetzner/` — k3s, since Hetzner has no managed k8s). Each exposes the
same surface (cluster + kubeconfig outputs) so `envs/e2e` composes any subset.
