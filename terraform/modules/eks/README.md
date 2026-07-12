# modules/eks — AWS EKS cluster

Terraform module that provisions one EKS cluster + managed node group as a fiducia
failure domain. Uses the account's **default VPC** subnets to stay small (prod TODOs:
dedicated VPC, private subnets, restricted endpoint). Honors the shared module contract
(see `../../README.md`) so the e2e env treats every cloud uniformly. e2e/test-grade baseline.
