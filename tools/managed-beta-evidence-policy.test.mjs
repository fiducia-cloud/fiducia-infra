import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  deriveEvidencePolicy,
  renderEvidencePolicy,
} from "./render-managed-beta-evidence-policy.mjs";

const fleetPath = "external-probes/managed-beta/fleet.example.json";
const expectedOperations = [
  "committed_write",
  "health",
  "linearizable_read",
  "renewal",
  "secret_read",
  "watch_reconcile",
];
const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("DEN-1619 evidence-policy renderer", () => {
  it("derives the conservative cadence and per-source threshold from the reviewed fleet", async () => {
    const source = await readFile(fleetPath);
    const fleet = JSON.parse(source.toString("utf8"));
    const policy = deriveEvidencePolicy(fleet, source);

    assert.equal(policy.schema_version, 1);
    assert.equal(
      policy.probe_image,
      "ghcr.io/fiducia-cloud/fiducia-managed-beta-probe@sha256:cc251cb82f131616e73c070929f4dd9066228d1a90e86c627933f787e63e0941",
    );
    assert.deepEqual(policy.cells, ["managed-beta"]);
    assert.deepEqual(policy.operation_classes, expectedOperations);
    assert.deepEqual(
      policy.locations.map((location) => location.probe_location),
      ["probe-a", "probe-b"],
    );
    assert.deepEqual(
      policy.locations.map((location) => ({
        location: location.probe_location,
        interval: location.interval_seconds,
        delay: location.randomized_delay_seconds,
        maximum: location.maximum_schedule_interval_seconds,
      })),
      [
        { location: "probe-a", interval: 60, delay: 10, maximum: 70 },
        { location: "probe-b", interval: 60, delay: 25, maximum: 85 },
      ],
    );
    assert.equal(policy.policy.expected_interval_seconds, 85);
    assert.equal(policy.policy.minimum_coverage_ratio, 0.95);
    assert.equal(policy.policy.expected_observations_per_source_28d, 28_461);
    assert.equal(policy.policy.minimum_samples_per_source_28d, 27_037);
    assert.equal(policy.policy.maximum_source_freshness_seconds, 340);
    assert.equal(policy.policy.maximum_last_success_age_seconds, 1020);

    assert.deepEqual(policy.exporter_env, {
      FIDUCIA_RELEASE_CELLS: "managed-beta",
      FIDUCIA_RELEASE_OPERATION_CLASSES: expectedOperations.join(","),
      FIDUCIA_PROBE_LOCATIONS: "probe-a,probe-b",
      FIDUCIA_PROBE_EXPECTED_INTERVAL_SECONDS: "85",
      FIDUCIA_PROBE_MINIMUM_COVERAGE_RATIO: "0.95",
      FIDUCIA_PROBE_MAX_FRESHNESS_SECONDS: "340",
      FIDUCIA_PROBE_MAX_LAST_SUCCESS_AGE_SECONDS: "1020",
    });
  });

  it("writes deterministic non-secret JSON and env artifacts with ordinary read permissions", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "fiducia-evidence-policy-"));
    temporaryDirectories.push(outputDir);
    const first = await renderEvidencePolicy({ fleetPath, outputDir });
    const firstJson = await readFile(
      join(outputDir, "availability-policy.json"),
      "utf8",
    );
    const firstEnv = await readFile(
      join(outputDir, "availability-policy.env"),
      "utf8",
    );
    const second = await renderEvidencePolicy({ fleetPath, outputDir });
    const secondJson = await readFile(
      join(outputDir, "availability-policy.json"),
      "utf8",
    );
    const secondEnv = await readFile(
      join(outputDir, "availability-policy.env"),
      "utf8",
    );

    assert.deepEqual(first, second);
    assert.equal(firstJson, secondJson);
    assert.equal(firstEnv, secondEnv);
    assert.equal(
      (await stat(join(outputDir, "availability-policy.json"))).mode & 0o777,
      0o644,
    );
    assert.equal(
      (await stat(join(outputDir, "availability-policy.env"))).mode & 0o777,
      0o644,
    );
    assert.match(
      firstEnv,
      /^FIDUCIA_PROBE_EXPECTED_INTERVAL_SECONDS=85$/mu,
    );
    assert.match(
      firstEnv,
      /^FIDUCIA_PROBE_MINIMUM_COVERAGE_RATIO=0\.95$/mu,
    );
    assert.match(
      firstEnv,
      /^FIDUCIA_PROBE_MAX_FRESHNESS_SECONDS=340$/mu,
    );
    assert.match(
      firstEnv,
      /^FIDUCIA_PROBE_MAX_LAST_SUCCESS_AGE_SECONDS=1020$/mu,
    );

    const parsedPolicy = JSON.parse(firstJson);
    const { limitations, ...machinePolicy } = parsedPolicy;
    assert.ok(Array.isArray(limitations) && limitations.length > 0);
    const combined = `${JSON.stringify(machinePolicy)}\n${firstEnv}`.toLowerCase();
    for (const forbidden of [
      "endpoint",
      "bearer",
      "credential",
      "password",
      "secret_file",
      "hostname",
      "public_ip",
      "state_directory",
      "failure_domain_fingerprint",
    ]) {
      assert.ok(!combined.includes(forbidden), `artifact leaked ${forbidden}`);
    }
  });

  it("uses the slowest possible schedule rather than an average randomized delay", () => {
    const policy = deriveEvidencePolicy({
      image:
        "ghcr.io/fiducia-cloud/fiducia-managed-beta-probe@sha256:" +
        "1".repeat(64),
      cell: "cell-a",
      operations: ["health"],
      locations: [
        {
          id: "probe-a",
          intervalSeconds: 30,
          randomizedDelaySeconds: 0,
        },
        {
          id: "probe-b",
          intervalSeconds: 45,
          randomizedDelaySeconds: 15,
        },
      ],
    });
    assert.equal(policy.policy.expected_interval_seconds, 60);
    assert.equal(policy.policy.minimum_samples_per_source_28d, 38_304);
  });

  it("rejects duplicate locations, mutable images, invalid cadence, and missing operations", () => {
    const base = {
      image:
        "ghcr.io/fiducia-cloud/fiducia-managed-beta-probe@sha256:" +
        "2".repeat(64),
      cell: "cell-a",
      operations: ["health"],
      locations: [
        { id: "probe-a", intervalSeconds: 60, randomizedDelaySeconds: 0 },
        { id: "probe-b", intervalSeconds: 60, randomizedDelaySeconds: 0 },
      ],
    };

    assert.throws(() =>
      deriveEvidencePolicy({
        ...base,
        locations: [
          { id: "probe-a", intervalSeconds: 60 },
          { id: "probe-a", intervalSeconds: 60 },
        ],
      }),
    );
    assert.throws(() =>
      deriveEvidencePolicy({ ...base, image: "ghcr.io/example/probe:latest" }),
    );
    assert.throws(() =>
      deriveEvidencePolicy({
        ...base,
        locations: [
          { id: "probe-a", intervalSeconds: 5 },
          { id: "probe-b", intervalSeconds: 60 },
        ],
      }),
    );
    assert.throws(() => deriveEvidencePolicy({ ...base, operations: [] }));
  });
});
