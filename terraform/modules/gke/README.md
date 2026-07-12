# modules/gke — Google GKE cluster

Terraform module that provisions one GKE cluster + node pool as a fiducia failure
domain. Honors the shared module contract (`cluster_name`, `location`, `node_count`,
`k8s_version`, `labels` → `name`, `endpoint`, `ca_certificate`, `kubeconfig_hint`) so
the e2e env can treat every cloud uniformly. e2e/test-grade baseline — see
`../../README.md` "Cost & safety" before any long-lived use.
