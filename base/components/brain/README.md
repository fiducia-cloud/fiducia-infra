# components/brain — the control-plane brain (optional component)

`fiducia-brain` packaged as a Kustomize **Component** so only brain-member clusters
pull it in (via `components:` in their `clusters/<name>/kustomization.yaml`). The brain
runs one member per member-cluster; together they form a single Raft group that makes
placement/scaling decisions and survives losing any one cluster.

The group must stay an **odd** size (`topology.toml` + `tools/render.mjs` enforce it),
which is why it's a component clusters opt into rather than part of `base/`.

- `statefulset.yaml` — the brain workload (stable identity + durable placement-map
  storage) plus the same metrics sidecar image used by node pods, configured in
  brain/exporter mode. Only the brain container receives the KubeOracle token.
- `service.yaml` — headless service for HTTP (:8095) + Raft peer (:9095) addressing.
- `networkpolicy.yaml` — restricts the control plane to in-namespace callers and
  permits only the cross-cluster brain-Raft peer port for external ingress/egress.
- `kustomization.yaml` — the Component definition.
