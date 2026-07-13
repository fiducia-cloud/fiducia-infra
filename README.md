# fiducia-infra

Kubernetes deployment config for [fiducia.cloud](https://fiducia.cloud) across
**three clusters on three platforms** (GCP, AWS, and a 3rd — here Hetzner), with
one goal:

> **As long as 2 of the 3 clusters are alive, fiducia keeps working.**

The manifests, multi-cluster topology, image references, and cross-cluster
endpoint rendering are declared here.

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

## Leadership is elected, not declared

`topology.toml` declares **membership** (which peers exist + how to reach them) —
never **leadership**. There is no "master node" to point k8s or this config at:

- **Kubernetes control plane** — each cluster has its own (GKE/EKS-managed, or
  kubeadm/k3s on Hetzner). fiducia neither declares nor cares about it; k8s just
  schedules our pods. Nothing in this repo touches it.
- **fiducia leadership** — sharded multi-Raft: every shard's replicas elect their
  own leader, and the brain members elect a brain leader. Leadership is **chosen
  by Raft at runtime**, spreads across nodes/clusters, and **moves automatically
  on failure**. A single `fiducia-node` pod leads some shards and follows others,
  so there isn't even one "master" per cluster.

| Thing | Source | Changes |
|-------|--------|---------|
| membership + endpoints | `topology.toml` → `FIDUCIA_PEERS` / `FIDUCIA_BRAIN_PEERS` | only when you edit + render |
| **which member is leader** | **Raft election** (per shard; per brain group) | continuously; on every failover |
| current leader for routing | LB cache, seeded by the brain + `NotLeader` redirects | continuously |
| *preferred* leader (locality) | brain placement map (its own Raft) | scheduler converges via leadership transfer |

Hardcoding a leader would defeat the design — if the declared master died,
nothing could take over. The point is that election re-runs when a node, or a
whole cluster, fails.

## Traffic Paths

The load balancer is only for customer/application coordination API traffic.
Internal control and replication planes use direct pod/service paths:

| Caller | Target | Uses `fiducia-load-balance`? | Path |
|--------|--------|------------------------------|------|
| external clients / future Cloudflare edge | coordination API | yes | `client -> regional LB :443 -> shard leader node` |
| in-cluster application pods | coordination API | yes | `app pod -> svc/fiducia-load-balance-internal:8088 -> shard leader node` |
| `fiducia-load-balance` | data-plane nodes | direct after routing | `LB -> fiducia-node-peer/fiducia-node-client :8090` |
| `fiducia-node` | other `fiducia-node` peers | no | direct Raft RPC from `FIDUCIA_PEERS` to `/raft/{shard}/{append,vote}` |
| `fiducia-node-sidecar` | its local node | no | `localhost:8090 /v1/status` inside the same pod |
| `fiducia-node-sidecar` | `fiducia-brain` | no | direct `svc/fiducia-brain:8095 /v1/nodes/{id}/heartbeat` |
| `fiducia-brain` | node membership/placement state | no | receives sidecar heartbeats; it does not route through the LB |
| Kubernetes kubelet | pod health probes | no | direct pod IP HTTP probes on each container port |

TLS terminates at the regional LoadBalancer on port 443; that public Service does
not expose port 80. A separate `fiducia-load-balance-internal` ClusterIP exposes
the cleartext `:8088` listener only inside the cluster for probes and trusted
callers. Before deploying the base manifests, create the per-cluster secrets:

```sh
kubectl -n fiducia create secret tls fiducia-load-balance-tls \
  --cert=/path/to/tls.crt \
  --key=/path/to/tls.key

kubectl -n fiducia create secret generic fiducia-secrets \
  --from-literal=internal-secret="$(openssl rand -hex 32)" \
  --from-literal=brain-raft-secret="$(openssl rand -hex 32)"
```

The `fiducia-secrets` references are intentionally required. Missing or renamed
keys keep workloads unscheduled instead of starting nodes, sidecars, brain, or
the load balancer with trusted-hop or Raft authentication disabled.

**Bootstrap (the one seed):** a brand-new Raft group still needs a first member
to count the first vote — bring up **one** member as a single-member group, then
add the rest via Raft membership change (join as learner → promote to voter).
That seed is *not* a permanent master; leadership floats freely once the group
forms. Static peer membership is declared through the generated topology env,
and runtime leadership remains a Raft decision.

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
| app request latency / traces / metrics / logs | **OpenTelemetry agents → central gateway → Prometheus/Grafana + Loki/ClickHouse/object storage + Tempo** |
| recent structured ops/security events | **CockroachDB TTL tables** fed by the gateway, not by raw log firehose |
| "what exact bytes / TCP weirdness / TLS handshake?" | **PCAP** via `ksniff` or cloud packet mirroring → **Wireshark** |
| always-on security analysis | **Zeek / Suricata** |

Each cluster now inherits `base/observability/otel-agent.yaml`: an OTel Collector
DaemonSet that receives OTLP, tails JSON pod logs, redacts known sensitive
attributes, batches data, and uses a file-backed queue before forwarding to the
central gateway. The gateway is where tail sampling and durable storage fan-out
belong. Raw logs should land in Loki, ClickHouse, or object storage; CockroachDB
only stores compact high-value events with row-level TTL. See
[`docs/observability.md`](docs/observability.md) and
[`docs/observability-events.sql`](docs/observability-events.sql).

**Hubble/Kubeshark tell you *where* to look; Wireshark tells you *what* happened
once you've captured.** Reach for PCAP only for low-level bugs, not as the
multi-cluster backbone.

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

> **A 4th platform (Azure) is now in [`topology.toml`](topology.toml).** RF stays 3,
> so each shard's replicas still spread one-per-cluster across three distinct
> failure domains; the 4th cluster adds a spare domain + capacity and does **not**
> change the "survive losing 1 cluster" guarantee. The kustomize model is N-cluster
> already — `render.mjs` fans out to every `[[cluster]]` block.
>
> Azure is added **node-only** (`brain = false`): the brain Raft group must stay an
> **odd** size, so it's pinned at 3 (gcp/aws/hetzner). Brain-member clusters include
> the [`base/components/brain`](base/components/brain) Component; node-only clusters
> omit it. `render.mjs` enforces an odd, ≥ RF brain group.

## Provisioning & testing

The overlays below assume the clusters exist. Two sibling tiers stand them up and
test the coordination API across them — see [`docs/e2e.md`](docs/e2e.md):

- [`terraform/`](terraform) — **Tier 2**: IaC for the real managed clusters
  (GKE / EKS / AKS / Hetzner k3s), each behind an `enable_<cloud>` toggle.
- [`kind/`](kind) + [`tools/kind-up.sh`](tools/kind-up.sh) — **Tier 1**: one local
  kind cluster with four zone-labeled workers simulating the failure domains, for
  free CI conformance + chaos runs.
- [`fiducia-e2e`](https://github.com/fiducia-cloud/fiducia-e2e) — the shared
  Node `--test` suite (per-primitive conformance + multi-cluster fault injection)
  that runs against either tier.

## Deploy

Render/apply one cluster:

```bash
kubectl --context gcp     apply -k clusters/gcp
kubectl --context aws     apply -k clusters/aws
kubectl --context hetzner apply -k clusters/hetzner
kubectl --context azure   apply -k clusters/azure
```

Or GitOps it: register all the clusters with one ArgoCD and apply
[`argocd/applicationset.yaml`](argocd/applicationset.yaml).

## Prerequisites

- **Container images** at `ghcr.io/fiducia-cloud/fiducia-{node,brain,load-balance,node-sidecar}`.
- **Cross-cluster networking** + real `FIDUCIA_PEERS` / `FIDUCIA_BRAIN_PEERS`.
- **StorageClass** names per cluster (overlays use `standard-rwo` / `gp3` / `hcloud-volumes` — adjust to yours).
- Per-cluster **public LB exposure** so the edge can reach each cluster.

## Related

- [`fiducia-node.rs`](https://github.com/fiducia-cloud/fiducia-node.rs) · [`fiducia-brain.rs`](https://github.com/fiducia-cloud/fiducia-brain.rs) · [`fiducia-load-balance.rs`](https://github.com/fiducia-cloud/fiducia-load-balance.rs) · [`fiducia-node-sidecar.rs`](https://github.com/fiducia-cloud/fiducia-node-sidecar.rs) · [`fiducia-edge`](https://github.com/fiducia-cloud/fiducia-edge)
