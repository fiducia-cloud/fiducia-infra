# Cron jobs observability and runbook

This document covers the end-to-end telemetry path for Fiducia cron jobs as a
service. The application changes live in `fiducia-node.rs`,
`fiducia-lambda-service.rs`, `fiducia-customer.rs`, and `fiducia-admin.rs`; this
repository owns the collector, backend, dashboard, and alerting contract.

## Signal flow

```text
fiducia-node cron runner ─┐
                          ├─ OTLP traces + metrics ─> per-cluster OTel agent
fiducia-lambda-service ───┤                         └─ JSON pod logs
customer/admin BFFs ──────┘                                  │
                                                             ▼
                                                central OTel gateway
                                             ┌──────────┬──────────┐
                                             ▼          ▼          ▼
                                       Prometheus     Loki       Tempo
                                             └──────────┴──────────┘
                                                        ▼
                                                     Grafana
```

The node writes the terminal run record only after a Raft-committed claim and a
bounded delivery attempt. That run record stores the trace id and span id, so the
customer and admin views can pivot into Tempo without putting source code,
payloads, or credentials in replicated state.

## Repository assets

- `base/observability/otel-agent.yaml` — per-cluster receiver, Kubernetes
  enrichment, redaction, batching, and durable forwarding queue.
- `observability/central/cron-otel-gateway.yaml` — central tail sampling,
  span-metrics connector with exemplars, and backend fan-out.
- `base/observability/cron-prometheus-rules.yaml` — recording and alert rule
  ConfigMap. A central rule loader should select
  `fiducia.cloud/prometheus-rules=true`; the file is not included in the
  data-plane base kustomization.
- `observability/central/grafana-cron-datasources.yaml` — Prometheus/Loki/Tempo
  datasource correlations.
- `observability/central/grafana/fiducia-cron-dashboard.json` — importable
  Grafana dashboard.

## Deployment

### Per-cluster agent

Every Fiducia workload sends OTLP to the in-cluster agent:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://fiducia-otel-agent.fiducia.svc.cluster.local:4317
FIDUCIA_LOG_FORMAT=json
```

Services with a native Prometheus `/metrics` route can additionally opt into the
agent's annotation-based scrape receiver:

```yaml
metadata:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/path: /metrics
    prometheus.io/port: "8083"
```

Use an explicit numeric port annotation. The receiver never guesses a port and
is restricted to the `fiducia` namespace.

### Central gateway

Mount `collector.yaml` from `fiducia-otel-gateway-cron` into an
`otel/opentelemetry-collector-contrib` gateway and set:

- `TEMPO_OTLP_HTTP_ENDPOINT`, for example `http://tempo:4318`;
- `LOKI_OTLP_HTTP_ENDPOINT`, ending in the Loki native OTLP prefix, commonly
  `http://loki:3100/otlp`;
- `PROMETHEUS_REMOTE_WRITE_ENDPOINT`, for example the Prometheus/Mimir remote
  write endpoint.

The gateway keeps all traces carrying `cron.schedule`, all errors, all traces
slower than two seconds, and a 10% baseline sample. The `spanmetrics/cron`
connector exports RED metrics and exemplars. Do not add tenant ids, schedule
names, function ids, URLs, run ids, trace ids, or error text as metric labels;
those are unbounded dimensions and belong in traces/logs/run records.

### Grafana

Provision the fixed datasource UIDs `prometheus`, `loki`, and `tempo` using
`grafana-cron-datasources.yaml`, then import
`fiducia-cron-dashboard.json`. The provisioning enables:

- Prometheus exemplar to Tempo trace links;
- Loki `trace_id` derived-field links to Tempo;
- Tempo trace-to-logs queries filtered by trace/span id;
- Tempo trace-to-metrics queries against Prometheus.

The dashboard intentionally aggregates metrics across tenants. Tenant-specific
investigation starts in the authenticated customer or operator run trail and
uses the exact trace id; it does not put tenant identity into Prometheus labels.

## Metric contract

The scheduler emits OpenTelemetry instruments with bounded attributes:

| Instrument | Prometheus translation | Dimensions |
| --- | --- | --- |
| `fiducia.cron.claims` | `fiducia_cron_claims_total` | `trigger` |
| `fiducia.cron.deliveries` | `fiducia_cron_deliveries_total` | `result`, `target_kind`, `trigger`, `status_class` |
| `fiducia.cron.delivery.attempts` | `fiducia_cron_delivery_attempts_total` | `target_kind`, `trigger` |
| `fiducia.cron.delivery.retries` | `fiducia_cron_delivery_retries_total` | `target_kind`, `trigger`, `status_class` |
| `fiducia.cron.delivery.deferred` | `fiducia_cron_delivery_deferred_total` | `reason`, `target_kind`, `trigger` |
| `fiducia.cron.delivery.duration` (`ms`) | `fiducia_cron_delivery_duration_milliseconds` | `result`, `target_kind`, `trigger` |
| `fiducia.cron.delivery.in_flight` | `fiducia_cron_delivery_in_flight` | `target_kind`, `trigger` |

The lambda service exposes stable Prometheus text counters including:

- `fiducia_lambda_function_definition_checks_total`;
- `fiducia_lambda_function_definition_check_failures_total`;
- `fiducia_lambda_function_invocation_failures_total`;
- `fiducia_lambda_tenant_auth_rejections_total`.

Prometheus translation may normalize dots and attribute keys to underscores; the
recording rules and dashboard use the normalized names above.

## Telemetry privacy contract

The following values are forbidden in logs, span attributes, metric labels, and
collector resource attributes:

- function source/body and generated entry commands;
- invocation request/response bodies;
- environment variables and secret references;
- webhook URLs, gRPC endpoints, database URLs, service-auth headers, cookies,
  bearer tokens, API keys, and Supabase tokens;
- raw customer error output.

The application emits opaque ids and normalized classes instead. Both the
per-cluster agent and central gateway delete known forbidden attribute keys.
This is defense in depth, not permission for services to emit them.

## Runbook

### Delivery failures

1. Open the customer or admin run trail and copy the trace id.
2. Open that trace in Tempo. Confirm the Raft claim, delivery attempt spans, and
   terminal result-commit span are present.
3. Follow the trace-to-logs link into Loki. Use only normalized error class,
   status class, target kind, attempt number, and fire id.
4. For `4xx`, fix the customer target or code; permanent errors must not retry.
5. For `429`/`5xx`/timeouts, inspect retry cadence and downstream health.

### Claim/delivery gap

A growing `fiducia:cron_claim_delivery_gap:increase15m` means committed claims
are not converging to terminal run records. Check:

- runner process crashes or leader churn;
- result proposals rejected by quorum loss;
- semaphore saturation and long downstream timeouts;
- lambda-service connectivity/auth configuration.

Do not manually rewrite history. Re-delivery must use the existing stable
idempotency key and Raft claim semantics.

### Concurrency deferrals

Persistent `reason="concurrency_limit"` deferrals indicate backpressure is
working. First reduce downstream latency or add runner capacity. Increase
`FIDUCIA_CRON_MAX_IN_FLIGHT` only after confirming CPU, memory, outbound socket,
and downstream limits; the setting is a safety bound, not a throughput target.

### Retry storms

Break down by `status_class`, `target_kind`, and `trigger`. Verify that only
transient classes (`timeout`, network failure, `429`, and selected `5xx`) retry.
Customer `4xx`, sandbox policy rejection, invalid configuration, and tenant-auth
failure must terminate immediately.

### Function check failures

Use normalized sandbox rejection categories. Do not inspect source through
Grafana or Loki. Operators needing source access require a separate audited,
least-privilege permission and should use the function control plane—not the
observability stack.

### Function invocation failures

Use the cron trace to correlate the node delivery span with the lambda invocation
span. Check timeout, output-size, child exit, and policy categories. The run
record should remain sanitized and bounded even when the child emits arbitrary
stderr.

### Tenant-auth rejections

Treat any sustained `fiducia_lambda_tenant_auth_rejections_total` increase as a
security or deployment regression. Confirm the scheduler sends both the internal
service credential and the canonical `x-fiducia-org-id`, that redirects remain
disabled, and that no browser credential is forwarded. Do not weaken the
lambda-service guard or fall back to an unscoped invocation.
