# Local 3-cluster emulation (Tier 2) — cross-cluster Raft without real clouds

Emulate the production **three-cloud** topology (hetzner / vultr / civo) on one
machine: **three separate Kind clusters**, each running one `fiducia-node` + one
`fiducia-brain` Raft member, wired into **cross-cluster Raft groups** over a shared
Docker network, with **WAN latency + partition injection** so you can test leader
election, quorum, and recovery the way they'll actually behave across clouds.

> **Why not three namespaces in one cluster?** Namespaces share the API server,
> nodes, CNI, and a flat low-latency network — so they can't reproduce the things
> that break Raft across clouds: real network boundaries, WAN RTT, independent
> control planes, and partitions. Namespaces are a resource boundary *inside* one
> cluster, not a stand-in for independently-operated clusters. This tier uses three
> real clusters + fault injection instead.

This is the missing middle of the test ladder — see [../README.md](../README.md)
(single-cluster Tier 1) and [../../terraform](../../terraform) (real clusters).

---

## The test ladder (where this fits)

| Tier | What | Fidelity | Cost | Here |
|------|------|----------|------|------|
| **1** | one Kind cluster, 4 zone-labeled workers ([../multizone.yaml](../multizone.yaml)) | app + failure-domain spread; single network | free | [../README.md](../README.md) |
| **2** | **three Kind clusters + exposed peer ports + fault injection** | **separate control planes, cross-cluster Raft, emulated WAN/partitions** | **free** | **this dir** |
| **3** | Tier 2 **+ Cilium ClusterMesh / Submariner** | + real cross-cluster *pod* networking, CNI policy | free | [§ Optional CNI](#optional-real-cross-cluster-pod-networking-cilium--submariner) |
| **4** | three **real** clusters (hetzner/vultr/civo) | real cloud routing, LBs, physical failure domains | 💸 | [../../terraform/envs/prod](../../terraform/envs/prod) |

Tier 2 is the best cost-to-fidelity option for cross-cluster Raft work: it
reproduces separate Kubernetes control planes and cross-cluster consensus over an
emulated WAN, without a cross-cluster CNI (which you only need to test pod-to-pod
multicluster networking — Tier 3).

---

## Architecture

```
  host (127.0.0.1)                 shared "kind" Docker network
  ┌───────────────┐    ┌──────────────────────────────────────────────────┐
  │ :8090 hetzner │◀──▶│  fiducia-hetzner-control-plane                    │
  │ :8091 vultr   │    │    node(1) + brain(1)  NodePorts 30090/30095 ─┐   │
  │ :8092 civo    │    │  fiducia-vultr-control-plane                  │   │
  │ (test/run.sh) │    │    node(1) + brain(1)  30090/30095 ───────────┼─▶ │  cross-cluster
  └───────────────┘    │  fiducia-civo-control-plane                   │   │  Raft groups:
                       │    node(1) + brain(1)  30090/30095 ───────────┘   │  node↔node :9090
                       └──────────────────────────────────────────────────┘  brain↔brain :9095
   fault injection (host): netem.sh = tc on each container's eth0 (WAN RTT)
                           partition.sh = iptables between containers (outages)
```

- **1 node + 1 brain per cluster** (3 + 3). One Raft member per cloud makes each
  cross-cluster group a clean 3 — one per cluster, each individually addressable
  via its NodePort. (Prod runs 5 nodes/cluster; the emulation reduces to 1 for
  addressability + to keep three local clusters light.)
- **Cross-cluster peers by IP.** Pods can't resolve Kind container DNS names, so
  [up.sh](up.sh) discovers each cluster's control-plane container IP on the `kind`
  network and writes `<ip>:30090` / `<ip>:30095` into the other clusters'
  [`topology.env`](hetzner/topology.env). Pods reach those IPs across the shared
  Docker bridge (Kind masquerades pod egress out the node).
- **Same manifests as prod.** The overlays reuse [`../../base`](../../base) — the
  real `fiducia-node` + `fiducia-brain` StatefulSets — trimmed to the Raft slice
  (LB + otel-agent are `$patch:delete`-d; see [common/kustomization.yaml](common/kustomization.yaml)).
- **Prod Raft timing.** [`topology.env`](hetzner/topology.env) carries the real
  cross-cloud `FIDUCIA_RAFT_*` (heartbeat 100 ms, election 600 ms) from
  [`../../topology.toml`](../../topology.toml) — the point is to validate *those*
  values under emulated WAN.

---

## Prerequisites

`kind`, `kubectl`, `docker`, and (for the tests) `curl` + `jq`. Plus the fiducia
images — build + load them so there's no registry pull:

```sh
docker build -t ghcr.io/fiducia-cloud/fiducia-node:v0.1.0    ../../../fiducia-node.rs
docker build -t ghcr.io/fiducia-cloud/fiducia-brain:v0.1.0   ../../../fiducia-brain.rs
docker build -t ghcr.io/fiducia-cloud/fiducia-node-sidecar:v0.1.0 ../../../fiducia-node-sidecar.rs
FIDUCIA_LOAD_IMAGES=1 ./up.sh
```

Rough footprint: 3 single-node Kind clusters ≈ 3 containers + 12 Fiducia pods
(one node, one brain, and two load-balancer replicas per cloud)
(~3–4 GB RAM). Distinct Pod/Service CIDRs per cluster (10.10/10.20/10.30) so
cross-cluster traffic never collides.

---

## Runbook

```sh
./up.sh                       # create 3 kind clusters, deploy, wire cross-cluster peers
./test/run.sh                 # assert: reachable, leader per shard, quorum, spread
./test/run.sh --scenarios     # + WAN, partition/heal, whole-provider failover

./netem.sh eu                 # ~10ms±3 egress each  -> ~20ms pairwise RTT (nearby EU)
./netem.sh continental        # ~45ms±10 each        -> ~90ms RTT (US<->EU stress)
./netem.sh clear

./partition.sh isolate civo   # cut civo off; hetzner+vultr keep 2/3 quorum
./partition.sh directed hetzner vultr   # one-way (asymmetric) drop
./partition.sh split-brain    # 1-1-1: nobody has quorum (reads refused)
./partition.sh heal

./down.sh                     # delete all three clusters
```

Watch it live from another shell (the node guards `/v1` with the trusted-hop
header, so pass the dev secret up.sh installed):

```sh
H='x-fiducia-internal-auth: emulation-internal-secret-do-not-use-in-prod'
watch -n1 "for p in 8090 8091 8092; do echo \"== :\$p ==\"; \
  curl -s -H '$H' localhost:\$p/v1/status | \
  jq '{cluster:.node_id, leads:(.leading_shards|length), quorum:([.shards[]|select(.role==\"leader\")|.has_quorum]|all)}'; done"
```

---

## What `test/run.sh` asserts

**Core** (`GET /v1/status` on each cluster — org-exempt, but still trusted-hop
authenticated, so the test sends the internal-auth header up.sh installed):

- every cluster is reachable and reports the configured `shard_count`;
- **every hosted shard knows its leader** (`leader_id` non-empty) — the cross-
  cluster group elected one;
- **leadership is safe** — the union of `leading_shards` across the three
  clusters covers *all* shards exactly once (no leaderless shard or
  split-brain). Placement may temporarily concentrate leadership while the
  brain scheduler rebalances, so an even per-cluster split is not an invariant;
- **no leader shard is without quorum** (`has_quorum` holds).

**Data path** (best-effort direct-node plus required LB path, authed
`PUT/GET /v1/kv`): write a key on the shard's leader cluster and read it back
across clusters; then write and read through different local load balancers.
The direct-node portion skips cleanly if writes are leader-only, but the LB path
is required and proves the actual client entrypoint.

**Scenarios** (`--scenarios`): under **EU latency**, leadership + quorum stay
stable (proving heartbeat 100 ms > RTT); **isolating civo** keeps the other two at
2/3 quorum while civo leads nothing with quorum; **healing** rejoins civo and
re-covers all shards. Finally, the runner pauses the whole Civo Kind control
plane—not just its Raft links—proves survivor LB writes and cross-LB reads
commit within a bounded ten-second leader-table refresh window, then resumes
Civo and requires every leader to return to 3 healthy replicas.

### Raft scenarios worth exercising

The commands above cover the important cases; extend `test/run.sh` for more:
normal operation at different RTTs (`netem.sh delay`), steady packet loss
(`netem.sh loss <cluster> <pct>`), one-way failures (`partition.sh directed`),
full isolation (`isolate`), the `1-1-1` no-quorum split (`split-brain`), leader
process kill (`kubectl delete pod`), destructive cluster reconstruction (`kind
delete cluster`), and re-election racing with recovery (`heal` right after a
kill). `--scenarios` already covers a non-destructive whole-provider outage via
`docker pause`.

---

## Optional: real cross-cluster *pod* networking (Cilium / Submariner)

Tier 2 deliberately uses **exposed NodePorts**, not a cross-cluster CNI — for Raft
testing you only need stable, mutually-reachable TCP endpoints, and adding a mesh
introduces sidecars/tunnels that can mask bugs in the Raft implementation itself.
Add a multicluster CNI only when the thing under test is pod-to-pod multicluster
networking or multicluster DNS/Services:

- **Cilium ClusterMesh** — matches prod ([`../../topology.toml`](../../topology.toml)
  `connectivity = "clustermesh"` + [`../../tools/clustermesh.sh`](../../tools/clustermesh.sh)).
  Recreate each cluster with `disableDefaultCNI: true` + `kubeProxyMode: none`,
  install Cilium, then connect the mesh. This is the highest-fidelity local tier.
- **Submariner** — its quickstart is literally three Kind clusters on one machine;
  good for a generic encrypted inter-cluster network.

Under a policy-enforcing CNI the base default-deny NetworkPolicy becomes live, so
you must also open the NodePort/API paths the tests use (kindnet ignores
NetworkPolicy, which is why they work by default here).

## Optional: deterministic pairwise faults (Toxiproxy)

`netem.sh` applies uniform per-cluster egress delay (simple, covers most cases).
For **precise directed/asymmetric** faults per peer link, run a
[Toxiproxy](https://github.com/Shopify/toxiproxy) container on the `kind` network
and point each cluster's `FIDUCIA_PEERS` at a per-`(src,dst)` proxy; then toggle
latency/timeout/bandwidth toxics per directed path. It's more setup than
`partition.sh directed` but gives fine-grained, scriptable control.

---

## Fidelity limits (so the model stays honest)

This is a strong approximation, **not** a replacement for real clouds:

- **One host, one kernel, one Docker.** Three independent Kubernetes control
  planes — but they share the machine, kernel, container runtime, disk, and power.
  Not real physical failure domains (that's Tier 4).
- **1 node/cluster, not 5.** The cross-cluster group is 3 members (one per cloud),
  which faithfully tests cross-cluster consensus, but not the 5-nodes-per-cluster
  intra-cluster placement — use Tier 1 or Tier 4 for that.
- **kindnet doesn't enforce NetworkPolicy.** The base default-deny is inert here
  (convenient for the NodePort paths); policy enforcement is Tier 3 / real clouds.
- **No real cloud routing / LBs / NAT.** No cloud load balancers, provider
  maintenance, or Internet-backbone behavior. Emulated latency ≠ real jitter.
- **Latency is applied at eth0**, so it models cross-cluster (+ host) RTT and
  leaves intra-cluster traffic fast — accurate for WAN emulation, but it can't
  express per-`(src,dst)` asymmetry without tc filters or Toxiproxy.

### macOS / Docker Desktop notes

Kind nodes are Linux containers even on macOS, so `tc`/`iptables` run *inside*
them (`docker exec`) and work as written — no host root needed. The coordination
APIs are published to `127.0.0.1:8090-8092` via the Kind configs. Give Docker
Desktop enough RAM (≥ 6 GB recommended for three clusters).

---

## See also

- [../../docs/multi-cluster-architecture.md](../../docs/multi-cluster-architecture.md) — the production architecture this emulates
- [../README.md](../README.md) — Tier 1 (single-cluster) kind
- [../../terraform/envs/prod](../../terraform/envs/prod) — Tier 4 (real hetzner/vultr/civo)
- [../../docs/e2e.md](../../docs/e2e.md) — the overall test-tier strategy
