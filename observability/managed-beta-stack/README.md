# Managed-public-beta SLO overlay

This opt-in Kustomize overlay extends `../cron-stack` with the DEN-1404/DEN-1619 managed-service recording rules, alerts, and Grafana dashboard. It consumes bounded cumulative external-probe series and injects trusted source-location identity at the central Prometheus boundary.
This opt-in Kustomize overlay extends `../cron-stack` with the first DEN-1404
managed-service recording rules, alerts, and Grafana dashboard. It consumes the
bounded external-probe series introduced by `fiducia-e2e` PR #21.

```bash
kubectl kustomize observability/managed-beta-stack >/tmp/fiducia-managed-beta.yaml
```

Applying this overlay deploys the existing OTel/Prometheus/Loki/Tempo/Grafana stack plus:

- `managed-beta-rules.yml` in Prometheus;
- cell-scoped 28-day availability, sample-count, error-budget, and burn-rate records;
- per-location/cell/operation freshness and last-success records;
- historical and fresh trusted-location counts per cell and operation class;
- fast/slow burn, no-data, lost-independence, stale-location, no-recent-success, counter-reset, and duplicate-series alerts;
- a Grafana dashboard with availability, remaining error budget, samples, fresh location count, per-location freshness/last success, result rates, burn rates, and current source inventory.
- `managed-beta-rules.yml` in the Prometheus config;
- 28-day availability, sample-count, error-budget, burn-rate, and probe-freshness
  recording rules;
- fast/slow burn, no-data, fewer-than-two-location, stale-source, no-recent-success,
  counter-reset, and duplicate-series alerts;
- a provisioned Grafana dashboard with availability, remaining error budget,
  sample count, trusted location count, per-location freshness, last-success age,
  result rate, burn rate, and current series inventory.

## Trusted probe-location identity

Use `external-probe-scrape.example.yml` as the reviewed central scrape shape. It uses mTLS, injects one bounded `probe_location` label per target, and requires `honor_labels: false` so an untrusted probe cannot override monitoring-topology identity.

`probe_location` is an opaque deployment ID such as `probe-a`. It is not a hostname, IP address, cloud account, home/site description, endpoint, credential, scheduler path, or customer value. The restricted evidence inventory documents the actual location and failure domain separately.

Two different trusted location labels prove two monitoring lineages; they do not prove physical independence. DEN-1619 separately requires the sources not to share a laptop/cluster, ingress process, scheduler/state volume, credential/runtime identity, outbound network/provider failure domain, or practical DNS failure path.

## Freshness and independence

`fiducia:sli:external_probe_location_count` records historically observable locations per `cell` and `operation_class`.

`fiducia:sli:external_probe_fresh_location_count` counts only location lineages whose last completed run is no older than five minutes. `FiduciaExternalProbeIndependenceLost` fires when a cell and operation class have fewer than two fresh sources.
The package groups only by reviewed `probe_location`, `cell`, `operation_class`,
and `result` labels. `probe_location` is injected by trusted Prometheus scrape
configuration with `honor_labels: false`; the probe does not self-assert it. Organization, tenant, project, environment, resource key/path,
Applying this overlay deploys the existing OTel/Prometheus/Loki/Tempo/Grafana
stack plus:

- `managed-beta-rules.yml` in the Prometheus config;
- 28-day availability, sample-count, error-budget, burn-rate, and probe-freshness
  recording rules;
- fast/slow burn, no-data, stale-source, no-recent-success, counter-reset, and
  duplicate-series alerts;
- a provisioned Grafana dashboard with availability, remaining error budget,
  sample count, freshness, last-success age, result rate, burn rate, and current
  series inventory.

## Evidence maturity

A rendered or deployed rules package does not make the service SLO `measured`.
The evidence progression remains:

1. `specified` — the source/query/alert/dashboard contract exists;
2. `instrumented` — named external producers emit cumulative series;
3. `queryable` — Prometheus scrapes the series and evaluates these rules and
   alerts, with source freshness and no-data visible;
4. `measured` — an exact release candidate has a bounded observation window,
   exported query results, image/config commits, probe locations, and independent
   review.

The external availability objective requires at least two failure-independent
probe locations. Probes in the same cluster, laptop, DNS path, or ingress process
as Fiducia are useful diagnostics but do not meet that requirement.

## Low-cardinality boundary

The package groups only by reviewed `cell`, `operation_class`, and `result`
labels. Organization, tenant, project, environment, resource key/path,
credential, endpoint, request ID, trace ID, response content, and raw error text
must never enter Prometheus labels, dashboard variables, alert annotations, or
evidence exports.

This distinction is deliberate: a stale location must not continue satisfying the independence gate merely because its cumulative counter still exists. Likewise, a healthy `health` source cannot satisfy the gate for a missing `committed_write` or `secret_read` source.

Missing or stale sources are explicit alerts and dashboard `NO DATA`, never 100% availability. Counter resets are evidence-integrity events because the one-shot probe's local state is its cumulative authority. Duplicate time series claiming the same trusted location/cell/operation/result identity are an authority error.

## Evidence maturity

A rendered or deployed rules package does not make the service SLO measured. Progression remains:

1. `specified` — source/query/alert/dashboard contracts exist;
2. `instrumented` — at least two named failure-independent producers emit cumulative series;
3. `queryable` — central Prometheus injects trusted location identity and evaluates these rules, alerts, dashboard, freshness, reset, duplicate, and no-data behavior;
4. `measured` — a completed exact-candidate window is exported with exact revisions/digests, the full declared/observed location matrix, and independent review.

The external availability objective requires at least two failure-independent locations. Probes in the same cluster, laptop, DNS path, scheduler, state authority, or ingress process do not meet that requirement.

## Low-cardinality boundary

The package uses only reviewed `probe_location`, `cell`, `operation_class`, and `result` labels. Organization, tenant, project, environment, resource key/path, credential, endpoint, request ID, trace ID, response content, raw error, hostname, IP address, and free-form site identity must never enter metrics, dashboard variables, alert annotations, or evidence exports.

## Deployment dependency

Central Prometheus must securely scrape or receive cumulative series from each external location. This overlay installs queries and views; it does not create external machines, credentials, schedules, state volumes, network paths, or physical independence. Those deployment and live-evidence tasks remain in DEN-1619.
## No-data behavior

Missing or stale sources are explicit alerts and dashboard `NO DATA`, never 100%
availability. Counter resets are evidence-integrity events because the one-shot
probe's local state is the cumulative counter authority.

## Deployment dependency

The central Prometheus must be able to scrape or receive the textfile-collector
series from each external probe location. This overlay installs queries and views;
it does not create those external machines, credentials, schedules, or network
paths. Those deployment and evidence tasks remain in DEN-1404.


## Trusted probe-location identity

Use `external-probe-scrape.example.yml` as the reviewed shape for central scrape
targets. Every independent target receives one bounded `probe_location` label at
the monitoring boundary. A cell with fewer than two currently observed locations
raises `FiduciaExternalProbeIndependenceLost` and is ineligible for availability
evidence even when the aggregate ratio appears healthy.
