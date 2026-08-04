import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("observability/managed-beta-stack");

async function text(name) {
  return readFile(resolve(root, name), "utf8");
}

function names(source, kind) {
  return new Set(
    [...source.matchAll(new RegExp(`^\\s*-\\s+${kind}:\\s+(\\S+)`, "gm"))].map(
      (match) => match[1],
    ),
  );
}

const forbiddenIdentityTerms = [
  "org_id",
  "organization_id",
  "tenant_id",
  "project_id",
  "environment_id",
  "lock_key",
  "secret_value",
  "api_key",
  "request_id",
  "trace_id",
  "authorization",
  "cookie",
];

describe("DEN-1404/DEN-1619 managed beta SLO package", () => {
  it("declares availability records plus location continuity and safety alerts", async () => {
    const rules = await text("managed-beta-rules.yml");
    const records = names(rules, "record");
    const alerts = names(rules, "alert");

    for (const record of [
      "fiducia:sli:public_availability_ratio:28d",
      "fiducia:sli:public_availability_samples:28d",
      "fiducia:sli:public_unavailability_ratio:1h",
      "fiducia:sli:public_unavailability_ratio:6h",
      "fiducia:sli:public_availability_burn_rate:1h",
      "fiducia:sli:public_availability_burn_rate:6h",
      "fiducia:sli:public_availability_error_budget_remaining_ratio:28d",
      "fiducia:sli:external_probe_freshness_seconds",
      "fiducia:sli:external_probe_last_success_age_seconds",
      "fiducia:sli:external_probe_fresh_location_count",
    ]) {
      assert.ok(records.has(record), `missing recording rule ${record}`);
    }

    for (const alert of [
      "FiduciaPublicAvailabilityFastBurn",
      "FiduciaPublicAvailabilitySlowBurn",
      "FiduciaExternalProbeInsufficientLocations",
      "FiduciaExternalProbeSourceStale",
      "FiduciaExternalProbeNeverObserved",
      "FiduciaExternalProbeNoRecentSuccess",
      "FiduciaExternalProbeCounterReset",
      "FiduciaExternalProbeDuplicateSeries",
    ]) {
      assert.ok(alerts.has(alert), `missing alert ${alert}`);
    }

    assert.match(rules, /increase\(fiducia_external_probe_total\{result="success"\}\[28d\]\)/u);
    assert.match(rules, /fiducia:sli:public_unavailability_ratio:1h \/ 0\.005/u);
    assert.match(rules, /fiducia:sli:public_availability_burn_rate:1h > 14\.4/u);
    assert.match(rules, /fiducia:sli:public_availability_burn_rate:6h > 6/u);
    assert.match(rules, /max by \(cell, operation_class, probe_location\)/u);
    assert.match(rules, /fiducia:sli:external_probe_fresh_location_count < 2/u);
    assert.match(rules, /absent\(fiducia_external_probe_last_run_unixtime\)/u);
    assert.match(rules, /resets\(fiducia_external_probe_total\[1h\]\)/u);
    assert.match(rules, /sum by \(cell, operation_class, probe_location, result\)/u);
    assert.match(rules, /count by \(cell, operation_class, probe_location, result\)/u);
  });

  it("keeps rules and dashboard inside the bounded source-identity boundary", async () => {
    const rules = await text("managed-beta-rules.yml");
    const dashboardText = await text("managed-beta-overview.json");
    const combined = `${rules}\n${dashboardText}`.toLowerCase();

    for (const forbidden of forbiddenIdentityTerms) {
      assert.ok(!combined.includes(forbidden), `forbidden identity term ${forbidden}`);
    }

    const customerGrouping = /\b(?:by|without)\s*\([^)]*(?:org|tenant|project|environment|key|path|credential|request|trace)/iu;
    assert.ok(!customerGrouping.test(rules), "rules group by a customer-controlled dimension");

    for (const match of combined.matchAll(/\bfiducia(?::|_)[a-z0-9_:]+/gu)) {
      const metric = match[0];
      assert.ok(
        metric.startsWith("fiducia_external_probe_") || metric.startsWith("fiducia:sli:"),
        `unexpected metric family ${metric}`,
      );
    }

    assert.match(rules, /probe_location/u);
    assert.doesNotMatch(rules, /hostname|public_ip|site_address|cloud_account/u);
  });

  it("ships a location-aware dashboard with honest no-data, sample, freshness, and burn views", async () => {
    const dashboard = JSON.parse(await text("managed-beta-overview.json"));
    assert.equal(dashboard.uid, "fiducia-managed-beta-slo");
    assert.equal(dashboard.title, "Fiducia managed beta SLO overview");
    assert.equal(dashboard.version, 2);
    assert.ok(Array.isArray(dashboard.panels));
    assert.ok(dashboard.panels.length >= 9);

    const serialized = JSON.stringify(dashboard);
    for (const required of [
      "public_availability_ratio:28d",
      "public_availability_error_budget_remaining_ratio:28d",
      "public_availability_samples:28d",
      "external_probe_freshness_seconds",
      "external_probe_last_success_age_seconds",
      "external_probe_fresh_location_count",
      "public_availability_burn_rate:1h",
      "public_availability_burn_rate:6h",
      "fiducia_external_probe_total",
      "probe_location",
      "NO DATA",
    ]) {
      assert.ok(serialized.includes(required), `dashboard missing ${required}`);
    }

    const variables = new Set(dashboard.templating.list.map((variable) => variable.name));
    assert.deepEqual(
      variables,
      new Set(["cell", "operation_class", "probe_location"]),
    );
    assert.ok(
      dashboard.panels.some((panel) => panel.title === "Fresh probe locations"),
    );
  });

  it("renders as an overlay of the existing stack and mounts rules and dashboard", async () => {
    const [kustomization, prometheusPatch, grafanaPatch] = await Promise.all([
      text("kustomization.yaml"),
      text("prometheus-config.patch.yaml"),
      text("grafana-deployment.patch.yaml"),
    ]);

    assert.match(kustomization, /- \.\.\/cron-stack/u);
    assert.match(kustomization, /name: fiducia-prometheus-config[\s\S]+behavior: merge/u);
    assert.match(kustomization, /managed-beta-rules\.yml/u);
    assert.match(kustomization, /managed-beta-overview\.json/u);
    assert.match(prometheusPatch, /\/etc\/prometheus\/cron-rules\.yml/u);
    assert.match(prometheusPatch, /\/etc\/prometheus\/managed-beta-rules\.yml/u);
    assert.match(grafanaPatch, /fiducia-grafana-managed-beta-dashboard/u);
    assert.match(grafanaPatch, /\/var\/lib\/grafana\/dashboards\/managed-beta-overview\.json/u);
  });

  it("documents maturity, two-location identity, and physical-independence limits", async () => {
    const readme = await text("README.md");
    for (const required of [
      "specified",
      "instrumented",
      "queryable",
      "measured",
      "two failure-independent",
      "probe_location",
      "Missing or stale sources",
      "do not prove physical independence",
    ]) {
      assert.ok(readme.includes(required), `README missing ${required}`);
    }
  });
});
