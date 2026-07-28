# Cron observability stack

`observability/cron-stack` is an **opt-in** Kustomize package for operating
Fiducia cron jobs. It is intentionally not referenced by `base` or any production
overlay: adding a stateful telemetry stack changes storage, ingress, resource,
and retention requirements and must be an explicit environment decision.

The package installs:

- a single trace-consistent OpenTelemetry tail-sampling gateway accepting OTLP gRPC/HTTP;
- Prometheus with cron recording rules and operational alerts;
- Loki with seven-day local log retention;
- Tempo with seven-day local trace retention;
- Grafana with provisioned Prometheus, Loki, and Tempo data sources plus the
  `Fiducia cron operations` dashboard;
- restricted pod-security labels and default-deny network policy.

## Deploy

Create the Grafana administrator secret without committing credentials:

```sh
kubectl -n fiducia-observability create secret generic fiducia-grafana-admin \
  --from-literal=username=admin \
  --from-literal=password="$(openssl rand -base64 32)"
```

Render and inspect before applying:

```sh
kubectl kustomize observability/cron-stack > /tmp/fiducia-cron-observability.yaml
kubectl apply --server-side --dry-run=server -f /tmp/fiducia-cron-observability.yaml
kubectl apply --server-side -f /tmp/fiducia-cron-observability.yaml
```

Expose `fiducia-grafana:3000` through the environment's authenticated ingress;
the base package deliberately creates no public Ingress. The supplied network
policy permits ingress only from the `ingress-nginx` namespace. Patch that
namespace selector in an overlay when a different controller is used.

## Connect Fiducia services

Point the existing per-pod or per-cluster OTel collectors at the central gateway:

```text
http://fiducia-otel-gateway.fiducia-observability.svc:4318
```

For direct OTLP gRPC exporters, use port `4317`. The network policy accepts OTLP
only from the `fiducia` namespace. Patch the source namespace in an overlay when
services run elsewhere.

Fiducia Rust services emit structured JSON logs to container stdout. The gateway's
OTLP logs receiver does **not** tail pod logs by itself. The cluster must run an
authorized log agent that parses those stdout records and sends OTLP logs to this
gateway or writes them directly to Loki. Patch the network policy for that agent's
namespace. Treat an empty Loki data source as a deployment failure rather than as
proof that the services emitted no logs.

Recommended service configuration:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://fiducia-otel-gateway.fiducia-observability.svc:4317
OTEL_SERVICE_NAME=fiducia-node                 # or fiducia-lambda-service
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
FIDUCIA_LOG_FORMAT=json
```

Do not add organization IDs, schedule names, function UUIDs, source code,
request bodies, credentials, or arbitrary errors as Prometheus labels. Run,
trace, and span IDs belong in structured log/trace fields and in the bounded
customer/admin run trail, not metric dimensions. The supplied Prometheus and
Grafana expressions use only the emitted low-cardinality `result`, `trigger`,
`target.kind`, `status.class`, `operation`, `outcome`, `runtime`, and `service`
dimensions.

## Correlation

The gateway deletes common credential, source, request-body, response-body,
payload, database-statement, and environment attributes before export. It keeps
every trace containing `cron.schedule`, all error traces, traces slower than one
second, and ten percent of the remaining baseline. This guarantees that a trace
ID committed to the bounded cron run trail resolves in Tempo while preserving a
bounded sample of unrelated service traffic.

The span-metrics and service-graph connectors generate low-cardinality RED and
edge metrics. OpenMetrics exemplars preserve the exact trace pivot for histogram
samples.

Grafana provisioning enables:

- Prometheus exemplars to Tempo using `trace_id`;
- Loki derived trace-ID links to Tempo;
- Tempo traces-to-logs through Loki;
- Tempo service maps and traces-to-metrics through Prometheus.

The admin cron debugger can set `FIDUCIA_GRAFANA_PUBLIC_URL` to the authenticated
Grafana origin. It generates trace and log deep links without embedding service
credentials.

## Alerts

Prometheus evaluates alerts for:

- sustained cron delivery failures;
- elevated p95 delivery latency;
- retry and deferred-claim saturation;
- repeated managed-function check failures;
- tenant-authorization rejection;
- collector span, log, or metric export failures;
- unavailable Prometheus, OTel, Loki, or Tempo targets.

The scheduler exports `result="delivered"` and `result="failed"`; rules and
dashboards intentionally use that exact contract. The repository test suite
rejects the obsolete `outcome` label and other metric-name drift.

Alert annotations are intentionally generic. Investigators should follow the
trace ID into the admin debugger, Tempo, and Loki rather than copying customer
payloads or function source into notifications.

## Storage and production hardening

The package uses single-replica, filesystem-backed Prometheus, Loki, and Tempo
with PVCs. This is suitable for a small initial production installation and for
staging, but it is not a multi-region durability design.

Before relying on the stack for regulated or high-volume production use:

1. Patch Loki and Tempo to supported object storage with server-side encryption,
   lifecycle rules, and tested restore procedures.
2. Replace single-replica storage components with the upstream distributed or
   highly available deployment mode.
3. Put Grafana behind SSO and role-based access; rotate and remove the bootstrap
   admin credential.
4. Define environment-specific retention, legal hold, and deletion policy.
5. Add persistent Alertmanager routing and notification receivers.
6. Load-test collector queues and backend cardinality with representative cron
   volume before raising sampling or retention.
7. Pin every image by digest through the environment overlay and admit only
   signed images.

The supplied OTel gateway deliberately runs one replica because the tail-sampling
processor is stateful per trace. Do not scale that Deployment directly: a normal
Kubernetes Service can split one distributed trace across workers and produce partial
or contradictory sampling decisions. Production HA requires a stateless OTLP receiver
tier with the Collector load-balancing exporter (or an equivalent consistent-hash
layer) that routes every span for a trace to the same sampling worker. Only that
trace-ID-aware topology may scale the sampling workers horizontally.

Before promoting an HA topology, capture a distributed multi-span trace proving that
all spans with the same trace ID reach one sampler and receive one sampling decision.
