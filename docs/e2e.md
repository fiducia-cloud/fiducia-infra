# End-to-end test infrastructure

How we test the coordination primitives — locks, semaphores, RW-locks, idempotency
keys, rate limiting, cron, KV+watches, leader election, service discovery — across
multiple Kubernetes clusters on multiple clouds, and prove the multi-cluster quorum
invariant holds when a whole cluster dies.

There are **two tiers**. They share one behavioral suite ([`fiducia-e2e`](https://github.com/fiducia-cloud/fiducia-e2e));
only the target changes.

```
                 fiducia-e2e  (conformance/ + chaos/, Node --test)
                          │  FIDUCIA_E2E_BASE_URL / FIDUCIA_E2E_ENDPOINTS
        ┌─────────────────┴──────────────────┐
        ▼                                     ▼
  Tier 1: kind (local, free, CI)      Tier 2: real managed clusters (terraform)
  fiducia-infra/kind                  fiducia-infra/terraform
  one cluster, 4 zone-labeled nodes   GKE + EKS + AKS + Hetzner(k3s)
  "kill a cluster" = drain a zone     "kill a cluster" = real cluster/LB down
```

## Tier 1 — `kind` (the CI default)

[`../kind`](../kind): one local kind cluster whose four workers are labeled with
distinct failure domains (`topology.kubernetes.io/zone` = gcp/aws/hetzner/azure).
fiducia-node's `topologySpreadConstraints` place one replica per zone, so the
"one replica per cluster" invariant is reproduced with zero cloud spend, and a
chaos test drains a zone to simulate losing a cluster.

```sh
tools/kind-up.sh                                   # create + deploy fiducia
FIDUCIA_E2E_BASE_URL=http://localhost:8090 \
  npm --prefix ../fiducia-e2e test                 # run the suite
tools/kind-down.sh
```

Runs on every push via the `topology` + `terraform` CI jobs (overlay build +
IaC validation); the full deploy-and-test path is `workflow_dispatch`-gated
(`kind-e2e` job) because it needs a built `fiducia-node` image.

## Tier 2 — real managed clusters (`terraform`)

[`../terraform`](../terraform): IaC for the actual clusters the fleet runs on —
GKE, EKS, AKS, and a Hetzner k3s cluster (Hetzner has no managed k8s) — each behind
an `enable_<cloud>` toggle, cluster names/regions mirroring
[`../topology.toml`](../topology.toml).

```sh
cd terraform/envs/e2e && terraform init
terraform apply -var enable_gcp=true -var enable_aws=true \
                -var enable_azure=true -var enable_hetzner=true
# fetch a kubeconfig per cluster (terraform output kubeconfig_hints), then:
kubectl --context <ctx> apply -k ../../clusters/<cloud>    # deploy fiducia
FIDUCIA_E2E_ENDPOINTS="$(terraform output -raw endpoints)" \
  npm --prefix ../../../fiducia-e2e test                   # run against real LBs
```

`terraform apply` is **never** run in CI — CI only `fmt`-checks and `validate`s.
Real-cloud e2e is operator-run.

## The suite ([`fiducia-e2e`](https://github.com/fiducia-cloud/fiducia-e2e))

- **`conformance/`** — one spec per primitive family, asserting the real-world
  contract behind each use case (e.g. locks → a second holder is refused, which is
  what makes Terraform state locks / deploy locks / migration guards safe; idempotency
  → exactly-once webhook/payment processing; semaphores → concurrency caps hold).
- **`chaos/`** — the multi-cluster invariant: with ≥3 endpoints, a lock taken via
  cluster A is observable via cluster B (cross-cluster linearizability), and after a
  cluster is removed the remaining 2/3 still commit new locks. Disruptive
  cluster-kill steps are gated behind `FIDUCIA_E2E_ALLOW_DISRUPTIVE=1`.
- Both **skip cleanly** when no endpoint is configured, so `npm test` is safe to run
  with nothing deployed.

## Which tier to use

| Question | Tier 1 (kind) | Tier 2 (terraform) |
|----------|---------------|--------------------|
| Cost | free | real cloud spend |
| Runs in CI | yes (every push) | no (operator-run) |
| Cross-cloud networking / WAN Raft timing | simulated (zones) | real |
| Real cloud provider quirks (storage classes, LBs) | no | yes |
| "Kill a cluster" fidelity | drain a zone | drop a real cluster/LB |

Use Tier 1 for fast, deterministic correctness on every change; Tier 2 before a
release, to catch what only real clouds and real WAN latency surface.
