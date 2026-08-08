# Managed-public-beta SLO overlay

This opt-in Kustomize overlay extends `../cron-stack` with the DEN-1404/DEN-1619 managed-service recording rules, alerts, and Grafana dashboard. It consumes bounded cumulative external-probe series and injects trusted source-location identity at the central Prometheus boundary.

```bash
kubectl kustomize observability/managed-beta-stack >/tmp/fiducia-managed-beta.yaml
```

Applying this overlay deploys the existing OTel/Prometheus/Loki/Tempo/Grafana stack plus:

- `managed-beta-rules.yml` in Prometheus;
- cell-scoped 28-day availability, sample-count, error-budget, and burn-rate records;
- per-location/cell/operation 28-day sample-count, freshness, and last-success records;
- historical and fresh trusted-location counts per cell and operation class;
- fast/slow burn, no-data, lost-independence, stale-location, no-recent-success, counter-reset, and duplicate-series alerts;
- a Grafana dashboard with availability, remaining error budget, samples, fresh location count, per-location freshness/last success, result rates, burn rates, and current source inventory.

## Trusted probe-location identity

Use `external-probe-scrape.example.yml` as the reviewed central scrape shape. It uses mTLS, injects one bounded `probe_location` label per target, and requires `honor_labels: false` so an untrusted probe cannot override monitoring-topology identity.

`probe_location` is an opaque deployment ID such as `probe-a`. It is not a hostname, IP address, cloud account, home/site description, endpoint, credential, scheduler path, or customer value. The restricted evidence inventory documents the actual location and failure domain separately.

Two different trusted location labels prove two monitoring lineages; they do not prove physical independence. DEN-1619 separately requires the sources not to share a laptop/cluster, ingress process, scheduler/state volume, credential/runtime identity, outbound network/provider failure domain, or practical DNS failure path.

## Observation coverage, freshness, and independence

`fiducia:sli:public_availability_samples:28d` remains the cell-level total used for aggregate service context.

`fiducia:sli:external_probe_samples:28d` records 28-day observations separately for every trusted `probe_location`, `cell`, and `operation_class`. The exact-candidate exporter uses this per-source record for density checks, so a high-volume source cannot hide sparse history for another location or operation.

`fiducia:sli:external_probe_location_count` records historically observable locations per `cell` and `operation_class`.

`fiducia:sli:external_probe_fresh_location_count` counts only location lineages whose last completed run is no older than five minutes. `FiduciaExternalProbeIndependenceLost` fires when a cell and operation class have fewer than two fresh sources.

This distinction is deliberate: a stale location must not continue satisfying the independence gate merely because its cumulative counter still exists. Likewise, a healthy `health` source cannot satisfy the gate for a missing `committed_write` or `secret_read` source, and extra observations from one source cannot satisfy the historical coverage requirement for another.

Missing, stale, or historically under-covered sources are incomplete evidence, never 100% availability. Counter resets are evidence-integrity events because the one-shot probe's local state is its cumulative authority. Duplicate time series claiming the same trusted location/cell/operation/result identity are an authority error.

## Evidence maturity

A rendered or deployed rules package does not make the service SLO measured. Progression remains:

1. `specified` — source/query/alert/dashboard contracts exist;
2. `instrumented` — at least two named failure-independent producers emit cumulative series;
3. `queryable` — central Prometheus injects trusted location identity and evaluates these rules, alerts, dashboard, per-source coverage, freshness, reset, duplicate, and no-data behavior;
4. `measured` — a completed exact-candidate window is exported with exact revisions/digests, the full declared/observed location matrix, sufficient observations for every source, and independent review.

The external availability objective requires at least two failure-independent locations. Probes in the same cluster, laptop, DNS path, scheduler, state authority, or ingress process do not meet that requirement.

## Low-cardinality boundary

The package uses only reviewed `probe_location`, `cell`, `operation_class`, and `result` labels. Organization, tenant, project, environment, resource key/path, credential, endpoint, request ID, trace ID, response content, raw error, hostname, IP address, and free-form site identity must never enter metrics, dashboard variables, alert annotations, or evidence exports.

## Deployment dependency

Central Prometheus must securely scrape or receive cumulative series from each external location. This overlay installs queries and views; it does not create external machines, credentials, schedules, state volumes, network paths, or physical independence. Those deployment and live-evidence tasks remain in DEN-1619.
