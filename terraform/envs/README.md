# envs

Terraform root modules, one per environment. `e2e/` provisions the real
multi-cloud test fleet (GKE/EKS/AKS/Hetzner-k3s behind `enable_<cloud>`
toggles). Operator-run only — CI never applies; it just fmt-checks/validates.
