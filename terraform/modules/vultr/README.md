# terraform/modules/vultr — Vultr Kubernetes Engine (VKE)

Brings up one managed VKE cluster with a `node_count`-sized worker pool for a
fiducia failure domain. Managed control plane (no raw VMs, unlike the Hetzner
module). Auth: `export VULTR_API_KEY=…`.

Same module interface as every other provider module — inputs
`cluster_name`/`region`/`node_count`/`plan`/`k8s_version`, outputs
`name`/`endpoint`/`ca_certificate`/`kubeconfig_hint` (+ `kubeconfig`) — so a
cluster is swapped by pointing its `terraform/envs/*` stanza at a different
module; nothing in `base/` or the app changes.

`node_count` defaults to **5** to satisfy the one-node-pod-per-machine host
anti-affinity (`topology.toml` `node_replicas = 5`).
