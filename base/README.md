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
- `messaging/` — the hardened NATS/JetStream broker (`fiducia-nats`) with a
  fail-closed out-of-band auth Secret; see `messaging/README.md`.
- `components/brain/` — the control-plane brain as an **optional** Kustomize Component,
  included only by clusters that are members of the brain Raft group.
- `kustomization.yaml` — wires the always-on pieces together (brain is deliberately
  excluded here).

## Image pinning

The four `ghcr.io/fiducia-cloud/*` service images are pinned by **tag**
(`v0.1.0`). Tags are mutable, so this is acceptable only for the kind tiers and
the nonproduction ArgoCD hub — production deploys MUST reference images by
**digest** (`…@sha256:…`), resolved from the registry at promotion time by
fiducia-monorepo's manual deploy workflow. Do not hand-copy digests into these
files.

Digest-pinned today: each service's *build inputs* — every service Dockerfile
pins its Rust builder and distroless runtime base images by digest, kept current
by the weekly Dependabot `docker`-ecosystem bumps in each service repo and the
monorepo — and the third-party images deployed directly from this repo: the
otel-agent collector (`observability/otel-agent.yaml`) and the NATS broker +
exporter (`messaging/nats.statefulset.yaml`).
