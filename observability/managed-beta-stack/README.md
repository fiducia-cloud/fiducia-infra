# Managed-public-beta SLO overlay

This opt-in Kustomize overlay extends `../cron-stack` with the first DEN-1404
managed-service recording rules, alerts, and Grafana dashboard. It consumes the
bounded external-probe series introduced by `fiducia-e2e` PR #21.

```bash
kubectl kustomize observability/managed-beta-stack >/tmp/fiducia-managed-beta.yaml
```

Applying this overlay deploys the existing OTel/Prometheus/Loki/Tempo/Grafana
stack plus:

- `managed-beta-rules.yml` in the Prometheus config;
- 28-day availability, sample-count, error-budget, burn-rate, and probe-freshness
  recording rules;
- fast/slow burn, no-data, fewer-than-two-location, stale-source, no-recent-success,
  counter-reset, and duplicate-series alerts;
- a provisioned Grafana dashboard with availability, remaining error budget,
  sample count, trusted location count, per-location freshness, last-success age,
  result rate, burn rate, and current series inventory.

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

The package groups only by reviewed `probe_location`, `cell`, `operation_class`,
and `result` labels. `probe_location` is injected by trusted Prometheus scrape
configuration with `honor_labels: false`; the probe does not self-assert it. Organization, tenant, project, environment, resource key/path,
credential, endpoint, request ID, trace ID, response content, and raw error text
must never enter Prometheus labels, dashboard variables, alert annotations, or
evidence exports.

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
