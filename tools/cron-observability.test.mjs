import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

const dashboardPath = 'observability/central/grafana/fiducia-cron-dashboard.json';
const gatewayPath = 'observability/central/cron-otel-gateway.yaml';
const datasourcePath = 'observability/central/grafana-cron-datasources.yaml';
const rulesPath = 'base/observability/cron-prometheus-rules.yaml';

function collectExpressions(dashboard, datasourceType) {
  return dashboard.panels.flatMap((panel) => {
    const panelDatasource = panel.datasource?.type;
    return (panel.targets ?? [])
      .filter((target) => (target.datasource?.type ?? panelDatasource) === datasourceType)
      .map((target) => target.expr ?? target.query)
      .filter((expression) => typeof expression === 'string');
  });
}

const collectPromExpressions = (dashboard) => collectExpressions(dashboard, 'prometheus');
const collectLokiExpressions = (dashboard) => collectExpressions(dashboard, 'loki');

test('cron dashboard is valid JSON with all three signal backends', async () => {
  const dashboard = JSON.parse(await read(dashboardPath));
  assert.equal(dashboard.uid, 'fiducia-cron-jobs');
  assert.ok(dashboard.panels.length >= 8);

  const datasourceUids = new Set(dashboard.panels.map((panel) => panel.datasource?.uid));
  assert.ok(datasourceUids.has('prometheus'));
  assert.ok(datasourceUids.has('loki'));
  assert.ok(datasourceUids.has('tempo'));

  const expressions = collectPromExpressions(dashboard).join('\n');
  assert.match(expressions, /fiducia_cron_deliveries_total/);
  assert.match(expressions, /fiducia_lambda_tenant_auth_rejections_total/);
});

test('Prometheus dashboard dimensions remain bounded', async () => {
  const dashboard = JSON.parse(await read(dashboardPath));
  const expressions = collectPromExpressions(dashboard).join('\n').toLowerCase();
  for (const forbidden of [
    'tenant_id',
    'organization_id',
    'org_id',
    'schedule_name',
    'function_id',
    'fire_id',
    'trace_id',
    'webhook_url',
  ]) {
    assert.equal(
      expressions.includes(forbidden),
      false,
      `high-cardinality dimension leaked into PromQL: ${forbidden}`,
    );
  }
});

test('Loki preserves exact run correlation without turning identifiers into metric labels', async () => {
  const dashboard = JSON.parse(await read(dashboardPath));
  const logQueries = collectLokiExpressions(dashboard).join('\n');
  const promQueries = collectPromExpressions(dashboard).join('\n');

  assert.match(logQueries, /cron_fire_id/);
  assert.match(logQueries, /trace_id/);
  assert.doesNotMatch(promQueries, /fire_id|trace_id/);
});

test('central collector keeps cron traces and fans out every signal', async () => {
  const config = await read(gatewayPath);
  assert.match(config, /tail_sampling:/);
  assert.match(config, /key: cron\.schedule/);
  assert.match(config, /spanmetrics\/cron:/);
  assert.match(config, /exemplars:\n\s+enabled: true/);
  assert.match(config, /otlphttp\/tempo:/);
  assert.match(config, /otlphttp\/loki:/);
  assert.match(config, /prometheusremotewrite\/metrics:/);
  assert.match(config, /receivers: \[otlp, spanmetrics\/cron\]/);
});

test('collector has a second redaction boundary for code, payloads and auth', async () => {
  const config = await read(gatewayPath);
  for (const key of [
    'function.body',
    'function.source',
    'function.env',
    'cron.payload',
    'http.request.body',
    'http.request.header.x-server-auth',
    'http.request.header.x-fiducia-internal-auth',
  ]) {
    assert.match(config, new RegExp(`key: ${key.replaceAll('.', '\\.')}`));
  }
});

test('Grafana provisioning links Prometheus and Loki to Tempo', async () => {
  const config = await read(datasourcePath);
  assert.match(config, /uid: prometheus/);
  assert.match(config, /uid: loki/);
  assert.match(config, /uid: tempo/);
  assert.match(config, /exemplarTraceIdDestinations:/);
  assert.match(config, /derivedFields:/);
  assert.match(config, /tracesToLogsV2:/);
  assert.match(config, /tracesToMetrics:/);
});

test('cron alert rules cover reliability and tenant-auth regressions', async () => {
  const rules = await read(rulesPath);
  for (const alert of [
    'FiduciaCronDeliveryFailureRateHigh',
    'FiduciaCronClaimDeliveryGap',
    'FiduciaCronDeliveryDeferred',
    'FiduciaCronRetryStorm',
    'FiduciaCronLambdaCheckFailuresHigh',
    'FiduciaCronLambdaInvocationFailures',
    'FiduciaCronTenantAuthRejections',
  ]) {
    assert.match(rules, new RegExp(`alert: ${alert}`));
  }
});
