# Observability MVP

The production MVP is collector-first:

1. Every Rust service initializes `fiducia-telemetry`.
2. Services emit JSON structured logs to stdout and OTLP traces to the local
   `fiducia-otel-agent` service.
3. The same `fiducia-node-sidecar` image runs once per node or brain pod: node
   mode adds heartbeats and node metrics; brain mode exports placement/control
   plane metrics without registering a node.
4. One OTel agent DaemonSet runs in each Kubernetes cluster. It tails pod logs,
   discovers and scrapes both sidecar profiles,
   receives OTLP, enriches with Kubernetes/cluster metadata, redacts known
   sensitive attributes, batches data, and writes a file-backed exporter queue.
5. Agents forward to a central observability gateway.
6. The gateway fans out raw logs/traces/metrics to the observability stores and
   writes only high-value structured events to CockroachDB TTL tables.

## Why Not Three Cockroach Nodes

Do not run one CockroachDB node in each cloud as the serious production design.
That creates a tiny cross-cloud quorum system with WAN latency on the write path
and no real maintenance slack. Cockroach's baseline production guidance starts
at multiple nodes for fault tolerance, and the multi-cluster Kubernetes pattern
uses multiple pods per region.

The two sane Cockroach shapes are:

- MVP: one small CockroachDB cluster for compact recent events only. Keep raw logs
  out of SQL.
- Durable cross-cloud SQL: three regions with multiple Cockroach nodes per
  region, for example 3 AWS + 3 GCP + 3 Hetzner nodes. Use regional locality and
  reserve it for structured events/audit data, not noisy line logs.

References:

- https://www.cockroachlabs.com/docs/stable/recommended-production-settings
- https://www.cockroachlabs.com/docs/stable/orchestrate-cockroachdb-with-kubernetes-multi-cluster
- https://www.cockroachlabs.com/docs/stable/multiregion-overview
- https://www.cockroachlabs.com/docs/stable/row-level-ttl

## Implemented Here

- `base/observability/otel-agent.yaml` adds the per-cluster OTel agent.
- The agent's Prometheus receiver discovers the named `sidecar` port on both
  `fiducia-node` and `fiducia-brain` pods.
- `base/kustomization.yaml` includes that agent in every cluster overlay.
- The `node`, `node-sidecar`, `brain`, and `load-balance` manifests point
  `OTEL_EXPORTER_OTLP_ENDPOINT` at `fiducia-otel-agent:4317`.
- Workloads set `FIDUCIA_LOG_FORMAT=json` and expose pod/node metadata through
  downward API env vars.
- `docs/observability-events.sql` defines Cockroach TTL tables for retained
  important events and ingest failures.

## Gateway Responsibilities

The central gateway is the place to make expensive whole-system decisions:

- Tail-sample traces, preserving errors and slow requests while sampling normal
  successes.
- Route raw logs to Loki, ClickHouse, or object storage.
- Route metrics to the metrics backend.
- Extract compact event records such as auth failures, quorum changes, scheduler
  decisions, data loss risk, and deployment health transitions.
- Insert those compact events into Cockroach using the schema in
  `docs/observability-events.sql`.

The per-cluster agent intentionally does not tail-sample traces. A trace can
cross nodes or clusters, so tail sampling should happen after traffic converges
at the gateway.

## Agent Configuration

Each cluster agent:

- Receives OTLP over gRPC `4317` and HTTP `4318`.
- Tails `/var/log/pods/fiducia_*/*/*.log`.
- Adds Kubernetes attributes and `fiducia.cluster` / `fiducia.cluster_id`.
- Deletes or hashes common sensitive attributes before export.
- Batches telemetry and uses `file_storage` for persistent exporter queues.

The default gateway endpoint is `https://otel-gateway.fiducia.cloud:4318`. Patch
`OBSERVABILITY_GATEWAY_OTLP_ENDPOINT` per environment if the gateway lives at a
different URL. Create the optional token secret like this:

```sh
kubectl -n fiducia create secret generic fiducia-observability \
  --from-literal=gateway-token='<token>'
```

## Cockroach Retention

Apply the SQL in `docs/observability-events.sql` to the CockroachDB cluster used
by the observability gateway. The current defaults are:

- `important_events`: 14 days
- `observability_ingest_errors`: 7 days

Cockroach row-level TTL is time-based, not size-capped like MongoDB capped
collections. If storage pressure becomes the primary constraint, reduce TTLs,
sample more aggressively at the gateway, or move event bodies to object storage
and keep only indexed metadata in Cockroach.
