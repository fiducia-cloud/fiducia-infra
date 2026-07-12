# modules/aks — Azure AKS cluster

Terraform module that provisions one AKS cluster (+ resource group) as a fiducia
failure domain. Honors the shared module contract (see `../../README.md`) so the e2e
env treats every cloud uniformly. e2e/test-grade baseline. Note: Azure is deployed
node-only in the current topology (the brain group is pinned at 3 members).
