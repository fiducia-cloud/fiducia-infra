import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const gatewayPath = "observability/cron-stack/otel-gateway.yaml";
const prometheusPath = "observability/cron-stack/prometheus.yaml";
const grafanaPath = "observability/cron-stack/grafana.yaml";
const docsPath = "docs/cron-observability.md";

function embeddedDashboard(yaml) {
  const match = yaml.match(/  cron-operations\.json: \|\n([\s\S]*?)\n---\n/);
  assert.ok(match, "Grafana dashboard ConfigMap payload is missing");
  const json = match[1]
    .split("\n")
    .map((line) => line.replace(/^    /, ""))
    .join("\n");
  return JSON.parse(json);
}

function promExpressions(dashboard) {
  return dashboard.panels
    .flatMap((panel) => panel.targets ?? [])
    .map((target) => target.expr)
    .filter((expr) => typeof expr === "string");
}

test("cron dashboard JSON matches emitted metric names and labels", async () => {
  const dashboard = embeddedDashboard(await read(grafanaPath));
  assert.equal(dashboard.uid, "fiducia-cron-operations");
  assert.ok(dashboard.panels.length >= 7);

  const expressions = promExpressions(dashboard).join("\n");
  assert.match(expressions, /fiducia_cron_deliveries_total/);
  assert.match(expressions, /by \(result\)/);
  assert.doesNotMatch(expressions, /\boutcome\b/);
  assert.match(expressions, /fiducia_cron_delivery_in_flight/);
  assert.match(expressions, /dd_lambda_runner_active_workers/);
  assert.match(expressions, /fiducia:cron_delivery_duration:p95_5m/);

  for (const forbidden of [
    "tenant_id",
    "organization_id",
    "org_id",
    "schedule_name",
    "function_id",
    "fire_id",
    "trace_id",
    "webhook_url",
  ]) {
    assert.equal(
      expressions.toLowerCase().includes(forbidden),
      false,
      `high-cardinality dimension leaked into PromQL: ${forbidden}`,
    );
  }
});

test("recording rules use the scheduler result label and cover latency", async () => {
  const config = await read(prometheusPath);
  assert.match(config, /fiducia_cron_deliveries_total\{result="failed"\}/);
  assert.match(config, /fiducia_cron_deliveries_total\{result="delivered"\}/);
  assert.doesNotMatch(config, /outcome!?=/);
  assert.match(config, /fiducia:cron_delivery_duration:p95_5m/);
  assert.match(config, /FiduciaCronDeliveryLatencyHigh/);
  assert.match(config, /otelcol_exporter_send_failed_metric_points_total/);
});

test("collector retains every cron trace and generates correlated metrics", async () => {
  const config = await read(gatewayPath);
  assert.match(config, /name: cron-traces/);
  assert.match(config, /key: cron\.schedule/);
  assert.match(config, /spanmetrics\/cron:/);
  assert.match(config, /servicegraph:/);
  assert.match(config, /exemplars:\n\s+enabled: true/);
  assert.match(config, /receivers: \[otlp, spanmetrics\/cron, servicegraph\]/);
  assert.match(config, /exporters: \[otlp\/tempo, spanmetrics\/cron, servicegraph\]/);
});

test("tail sampling uses one trace-consistent worker until load balancing exists", async () => {
  const config = await read(gatewayPath);
  assert.match(config, /replicas: 1/);
  assert.doesNotMatch(config, /replicas: 2/);
});

test("documentation requires a stdout log collector and trace-aware HA", async () => {
  const docs = await read(docsPath);
  assert.match(docs, /does \*\*not\*\* tail pod logs by itself/);
  assert.match(docs, /authorized log agent/);
  assert.match(docs, /trace-ID-aware topology/);
  assert.match(docs, /Do not scale that Deployment directly/);
});

test("collector has a second fail-closed sensitive-data boundary", async () => {
  const config = await read(gatewayPath);
  for (const key of [
    "function.body",
    "function.source",
    "function.env",
    "cron.payload",
    "http.request.body",
    "http.response.body",
    "db.statement",
    "http.request.header.x-server-auth",
    "http.request.header.x-fiducia-internal-auth",
  ]) {
    assert.match(config, new RegExp(`key: ${key.replaceAll(".", "\\.")}`));
  }
});

test("Grafana provisions Prometheus, Loki, Tempo and all correlation pivots", async () => {
  const config = await read(grafanaPath);
  assert.match(config, /uid: prometheus/);
  assert.match(config, /uid: loki/);
  assert.match(config, /uid: tempo/);
  assert.match(config, /exemplarTraceIdDestinations:/);
  assert.match(config, /derivedFields:/);
  assert.match(config, /tracesToLogsV2:/);
  assert.match(config, /tracesToMetrics:/);
  assert.match(config, /serviceMap:/);
});
