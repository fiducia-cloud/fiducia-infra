# load-balance — the per-cluster router

Manifests for `fiducia-load-balance`, the stateless regional router that maps a
key → shard → current leader node and terminates the public coordination API. It holds
no consensus state (just a cache), so it's a plain `Deployment` that scales freely.
Each cluster runs its own; the Cloudflare edge steers clients to a healthy cluster's LB.

- `deployment.yaml` — the router workload.
- `service.yaml` — the public `LoadBalancer` entrypoint listed in `FIDUCIA_REGIONS`.
