#!/usr/bin/env node

// DEN-1619: derive the non-secret exact-candidate evidence policy from the
// reviewed external-probe fleet schedule. The exporter must not assume a faster
// cadence than the slowest possible systemd timer (interval + randomized delay),
// or an otherwise healthy deployment can fail historical coverage by design.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(THIS_FILE);
const BOUNDED = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OCI_DIGEST = /^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/;
const COVERAGE_RATIO = 0.95;
const WINDOW_SECONDS = 28 * 24 * 60 * 60;

function required(name, value) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function bounded(name, value) {
  const normalized = String(required(name, value)).trim().toLowerCase();
  if (!BOUNDED.test(normalized)) {
    throw new Error(`${name} must be a bounded opaque identifier`);
  }
  return normalized;
}

function strictInteger(name, value, minimum, maximum) {
  const normalized = String(required(name, value)).trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
  }
  return parsed;
}

function directValue(object, keys) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(object, key)) return object[key];
  }
  return undefined;
}

function findValue(object, keys, predicate, seen = new Set()) {
  if (!object || typeof object !== "object" || seen.has(object)) return undefined;
  seen.add(object);
  if (!Array.isArray(object)) {
    for (const key of keys) {
      if (Object.hasOwn(object, key) && predicate(object[key])) return object[key];
    }
  }
  for (const value of Array.isArray(object) ? object : Object.values(object)) {
    if (value && typeof value === "object") {
      const found = findValue(value, keys, predicate, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findArray(object, keys) {
  return findValue(object, keys, Array.isArray);
}

function collectNamedValues(object, keys, valueKeys) {
  const found = [];
  const seenObjects = new Set();
  function visit(value) {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (!Array.isArray(value)) {
      for (const key of keys) {
        const candidate = value[key];
        if (Array.isArray(candidate)) {
          for (const item of candidate) {
            if (typeof item === "string") found.push(item);
            else if (item && typeof item === "object") {
              const named = directValue(item, valueKeys);
              if (named !== undefined) found.push(named);
            }
          }
        }
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") visit(child);
    }
  }
  visit(object);
  return [...new Set(found.map((value) => bounded("operation class", value)))].sort();
}

function collectCells(fleet, locations) {
  const values = [];
  const top = directValue(fleet, ["cell", "cellId", "cell_id"]);
  if (top !== undefined) values.push(top);
  for (const location of locations) {
    const value = findValue(
      location,
      ["cell", "cellId", "cell_id"],
      (candidate) => typeof candidate === "string",
    );
    if (value !== undefined) values.push(value);
  }
  return [...new Set(values.map((value) => bounded("cell", value)))].sort();
}

function parseLocation(location, index) {
  if (!location || typeof location !== "object" || Array.isArray(location)) {
    throw new Error(`location ${index + 1} must be an object`);
  }
  const id = bounded(
    `location ${index + 1} id`,
    directValue(location, [
      "probeLocation",
      "probe_location",
      "locationId",
      "location_id",
      "id",
      "name",
    ]),
  );
  const interval = strictInteger(
    `${id} intervalSeconds`,
    findValue(
      location,
      ["intervalSeconds", "interval_seconds", "onUnitActiveSeconds"],
      (value) => Number.isInteger(value) || (typeof value === "string" && /^\d+$/u.test(value)),
    ),
    10,
    3_600,
  );
  const delayRaw = findValue(
    location,
    ["randomizedDelaySeconds", "randomized_delay_seconds", "randomizedDelaySec"],
    (value) => Number.isInteger(value) || (typeof value === "string" && /^\d+$/u.test(value)),
  );
  const delay = delayRaw === undefined
    ? 0
    : strictInteger(`${id} randomizedDelaySeconds`, delayRaw, 0, 3_600);
  const maximumScheduleInterval = interval + delay;
  if (maximumScheduleInterval > 3_600) {
    throw new Error(`${id} maximum schedule interval exceeds one hour`);
  }
  return {
    probe_location: id,
    interval_seconds: interval,
    randomized_delay_seconds: delay,
    maximum_schedule_interval_seconds: maximumScheduleInterval,
  };
}

function parseImage(fleet) {
  const image = findValue(
    fleet,
    ["image", "probeImage", "probe_image", "containerImage"],
    (value) => typeof value === "string" && value.includes("@sha256:"),
  );
  const normalized = String(required("probe image", image)).trim().toLowerCase();
  if (!OCI_DIGEST.test(normalized)) {
    throw new Error("probe image must be pinned by a full sha256 digest");
  }
  return normalized;
}

export function deriveEvidencePolicy(fleet, sourceBytes = Buffer.from(JSON.stringify(fleet))) {
  if (!fleet || typeof fleet !== "object" || Array.isArray(fleet)) {
    throw new Error("fleet must be a JSON object");
  }
  const rawLocations = findArray(fleet, ["locations", "probes", "sites"]);
  if (!Array.isArray(rawLocations) || rawLocations.length < 2 || rawLocations.length > 16) {
    throw new Error("fleet must define 2..16 probe locations");
  }
  const locations = rawLocations.map(parseLocation).sort((left, right) =>
    left.probe_location.localeCompare(right.probe_location),
  );
  if (new Set(locations.map((location) => location.probe_location)).size !== locations.length) {
    throw new Error("fleet contains duplicate probe-location identities");
  }

  const cells = collectCells(fleet, rawLocations);
  if (cells.length === 0 || cells.length > 16) {
    throw new Error("fleet must declare 1..16 bounded cells");
  }
  const operationClasses = collectNamedValues(
    fleet,
    ["operations", "operationClasses", "operation_classes", "probes"],
    ["operationClass", "operation_class", "id", "name"],
  );
  if (operationClasses.length === 0 || operationClasses.length > 16) {
    throw new Error("fleet must declare 1..16 operation classes");
  }

  const expectedIntervalSeconds = Math.max(
    ...locations.map((location) => location.maximum_schedule_interval_seconds),
  );
  const maximumFreshnessSeconds = Math.max(300, expectedIntervalSeconds * 4);
  const maximumLastSuccessAgeSeconds = Math.max(900, expectedIntervalSeconds * 12);
  const expectedObservationsPerSource28d = Math.floor(
    WINDOW_SECONDS / expectedIntervalSeconds,
  );
  const minimumSamplesPerSource28d = Math.max(
    1,
    Math.floor(expectedObservationsPerSource28d * COVERAGE_RATIO),
  );

  const exporterEnv = {
    FIDUCIA_RELEASE_CELLS: cells.join(","),
    FIDUCIA_RELEASE_OPERATION_CLASSES: operationClasses.join(","),
    FIDUCIA_PROBE_LOCATIONS: locations
      .map((location) => location.probe_location)
      .join(","),
    FIDUCIA_PROBE_EXPECTED_INTERVAL_SECONDS: String(expectedIntervalSeconds),
    FIDUCIA_PROBE_MINIMUM_COVERAGE_RATIO: String(COVERAGE_RATIO),
    FIDUCIA_PROBE_MAX_FRESHNESS_SECONDS: String(maximumFreshnessSeconds),
    FIDUCIA_PROBE_MAX_LAST_SUCCESS_AGE_SECONDS: String(
      maximumLastSuccessAgeSeconds,
    ),
  };

  return {
    schema_version: 1,
    evidence_type: "fiducia_managed_beta_probe_schedule_policy",
    source_fleet_sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    probe_image: parseImage(fleet),
    cells,
    operation_classes: operationClasses,
    locations,
    policy: {
      coverage_window_days: 28,
      expected_interval_seconds: expectedIntervalSeconds,
      minimum_coverage_ratio: COVERAGE_RATIO,
      expected_observations_per_source_28d: expectedObservationsPerSource28d,
      minimum_samples_per_source_28d: minimumSamplesPerSource28d,
      maximum_source_freshness_seconds: maximumFreshnessSeconds,
      maximum_last_success_age_seconds: maximumLastSuccessAgeSeconds,
      cadence_basis:
        "maximum across every location of interval_seconds + randomized_delay_seconds",
    },
    exporter_env: exporterEnv,
    limitations: [
      "This policy aligns declared scheduler cadence with evidence thresholds; it does not prove any host is deployed or physically independent.",
      "The output intentionally excludes endpoints, credentials, hostnames, IP addresses, state paths, and free-form site descriptions.",
      "Exact source/config/rules commits, image digests, completed window timestamps, and independent review remain separate exporter inputs.",
    ],
  };
}

function renderEnv(policy) {
  return `${Object.entries(policy.exporter_env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

async function atomicWrite(path, content) {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, target);
}

export async function renderEvidencePolicy({ fleetPath, outputDir }) {
  const source = await readFile(fleetPath);
  const fleet = JSON.parse(source.toString("utf8"));
  const policy = deriveEvidencePolicy(fleet, source);
  await mkdir(outputDir, { recursive: true });
  await atomicWrite(
    resolve(outputDir, "availability-policy.json"),
    `${JSON.stringify(
      {
        ...policy,
        source_fleet_file: basename(fleetPath),
      },
      null,
      2,
    )}\n`,
  );
  await atomicWrite(
    resolve(outputDir, "availability-policy.env"),
    renderEnv(policy),
  );
  return policy;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("usage: --fleet <path> --output-dir <path>");
    }
    values.set(name, value);
  }
  return {
    fleetPath: resolve(required("--fleet", values.get("--fleet"))),
    outputDir: resolve(required("--output-dir", values.get("--output-dir"))),
  };
}

async function main() {
  const policy = await renderEvidencePolicy(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `rendered evidence policy for ${policy.locations.length} locations; expected_interval_seconds=${policy.policy.expected_interval_seconds}\n`,
  );
}

if (IS_CLI) {
  main().catch((error) => {
    process.stderr.write(`managed-beta evidence-policy render failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
