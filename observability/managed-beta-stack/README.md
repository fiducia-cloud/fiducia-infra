# Managed-public-beta SLO overlay

This opt-in Kustomize overlay extends `../cron-stack` with the DEN-1404/DEN-1619 managed-service recording rules, alerts, and Grafana dashboard. It consumes the bounded cumulative external-probe series produced by `fiducia-e2e`.

```bash
kubectl kustomize observability/managed-beta-stack >/tmp/fiducia-managed-beta.yaml
```

Applying this overlay deploys the existing OTel/Prometheus/Loki/Tempo/Grafana stack plus:

- `managed-beta-rules.yml` in Prometheus;
- cell-scoped 28-day availability, sample-count, error-budget, and burn-rate records;
- per-cell/operation/location freshness and last-success records;
- fresh-location counts for the two-source independence gate;
- fast/slow burn, no-data, insufficient-location, stale-location, no-recent-success, counter-reset, and duplicate-series alerts;
- a Grafana dashboard with availability, budget, samples, per-location freshness/last success, location result rates, burn rates, current source inventory, and fresh-source count.

## Source identity

Every cumulative source series includes only bounded labels:

```text
cell
operation_class
probe_location
result
```

`probe_location` is an opaque reviewed deployment identity, not a hostname, address, cloud account, home/site description, endpoint, credential, scheduler path, or customer value.

The source producer binds one schema-v2 state file to one exact `cell` / `operation_class` / `probe_location` identity. Rules preserve `probe_location` for source continuity, reset, freshness, and duplicate detection. Contractual availability remains cell-scoped and aggregates the observed samples from every source.

Two different `probe_location` labels prove two metric lineages; they do not prove physical independence. DEN-1619 separately requires the locations not to share a laptop/cluster, ingress process, scheduler/state volume, credential/runtime identity, outbound network/provider failure domain, or practical DNS failure path.

## Evidence maturity

A rendered or deployed rules package does not make the SLO measured. Progression remains:

1. `specified` — source/query/alert/dashboard contracts exist;
2. `instrumented` — at least two named failure-independent producers emit location-scoped cumulative series;
3. `queryable` — central Prometheus receives both locations and evaluates these rules, alerts, dashboard, freshness, duplicate/reset, and no-data behavior;
4. `measured` — a completed exact-candidate window is exported with exact revisions/digests, the full declared/observed location matrix, and independent review.

The external availability objective requires at least two failure-independent locations. Probes in the same cluster, laptop, DNS path, scheduler, state authority, or ingress process do not meet that requirement.

## Low-cardinality boundary

Organization, tenant, project, environment, resource key/path, credential, endpoint, request ID, trace ID, response content, raw error, hostname, IP address, and free-form site identity must never enter Prometheus labels, dashboard variables, alert annotations, or evidence exports.

## No-data and independence behavior

Missing or stale sources are explicit alerts and dashboard `NO DATA`, never 100% availability. `FiduciaExternalProbeInsufficientLocations` fires when a cell/operation has fewer than two fresh location-scoped lineages. Counter resets are evidence-integrity events because the one-shot producer's local state is the cumulative authority. Duplicate series claiming the same complete source identity are rejected operationally before the SLI is trusted.

## Deployment dependency

Central Prometheus must scrape or receive the series from each external location through a reviewed path. This overlay installs queries and views; it does not create external machines, credentials, schedules, state volumes, network paths, or physical independence. Those deployment and live-evidence tasks remain in DEN-1619.
