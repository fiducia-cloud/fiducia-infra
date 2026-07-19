# End-to-end test infrastructure

How we test the coordination primitives — locks, semaphores, RW-locks, idempotency
keys, rate limiting, cron, KV+watches, leader election, service discovery — across
multiple Kubernetes clusters on multiple clouds, and prove the multi-cluster quorum
invariant holds when a whole cluster dies.

There is **one behavioral suite** ([`fiducia-e2e`](https://github.com/fiducia-cloud/fiducia-e2e))
run against **five tiers of increasing fidelity** — pick the cheapest tier that
answers your question:

```
fiducia-e2e (conformance + chaos)
  ├─ Tier 1: one kind cluster, zone simulation
  ├─ Tier 2: three kind clusters, WAN/partition emulation
  ├─ Tier 3: three kind clusters plus a cross-cluster CNI
  ├─ Tier 4: three vClusters on distinct existing Hetzner Nodes
  └─ Tier 5: physically independent clusters provisioned by Terraform
```

## Tier 1 — `kind` single cluster (the CI default)

[`../kind`](../kind): one local kind cluster whose four workers are labeled with
distinct failure domains (`topology.kubernetes.io/zone` =
hetzner/vultr/civo/digitalocean). fiducia-node's `topologySpreadConstraints` place
one replica per zone, so the "one replica per cluster" invariant is reproduced
with zero cloud spend, and a chaos test drains a zone to simulate losing a cluster.

```sh
tools/kind-up.sh                                   # create + deploy fiducia
FIDUCIA_E2E_BASE_URL=http://localhost:8090 \
  npm --prefix ../fiducia-e2e test                 # run the suite
tools/kind-down.sh
```

Fast and deterministic, but a single cluster + one flat network — it does **not**
reproduce cross-cluster Raft, WAN latency, or independent control planes.

## Tier 2 — `kind` × 3 with WAN emulation (cross-cluster Raft, local)

[`../kind/multicluster`](../kind/multicluster): **three separate kind clusters**
(hetzner/vultr/civo), one `fiducia-node` + one `fiducia-brain` Raft member each,
wired into **cross-cluster Raft groups** over a shared Docker network, with
**latency + partition injection**. This is where you test leader election, quorum,
and recovery the way they behave across clouds — without cloud spend.

```sh
cd kind/multicluster
./up.sh                     # 3 kind clusters, deploy, wire cross-cluster peers
./test/run.sh --scenarios   # leadership + quorum, latency, partition/heal, full provider pause
./netem.sh eu               # ~20ms pairwise RTT; ./partition.sh isolate civo; ./down.sh
```

Its own assertions (`test/run.sh`) prove the cross-cluster invariants directly; the
`fiducia-e2e` suite can also point at the three host ports (8090/8091/8092) via
`FIDUCIA_E2E_ENDPOINTS`. Best cost-to-fidelity tier for consensus work — see its
[README](../kind/multicluster/README.md).

## Tier 3 — `kind` × 3 + a cross-cluster CNI

Only when the thing under test is **pod-to-pod multicluster networking** (not Raft
itself): recreate the Tier-2 clusters with Cilium and connect
[ClusterMesh](../tools/clustermesh.sh) (matches prod `connectivity =
"clustermesh"`), or use Submariner. Adds real cross-cluster pod routing + CNI
policy enforcement at the cost of more moving parts. See
[../kind/multicluster/README.md](../kind/multicluster/README.md).

## Tier 4 — three vClusters on the existing Hetzner cluster

[`../vcluster/hetzner-e2e`](../vcluster/hetzner-e2e) is the current Hetzner-only
proof tier. It installs three isolated Kubernetes control planes on three
distinct region Nodes of the existing five-node kubeadm cluster and creates no
new Hetzner machines. Private vCluster service replication carries Fiducia Raft
traffic; all operator/API access uses foreground loopback port forwards.

The guarded flow validates distinct virtual cluster UIDs and physical Node
placement, uses digest-pinned chart and workload images, forbids host
NodePort/LoadBalancer Services, captures evidence, and invokes the strict
locks/leases proof in `fiducia-e2e`.

This is higher fidelity than local `kind`, but it is still a **shared physical
host cluster**. It cannot prove tolerance of losing that kubeadm control plane or
independent provider networking.

## Tier 5 — real independent clusters (`terraform`)

[`../terraform`](../terraform): IaC for real clusters. The **prod** trio is
hetzner/vultr/civo ([`envs/prod`](../terraform/envs/prod)); a hyperscaler **test
fleet** (GKE/EKS/AKS + Hetzner k3s) lives in [`envs/e2e`](../terraform/envs/e2e),
each behind an `enable_<cloud>` toggle.

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
Real-cloud e2e is operator-run. Only this tier exercises real cloud routing, LBs,
NAT, and independent physical failure domains.

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

| Question | Tier 1 (kind) | Tier 2 (kind ×3) | Tier 4 (Hetzner vCluster ×3) | Tier 5 (physical) |
|----------|---------------|------------------|------------------------------|-------------------|
| Cost | free | free | existing capacity only | real cloud spend |
| Runs in CI | yes | overlay build; deploy gated | render/build checks only; operator-run | no; operator-run |
| Independent Kubernetes APIs | no | yes | **yes, logically isolated** | yes, physically isolated |
| Distinct physical placement | zones in one cluster | Docker containers | **three Hetzner Nodes** | separate clusters/providers |
| Cross-cluster Raft + WAN timing | simulated | emulated with `tc` | real host network, no WAN isolation | real |
| Whole physical cluster/provider loss | no | emulated | no | yes |

Use Tier 1 for fast correctness; **Tier 2 for repeatable WAN and partition
faults**; Tier 3 for cross-cluster CNI behavior; Tier 4 for the current
zero-new-server Hetzner locks/leases proof; and Tier 5 before making physical
failure-domain claims.
