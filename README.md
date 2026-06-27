# fiducia-infra

Kubernetes deployment config for [fiducia.cloud](https://fiducia.cloud) across
**three clusters on three platforms** (GCP, AWS, and a 3rd — here Hetzner), with
one goal:

> **As long as 2 of the 3 clusters are alive, fiducia keeps working.**

This is a **skeleton**: the manifests and the multi-cluster topology are in place;
image references and cross-cluster endpoints are marked `TODO`.

## Why 2-of-3 works: quorum at the cluster level

Fiducia is already a quorum system internally (Raft). The trick here is to make
**the cluster the failure domain** so that quorum spans platforms:

- **Data:** every shard has **replication factor 3**, placed **one replica per
  cluster**. Lose a cluster → each shard still has 2/3 replicas → majority →
  reads and writes continue.
- **Control plane:** `fiducia-brain` runs **one member per cluster** (a 3-member
  Raft group). Lose a cluster → 2/3 brain members remain → placement/scaling
  decisions continue.
- **Routing:** the Cloudflare edge ([`fiducia-edge`](https://github.com/fiducia-cloud/fiducia-edge))
  health-checks each cluster's load balancer and steers clients to a live one.

```
                         Cloudflare edge (fiducia-edge)
                  ┌───────────────┼───────────────┐  (routes to a healthy cluster)
                  ▼               ▼               ▼
            ┌──────────┐    ┌──────────┐    ┌──────────┐
            │  GCP k8s │    │  AWS k8s │    │ Hetzner  │
            │  LB      │    │  LB      │    │  LB      │
            │  brain-1 │◀──▶│  brain-2 │◀──▶│  brain-3 │   one Raft group (RF3)
            │  nodes   │◀──▶│  nodes   │◀──▶│  nodes   │   shard replicas 1/cluster
            └──────────┘    └──────────┘    └──────────┘
                  └───────── cross-cluster Raft (peer transport) ─────────┘

   any ONE cluster down  ⇒  every shard + the brain keep 2/3  ⇒  still serving
```

### The mechanism that enforces it

Each cluster's overlay sets `FIDUCIA_CLUSTER` (gcp/aws/hetzner). The node's
sidecar reports that as its **failure domain** (`FIDUCIA_REGION`) to the brain,
and the brain spreads each shard's 3 replicas across **distinct** failure domains
— i.e. one per cluster. That single label is what turns "3 replicas somewhere"
into "3 replicas, one per platform".

### Limits (so the guarantee is honest)

- Survives **1** cluster loss, not 2 — RF=3 means a majority needs 2 live
  replicas. (After a cluster is down you're running without further redundancy
  until it heals.)
- Therefore you need **≥ 3 clusters**; 2 clusters can't tolerate any loss.
- Strong-consistency writes now commit across clusters, so **commit latency = the
  round-trip to the 2nd-fastest cluster**. That's the price of platform-level
  fault tolerance; the brain places shard leaders to minimize it.

## Stitching the clusters together: one declarative topology

[`topology.toml`](topology.toml) is the **single source of truth** for the whole
multi-cluster deployment — cluster ids, shard count, replication factor, the
connectivity mode, and (crucially) every cluster's **reachable endpoints**:

```toml
[[cluster]]
name = "gcp"
storage_class = "standard-rwo"
node_replicas = 3
brain_endpoint = "brain.gcp.fiducia.cloud:9095"     # how OTHER clusters reach this brain
node_peer_endpoint = "node.gcp.fiducia.cloud:9090"  # how OTHER clusters reach these nodes
lb_endpoint = "https://gcp.lb.fiducia.cloud"        # for the edge
```

`tools/render.mjs` fans that one file out into every cluster's kustomize inputs,
computing each cluster's cross-cluster peer lists automatically (each cluster
gets the *other* clusters' endpoints — never itself):

```sh
node tools/render.mjs          # write the generated inputs
node tools/render.mjs --check  # CI: fail if anything is stale
node --test tools/*.test.mjs   # renderer self-tests
```

Generated, checked-in outputs (do not hand-edit):

| File | Feeds |
|------|-------|
| `clusters/<name>/topology.env` | the `fiducia-cluster` ConfigMap → `FIDUCIA_CLUSTER`, `FIDUCIA_PEERS`, `FIDUCIA_BRAIN_PEERS`, shard count, RF, target nodes |
| `clusters/<name>/patches.yaml` | per-cluster storage class + node replicas |
| `generated/edge-regions.json` | `FIDUCIA_REGIONS` for [`fiducia-edge`](https://github.com/fiducia-cloud/fiducia-edge) |

So the discovery wiring is: **edit `topology.toml` → `render` → commit → ArgoCD
applies each overlay**. Nodes/brains read their peers from the generated
ConfigMap; the edge reads the region list. One place to declare IPs/DNS.

## Cross-cluster connectivity (the transport)

The peer endpoints above must be routable **between** clusters — node ↔ node on
**:9090**, brain ↔ brain on **:9095**. Pick a `connectivity` mode in
`topology.toml`:

- **`clustermesh` (recommended)** — Cilium Cluster Mesh: eBPF pod-to-pod across
  clusters/clouds with stable global-service DNS (so the endpoints can be e.g.
  `fiducia-node.fiducia.svc.clusterset.local:9090`). Bootstrap it with
  [`tools/clustermesh.sh`](tools/clustermesh.sh) (enables mesh on each cluster +
  connects every pair). Also gives **Hubble** observability for free.
- **`wireguard`** — VPN / VPC peering between the clusters.
- **`public-mtls`** — public per-node/brain LoadBalancers with mTLS.

## Observability

Layered — pick the right tool per question, don't reach for packet capture first:

| Question | Tool |
|----------|------|
| service-to-service & cross-cluster network flows | **Cilium + Hubble** (eBPF; node/cluster/Cluster-Mesh scope) |
| app request latency / traces / metrics / logs | **OpenTelemetry → Prometheus + Grafana + Loki + Tempo** |
| "what exact bytes / TCP weirdness / TLS handshake?" | **PCAP** via `ksniff` or cloud packet mirroring → **Wireshark** |
| always-on security analysis | **Zeek / Suricata** |

The `fiducia-node-sidecar` already exposes `/metrics` and ships logs — that's the
feed for the Prometheus/OTel layer. **Hubble/Kubeshark tell you *where* to look;
Wireshark tells you *what* happened once you've captured.** Reach for PCAP only
for low-level bugs, not as the multi-cluster backbone.

Standardizing on **Cilium** makes this cohesive: Cluster Mesh provides the
cross-cluster Raft connectivity above, and Hubble provides the network view on
the same data path.

## Layout

```
topology.toml              SOURCE OF TRUTH — clusters, endpoints, shard/RF, connectivity
tools/
  render.mjs               topology.toml -> per-cluster inputs + edge regions (--check)
  render.test.mjs          renderer self-tests
  clustermesh.sh           Cilium Cluster Mesh bootstrap (enable + connect pairs)
base/                      shared manifests (don't apply directly)
  node/        StatefulSet (node + sidecar container) + services
  brain/       StatefulSet (1 member/cluster) + headless service
  load-balance/ Deployment + LoadBalancer service
clusters/                  per-cluster Kustomize overlays
  gcp/ aws/ hetzner/       kustomization.yaml + GENERATED topology.env & patches.yaml
generated/edge-regions.json  FIDUCIA_REGIONS for fiducia-edge (generated)
argocd/                    ApplicationSet fanning out clusters/<name> -> cluster
```

Why these workload types: **node** and **brain** are Raft members → `StatefulSet`
(stable identity + durable volume for log/snapshots). **load-balance** is a
stateless cache → `Deployment`. The **sidecar** is a second container in the node
pod (its bridge to brain + telemetry).

## Deploy

Render/apply one cluster:

```bash
kubectl --context gcp     apply -k clusters/gcp
kubectl --context aws     apply -k clusters/aws
kubectl --context hetzner apply -k clusters/hetzner
```

Or GitOps it: register all three clusters with one ArgoCD and apply
[`argocd/applicationset.yaml`](argocd/applicationset.yaml).

## Prerequisites / TODO

- **Container images** at `ghcr.io/fiducia-cloud/fiducia-{node,brain,load-balance,node-sidecar}` — build + push (Dockerfiles + CI are a follow-up; the service repos build from source today).
- **Cross-cluster networking** + real `FIDUCIA_PEERS` / `FIDUCIA_BRAIN_PEERS`.
- **StorageClass** names per cluster (overlays use `standard-rwo` / `gp3` / `hcloud-volumes` — adjust to yours).
- Per-cluster **public LB exposure** so the edge can reach each cluster.

## Related

- [`fiducia-node.rs`](https://github.com/fiducia-cloud/fiducia-node.rs) · [`fiducia-brain.rs`](https://github.com/fiducia-cloud/fiducia-brain.rs) · [`fiducia-load-balance.rs`](https://github.com/fiducia-cloud/fiducia-load-balance.rs) · [`fiducia-node-sidecar.rs`](https://github.com/fiducia-cloud/fiducia-node-sidecar.rs) · [`fiducia-edge`](https://github.com/fiducia-cloud/fiducia-edge)
