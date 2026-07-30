# fiducia-operator Phase 1 observer

This crate is the approved observer-only prototype for DEN-79. It lives beside
the GitOps contract while the dedicated `fiducia-operator.rs` repository does
not yet exist. Split it into that repository before publishing the image; keep
the CRD and deployment wiring in `fiducia-infra`.

The reconciler watches `FiduciaCluster` resources, reads the configured local
StatefulSets and PVCs, and writes deterministic conditions to its own CR
status. It reports:

- whether the Raft StatefulSets exist;
- whether rollout is guarded by `OnDelete`;
- whether each workload declares an explicitly retained data PVC;
- how many expected data PVCs are `Bound`;
- Kubernetes replica readiness, explicitly labelled as visibility rather than
  quorum proof; and
- `OperatorMutationReady=False`, `reason=ObserverOnly`.

Even when every Kubernetes storage check passes, the prototype reports phase
`Observed`, not `Ready`: it does not yet call the Raft quorum/version APIs and
must not invent distributed-system health from Kubernetes readiness.

It has no code or RBAC permission to delete Pods, patch/scale StatefulSets,
read Secrets, create snapshots, or mutate/delete PVCs. Those permissions stay
absent until the service gates in `docs/operator-architecture.md` are
implemented and failure-tested.

## Local checks

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --all-targets --locked
cargo run --quiet --bin crdgen | diff -u config/crd.yaml -
```

The controller needs a Kubernetes client at runtime. Its health server listens
on `0.0.0.0:8080` by default:

- `/healthz` — process health;
- `/readyz` — Kubernetes client/controller initialization;
- `/metrics` — small Prometheus text counters.

## Deployment gate

`config/kustomization.yaml` is intentionally not included from `base/`.
Before enabling it in an overlay:

1. publish and digest-pin the reviewed image;
2. install the generated CRD;
3. provide the cluster-specific egress rule to the Kubernetes API server;
4. apply the namespace-scoped RBAC and Deployment;
5. create one `FiduciaCluster` sample; and
6. verify status remains observer-only.

The `fiducia` namespace is default-deny. Portable Kubernetes NetworkPolicy
cannot select the API server Service as a destination, so each cluster overlay
must supply its reviewed API-server CIDR/entity rule. Do not add unrestricted
HTTPS egress to this credential-bearing controller.
