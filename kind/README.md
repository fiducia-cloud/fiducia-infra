# kind — local single-cluster test (Tier 1)

Ephemeral local Kubernetes for the fiducia-e2e conformance + chaos suite, with **no
cloud spend**. This is **Tier 1** (one cluster, zone-labeled workers) of the test
ladder. For **cross-cluster** Raft — three *separate* kind clusters
(hetzner/vultr/civo) with WAN latency + partition injection — see **Tier 2** in
[`multicluster/`](multicluster). Real managed clusters (Tier 4) live in
[`../terraform`](../terraform). Full ladder: [`../docs/e2e.md`](../docs/e2e.md).

## What it is

One kind cluster ([`multizone.yaml`](multizone.yaml)) with a control-plane + **four
worker nodes, each labeled a distinct failure domain**
(`topology.kubernetes.io/zone` = `hetzner` / `vultr` / `civo` / `digitalocean` —
mirroring the prod trio plus the documented node-only 4th domain). The fiducia
base manifests already carry `topologySpreadConstraints`, so the four
`fiducia-node` replicas land **one per zone** — reproducing the fleet's
"one replica per cluster" invariant locally.

```
        kind cluster "fiducia"  (localhost:8090 -> NodePort 30090)
        4 workers, topology.kubernetes.io/zone =
   ┌────────────────┬────────────────┬────────────────┬────────────────┐
   │ hetzner        │ vultr          │ civo           │ digitalocean   │
   │ node-0         │ node-1         │ node-2         │ node-3         │   one Raft group
   └────────────────┴────────────────┴────────────────┴────────────────┘
   "kill a cluster" == cordon+drain one zone's node -> 3/4 remain -> quorum holds
```

## Use it

```sh
tools/kind-up.sh                              # create + deploy (needs a fiducia-node image)
FIDUCIA_E2E_BASE_URL=http://localhost:8090 \
  npm --prefix ../fiducia-e2e test            # run the conformance suite
tools/kind-down.sh                            # delete the cluster
```

The deploy step needs a `fiducia-node` image. In CI, build it and load it without a
registry pull:

```sh
docker build -t ghcr.io/fiducia-cloud/fiducia-node:v0.1.0 ../fiducia-node.rs
FIDUCIA_LOAD_IMAGES=1 tools/kind-up.sh
```

## Chaos: simulating a cluster loss

The fiducia-e2e `chaos/` suite proves the 2-of-N quorum invariant. Against kind,
"losing a cluster" is draining one zone's node:

```sh
kubectl cordon <node-for-zone-vultr>
kubectl drain  <node-for-zone-vultr> --ignore-daemonsets --delete-emptydir-data
# assert: existing locks still observable, a NEW lock still commits on 3/4
kubectl uncordon <node-for-zone-vultr>            # heal
```

## Fidelity limits (so the model is honest)

- **One physical cluster, one network.** This exercises the coordination API and
  the failure-domain spread, but not true cross-cloud pod-to-pod networking or WAN
  Raft timing. Those are Tier 2 (`../terraform` + Cilium Cluster Mesh).
- **All pods report `FIDUCIA_CLUSTER=kind`.** The brain's per-cloud placement isn't
  reproduced here; zone spread is enforced by the node labels + `topologySpread`,
  which is what the chaos test relies on.
- Single-cluster Raft group via an explicit in-cluster peer list — see
  [`overlay/topology.env`](overlay/topology.env).
