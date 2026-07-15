# components

Optional kustomize components layered onto the base by cluster overlays.
`brain/` deploys the control plane (one member per cluster; only the three
brain-bearing clusters include it, keeping the brain Raft group at 3 voters).
A component owns everything for its workload: statefulset (app + the shared
node-sidecar image in exporter mode), service, networkpolicy.
