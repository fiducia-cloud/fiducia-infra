# base — shared manifests

The Kustomize base every cluster overlay builds on. **Not applied directly** — the
overlays under `clusters/` (and `kind/overlay/`) add the cluster-specific ConfigMap,
storage class, and replica counts on top.

- `namespace.yaml` — the `fiducia` namespace.
- `networkpolicy.yaml` — namespace-wide ingress/egress default-deny plus scoped
  CoreDNS, same-namespace service traffic, and health-probe allowances.
- `node/` — the `fiducia-node` data plane (StatefulSet + sidecar) and its services.
- `load-balance/` — the stateless per-cluster router (Deployment + LoadBalancer).
- `observability/` — the per-cluster OpenTelemetry agent.
- `components/brain/` — the control-plane brain as an **optional** Kustomize Component,
  included only by clusters that are members of the brain Raft group.
- `kustomization.yaml` — wires the always-on pieces together (brain is deliberately
  excluded here).
