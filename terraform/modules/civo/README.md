# terraform/modules/civo — Civo Kubernetes (managed k3s)

Brings up one managed Civo Kubernetes cluster with a `node_count`-sized worker
pool for a fiducia failure domain. Auth: `export CIVO_TOKEN=…`.

`cni = "cilium"` is the default because the topology's cross-cluster
connectivity is Cilium **Cluster Mesh** — Civo lets you pick Cilium at cluster
creation, which the raw-VM providers install via cloud-init instead.

Same module interface as every other provider module (inputs
`cluster_name`/`region`/`node_count`/`node_size`, outputs
`name`/`endpoint`/`ca_certificate`/`kubeconfig_hint` + `kubeconfig`), so a cluster
is swapped by re-pointing its `terraform/envs/*` stanza; `base/` and the app are
untouched. `node_count` defaults to **5** for the one-node-pod-per-machine
anti-affinity.
