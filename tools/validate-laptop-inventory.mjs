#!/usr/bin/env node
// Validate the physical three-laptop inventory and emit a deterministic,
// non-secret acceptance report. This is an engineering gate, not hardware
// discovery: evidence must be collected independently and reviewed by a human.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadTopology } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const defaultInventoryPath = path.join(root, "laptop", "inventory", "fleet.example.json");
const topologyPath = path.join(root, "laptop", "topology.toml");
const MAX_CAPTURE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REVIEW_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const K3S_VERSION_RE = /^v\d+\.\d+\.\d+\+k3s\d+$/;
const EVIDENCE_RE = /^[a-z0-9][a-z0-9._:/-]{7,255}$/;
const CLUSTERS = {
  "laptop-aws-sim": "aws",
  "laptop-gcp-sim": "gcp",
  "laptop-azure-sim": "azure",
};
const FORBIDDEN_KEYS = /(?:^|_)(?:password|passwd|secret|token|credential|privatekey|private_key|authkey|auth_key|accesskey|access_key|rawserial|raw_serial|publicip|public_ip)(?:$|_)/i;
const CREDENTIAL_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /tskey-(?:auth|client)-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional, label) {
  assert(isObject(value), `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) assert(Object.hasOwn(value, key), `${label}.${key} is required`);
  for (const key of Object.keys(value)) assert(allowed.has(key), `${label}.${key} is not allowed`);
}

function nonEmptyString(value, label, minimum = 1, maximum = 2000) {
  assert(typeof value === "string", `${label} must be a string`);
  assert(value.trim().length >= minimum, `${label} must contain at least ${minimum} characters`);
  assert(value.length <= maximum, `${label} must contain at most ${maximum} characters`);
  return value;
}

function boolean(value, expected, label) {
  assert(typeof value === "boolean", `${label} must be boolean`);
  if (expected !== undefined) assert(value === expected, `${label} must be ${expected}`);
}

function boundedNumber(value, minimum, maximum, label, integer = false) {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number`);
  if (integer) assert(Number.isInteger(value), `${label} must be an integer`);
  assert(value >= minimum && value <= maximum, `${label} must be in ${minimum}..${maximum}`);
}

function timestamp(value, label) {
  const parsed = new Date(value);
  assert(typeof value === "string" && !Number.isNaN(parsed.getTime()), `${label} must be an ISO timestamp`);
  return parsed;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function scanSecrets(value, location = "inventory") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assert(!FORBIDDEN_KEYS.test(key), `${location}.${key} is a forbidden secret-bearing or privacy-sensitive key`);
      scanSecrets(child, `${location}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    for (const pattern of CREDENTIAL_PATTERNS) {
      assert(!pattern.test(value), `${location} contains a credential-like value`);
    }
  }
}

function ipv4Number(address, label) {
  assert(net.isIP(address) === 4, `${label} must contain an IPv4 address`);
  return address.split(".").map(Number).reduce((acc, octet) => ((acc << 8) | octet) >>> 0, 0);
}

function cidrRange(value, label) {
  assert(typeof value === "string", `${label} must be a CIDR string`);
  const parts = value.split("/");
  assert(parts.length === 2, `${label} must have address/prefix form`);
  const prefix = Number(parts[1]);
  assert(Number.isInteger(prefix) && prefix >= 0 && prefix <= 32, `${label} prefix must be 0..32`);
  const numeric = ipv4Number(parts[0], label);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (numeric & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  return { value, start, end: start + size - 1 };
}

function rangesOverlap(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

function validateEvidence(evidence, label, evidenceMode) {
  const keys = [
    "hardware",
    "smart",
    "encryption",
    "secureBoot",
    "firewall",
    "ssh",
    "power",
    "network",
    "thermal",
    "monitoring",
    "rebuildPlan",
    "revocationPlan",
  ];
  exactKeys(evidence, keys, [], label);
  const values = [];
  for (const key of keys) {
    const value = evidence[key];
    assert(typeof value === "string" && EVIDENCE_RE.test(value), `${label}.${key} has an invalid evidence identifier`);
    if (evidenceMode === "live") assert(!value.startsWith("example:"), `${label}.${key} cannot use example evidence in live mode`);
    values.push(value);
  }
  assert(new Set(values).size === values.length, `${label} evidence identifiers must be distinct`);
}

function validateHost(host, index, evidenceMode) {
  const label = `hosts[${index}]`;
  exactKeys(
    host,
    [
      "clusterName",
      "syntheticProvider",
      "siteId",
      "serialHash",
      "hardware",
      "firmware",
      "network",
      "power",
      "hostPolicy",
      "monitoring",
      "evidence",
      "approval",
    ],
    ["physicalAccessOwner"],
    label,
  );

  assert(Object.hasOwn(CLUSTERS, host.clusterName), `${label}.clusterName is unknown`);
  assert(host.syntheticProvider === CLUSTERS[host.clusterName], `${label}.syntheticProvider does not match ${host.clusterName}`);
  assert(typeof host.siteId === "string" && /^site-[a-z0-9-]{1,32}$/.test(host.siteId), `${label}.siteId is invalid`);
  if (host.physicalAccessOwner !== undefined) nonEmptyString(host.physicalAccessOwner, `${label}.physicalAccessOwner`, 3, 120);
  assert(typeof host.serialHash === "string" && SHA256_RE.test(host.serialHash), `${label}.serialHash must be lowercase SHA-256`);

  exactKeys(
    host.hardware,
    ["manufacturer", "model", "architecture", "logicalCpuCount", "memoryMiB", "ethernet", "disk", "battery", "thermalSensors"],
    [],
    `${label}.hardware`,
  );
  nonEmptyString(host.hardware.manufacturer, `${label}.hardware.manufacturer`, 2, 120);
  nonEmptyString(host.hardware.model, `${label}.hardware.model`, 2, 120);
  assert(["x86_64", "aarch64"].includes(host.hardware.architecture), `${label}.hardware.architecture is unsupported`);
  boundedNumber(host.hardware.logicalCpuCount, 4, 512, `${label}.hardware.logicalCpuCount`, true);
  boundedNumber(host.hardware.memoryMiB, 16384, 2097152, `${label}.hardware.memoryMiB`, true);
  boolean(host.hardware.ethernet, true, `${label}.hardware.ethernet`);

  exactKeys(host.hardware.disk, ["device", "transport", "sizeGiB", "smartPassed", "rootEncrypted", "encryptionType", "healthPercent"], [], `${label}.hardware.disk`);
  assert(typeof host.hardware.disk.device === "string" && /^\/dev\/[A-Za-z0-9._/-]+$/.test(host.hardware.disk.device), `${label}.hardware.disk.device is invalid`);
  assert(["nvme", "sata"].includes(host.hardware.disk.transport), `${label}.hardware.disk.transport must be nvme or sata`);
  boundedNumber(host.hardware.disk.sizeGiB, 465, 32768, `${label}.hardware.disk.sizeGiB`, true);
  boolean(host.hardware.disk.smartPassed, true, `${label}.hardware.disk.smartPassed`);
  boolean(host.hardware.disk.rootEncrypted, true, `${label}.hardware.disk.rootEncrypted`);
  assert(host.hardware.disk.encryptionType === "luks2", `${label}.hardware.disk.encryptionType must be luks2`);
  boundedNumber(host.hardware.disk.healthPercent, 80, 100, `${label}.hardware.disk.healthPercent`);

  exactKeys(host.hardware.battery, ["present", "healthPercent", "cycleCount"], [], `${label}.hardware.battery`);
  boolean(host.hardware.battery.present, true, `${label}.hardware.battery.present`);
  boundedNumber(host.hardware.battery.healthPercent, 70, 100, `${label}.hardware.battery.healthPercent`);
  boundedNumber(host.hardware.battery.cycleCount, 0, 10000, `${label}.hardware.battery.cycleCount`, true);

  exactKeys(host.hardware.thermalSensors, ["available", "loadTestMaxC", "throttledDuringLoadTest"], [], `${label}.hardware.thermalSensors`);
  boolean(host.hardware.thermalSensors.available, true, `${label}.hardware.thermalSensors.available`);
  boundedNumber(host.hardware.thermalSensors.loadTestMaxC, 20, 95, `${label}.hardware.thermalSensors.loadTestMaxC`);
  boolean(host.hardware.thermalSensors.throttledDuringLoadTest, false, `${label}.hardware.thermalSensors.throttledDuringLoadTest`);

  exactKeys(host.firmware, ["secureBoot", "tpmAvailable", "autoPowerOnAfterLoss", "firmwareUpdatedAt"], ["secureBootException", "manualRestartProcedure"], `${label}.firmware`);
  boolean(host.firmware.secureBoot, undefined, `${label}.firmware.secureBoot`);
  boolean(host.firmware.tpmAvailable, undefined, `${label}.firmware.tpmAvailable`);
  boolean(host.firmware.autoPowerOnAfterLoss, undefined, `${label}.firmware.autoPowerOnAfterLoss`);
  timestamp(host.firmware.firmwareUpdatedAt, `${label}.firmware.firmwareUpdatedAt`);
  if (!host.firmware.secureBoot) nonEmptyString(host.firmware.secureBootException, `${label}.firmware.secureBootException`, 20, 1000);
  if (!host.firmware.autoPowerOnAfterLoss) nonEmptyString(host.firmware.manualRestartProcedure, `${label}.firmware.manualRestartProcedure`, 20, 1000);

  exactKeys(host.network, ["primaryTransport", "uploadMbps", "cgnat", "ispFingerprint", "failureDomainIndependent", "homeLanCidrs", "backupWan"], [], `${label}.network`);
  assert(host.network.primaryTransport === "ethernet", `${label}.network.primaryTransport must be ethernet`);
  boundedNumber(host.network.uploadMbps, 10, 100000, `${label}.network.uploadMbps`);
  boolean(host.network.cgnat, undefined, `${label}.network.cgnat`);
  assert(typeof host.network.ispFingerprint === "string" && SHA256_RE.test(host.network.ispFingerprint), `${label}.network.ispFingerprint must be lowercase SHA-256`);
  boolean(host.network.failureDomainIndependent, undefined, `${label}.network.failureDomainIndependent`);
  assert(Array.isArray(host.network.homeLanCidrs) && host.network.homeLanCidrs.length >= 1 && host.network.homeLanCidrs.length <= 16, `${label}.network.homeLanCidrs must contain 1..16 CIDRs`);
  assert(new Set(host.network.homeLanCidrs).size === host.network.homeLanCidrs.length, `${label}.network.homeLanCidrs contains duplicates`);
  const homeRanges = host.network.homeLanCidrs.map((value, cidrIndex) => cidrRange(value, `${label}.network.homeLanCidrs[${cidrIndex}]`));

  exactKeys(host.network.backupWan, ["available", "independentProvider", "testedAt"], ["exception"], `${label}.network.backupWan`);
  boolean(host.network.backupWan.available, undefined, `${label}.network.backupWan.available`);
  boolean(host.network.backupWan.independentProvider, undefined, `${label}.network.backupWan.independentProvider`);
  if (host.network.backupWan.testedAt !== null) timestamp(host.network.backupWan.testedAt, `${label}.network.backupWan.testedAt`);
  if (!host.network.backupWan.available || !host.network.backupWan.independentProvider) {
    nonEmptyString(host.network.backupWan.exception, `${label}.network.backupWan.exception`, 20, 1000);
  }

  exactKeys(host.power, ["laptopBatteryMinutes", "routerUpsMinutes", "independentUtilityDomain"], [], `${label}.power`);
  boundedNumber(host.power.laptopBatteryMinutes, 15, 1440, `${label}.power.laptopBatteryMinutes`, true);
  boundedNumber(host.power.routerUpsMinutes, 15, 1440, `${label}.power.routerUpsMinutes`, true);
  boolean(host.power.independentUtilityDomain, undefined, `${label}.power.independentUtilityDomain`);

  const policyKeys = [
    "dedicatedAppliance",
    "dualBoot",
    "nixManaged",
    "fullDiskEncryption",
    "passwordSsh",
    "rootSsh",
    "firewallEnabled",
    "publicManagementPorts",
    "sleepEnabled",
    "hibernateEnabled",
    "lidAction",
    "timeSync",
    "watchdog",
    "automaticFleetWideUpdates",
    "k3sVersion",
  ];
  exactKeys(host.hostPolicy, policyKeys, [], `${label}.hostPolicy`);
  for (const key of ["dedicatedAppliance", "nixManaged", "fullDiskEncryption", "firewallEnabled", "timeSync", "watchdog"]) {
    boolean(host.hostPolicy[key], true, `${label}.hostPolicy.${key}`);
  }
  for (const key of ["dualBoot", "passwordSsh", "rootSsh", "publicManagementPorts", "sleepEnabled", "hibernateEnabled", "automaticFleetWideUpdates"]) {
    boolean(host.hostPolicy[key], false, `${label}.hostPolicy.${key}`);
  }
  assert(host.hostPolicy.lidAction === "ignore", `${label}.hostPolicy.lidAction must be ignore`);
  assert(typeof host.hostPolicy.k3sVersion === "string" && K3S_VERSION_RE.test(host.hostPolicy.k3sVersion), `${label}.hostPolicy.k3sVersion must be exact vX.Y.Z+k3sN`);

  const monitoringKeys = ["smart", "nvmeWear", "diskUsage", "battery", "temperature", "thermalThrottle", "clockDrift", "wan", "power", "diskWarningPercent", "diskCriticalPercent"];
  exactKeys(host.monitoring, monitoringKeys, [], `${label}.monitoring`);
  for (const key of monitoringKeys.slice(0, 9)) boolean(host.monitoring[key], true, `${label}.monitoring.${key}`);
  boundedNumber(host.monitoring.diskWarningPercent, 60, 75, `${label}.monitoring.diskWarningPercent`, true);
  boundedNumber(host.monitoring.diskCriticalPercent, 80, 90, `${label}.monitoring.diskCriticalPercent`, true);
  assert(host.monitoring.diskWarningPercent < host.monitoring.diskCriticalPercent, `${label} disk warning threshold must be below critical`);

  validateEvidence(host.evidence, `${label}.evidence`, evidenceMode);

  exactKeys(host.approval, ["status", "reviewer", "reviewedAt"], ["notes"], `${label}.approval`);
  assert(["pending", "approved", "rejected"].includes(host.approval.status), `${label}.approval.status is invalid`);
  nonEmptyString(host.approval.reviewer, `${label}.approval.reviewer`, 3, 120);
  if (host.approval.reviewedAt !== null) timestamp(host.approval.reviewedAt, `${label}.approval.reviewedAt`);
  if (host.approval.notes !== null && host.approval.notes !== undefined) nonEmptyString(host.approval.notes, `${label}.approval.notes`, 20, 2000);

  return { host, homeRanges };
}

export function validateFleetInventory(inventory, { allowExample = false, now = new Date() } = {}) {
  scanSecrets(inventory);
  exactKeys(inventory, ["schemaVersion", "evidenceMode", "capturedAt", "reviewedAt", "launchClassification", "hosts"], ["fleetException"], "inventory");
  assert(inventory.schemaVersion === 1, "schemaVersion must equal 1");
  assert(["example", "live"].includes(inventory.evidenceMode), "evidenceMode must be example or live");
  if (inventory.evidenceMode === "example" && !allowExample) fail("example inventory is non-production and requires --allow-example");
  assert(["beta-only", "limited-production"].includes(inventory.launchClassification), "launchClassification is invalid");
  if (inventory.launchClassification === "beta-only") nonEmptyString(inventory.fleetException, "fleetException", 20, 2000);
  if (inventory.launchClassification === "limited-production") assert(inventory.fleetException === null || inventory.fleetException === undefined, "limited-production cannot carry an unresolved fleetException");

  const capturedAt = timestamp(inventory.capturedAt, "capturedAt");
  const reviewedAt = timestamp(inventory.reviewedAt, "reviewedAt");
  assert(reviewedAt >= capturedAt, "reviewedAt cannot precede capturedAt");
  assert(reviewedAt <= now, "reviewedAt cannot be in the future");
  if (inventory.evidenceMode === "live") {
    assert(now - capturedAt <= MAX_CAPTURE_AGE_MS, "live hardware inventory is older than 30 days");
    assert(now - reviewedAt <= MAX_REVIEW_AGE_MS, "live inventory review is older than 7 days");
  }

  assert(Array.isArray(inventory.hosts) && inventory.hosts.length === 3, "hosts must contain exactly three entries");
  const validatedHosts = inventory.hosts.map((host, index) => validateHost(host, index, inventory.evidenceMode));
  const hosts = validatedHosts.map((entry) => entry.host);
  const expectedClusters = Object.keys(CLUSTERS).sort();
  const actualClusters = hosts.map((host) => host.clusterName).sort();
  assert(JSON.stringify(actualClusters) === JSON.stringify(expectedClusters), `hosts must exactly cover ${expectedClusters.join(", ")}`);

  for (const [field, values] of [
    ["siteId", hosts.map((host) => host.siteId)],
    ["serialHash", hosts.map((host) => host.serialHash)],
  ]) {
    assert(new Set(values).size === 3, `${field} must be unique across all three hosts`);
  }
  assert(new Set(hosts.map((host) => host.hostPolicy.k3sVersion)).size === 1, "all hosts must pin the same K3s version");

  const topology = loadTopology(topologyPath);
  const reservedRanges = topology.cluster.flatMap((cluster) => [
    { owner: `${cluster.name}.pod_cidr`, ...cidrRange(cluster.pod_cidr, `${cluster.name}.pod_cidr`) },
    { owner: `${cluster.name}.service_cidr`, ...cidrRange(cluster.service_cidr, `${cluster.name}.service_cidr`) },
  ]);
  for (const [hostIndex, validated] of validatedHosts.entries()) {
    for (const home of validated.homeRanges) {
      for (const reserved of reservedRanges) {
        assert(!rangesOverlap(home, reserved), `hosts[${hostIndex}] home LAN ${home.value} overlaps ${reserved.owner} ${reserved.value}`);
      }
    }
  }
  const allHomeRanges = validatedHosts.flatMap((entry, hostIndex) => entry.homeRanges.map((range) => ({ ...range, hostIndex })));
  for (let left = 0; left < allHomeRanges.length; left += 1) {
    for (let right = left + 1; right < allHomeRanges.length; right += 1) {
      if (allHomeRanges[left].hostIndex !== allHomeRanges[right].hostIndex) {
        assert(!rangesOverlap(allHomeRanges[left], allHomeRanges[right]), `home LAN CIDRs overlap across hosts: ${allHomeRanges[left].value} and ${allHomeRanges[right].value}`);
      }
    }
  }

  const independentSites = hosts.every((host) => host.network.failureDomainIndependent && host.power.independentUtilityDomain);
  const distinctIsps = new Set(hosts.map((host) => host.network.ispFingerprint)).size === 3;
  const backupWans = hosts.every((host) => host.network.backupWan.available && host.network.backupWan.independentProvider && host.network.backupWan.testedAt !== null);
  const secureBoot = hosts.every((host) => host.firmware.secureBoot);
  const approved = hosts.every((host) => host.approval.status === "approved" && host.approval.reviewedAt !== null);

  if (inventory.launchClassification === "limited-production") {
    assert(independentSites, "limited-production requires independent site and utility failure domains");
    assert(distinctIsps, "limited-production requires three distinct ISP fingerprints");
    assert(backupWans, "limited-production requires tested independent backup WAN on every host");
    assert(secureBoot, "limited-production requires Secure Boot on every host");
    assert(approved, "limited-production requires explicit approval for every host");
  }
  if (inventory.evidenceMode === "live") assert(approved, "live fleet inventory requires explicit approval for every host");

  const report = {
    schemaVersion: 1,
    status: "passed",
    softwareOnly: false,
    evidenceMode: inventory.evidenceMode,
    launchClassification: inventory.launchClassification,
    fleetFingerprint: digest(inventory),
    capturedAt: inventory.capturedAt,
    reviewedAt: inventory.reviewedAt,
    clusters: hosts.map((host) => ({
      clusterName: host.clusterName,
      syntheticProvider: host.syntheticProvider,
      siteId: host.siteId,
      architecture: host.hardware.architecture,
      logicalCpuCount: host.hardware.logicalCpuCount,
      memoryMiB: host.hardware.memoryMiB,
      diskGiB: host.hardware.disk.sizeGiB,
      diskHealthPercent: host.hardware.disk.healthPercent,
      batteryHealthPercent: host.hardware.battery.healthPercent,
      uploadMbps: host.network.uploadMbps,
      backupWan: host.network.backupWan.available,
      k3sVersion: host.hostPolicy.k3sVersion,
      approval: host.approval.status,
    })),
    capacity: {
      totalLogicalCpuCount: hosts.reduce((sum, host) => sum + host.hardware.logicalCpuCount, 0),
      totalMemoryMiB: hosts.reduce((sum, host) => sum + host.hardware.memoryMiB, 0),
      totalDiskGiB: hosts.reduce((sum, host) => sum + host.hardware.disk.sizeGiB, 0),
      minimumUploadMbps: Math.min(...hosts.map((host) => host.network.uploadMbps)),
      minimumLaptopBatteryMinutes: Math.min(...hosts.map((host) => host.power.laptopBatteryMinutes)),
      minimumRouterUpsMinutes: Math.min(...hosts.map((host) => host.power.routerUpsMinutes)),
    },
    failureDomains: {
      distinctSites: true,
      independentSites,
      distinctIsps,
      independentBackupWanEverywhere: backupWans,
    },
    controls: {
      secureBootEverywhere: secureBoot,
      rootEncryptedEverywhere: hosts.every((host) => host.hardware.disk.rootEncrypted),
      passwordSshDisabledEverywhere: hosts.every((host) => !host.hostPolicy.passwordSsh),
      publicManagementDisabledEverywhere: hosts.every((host) => !host.hostPolicy.publicManagementPorts),
      sleepDisabledEverywhere: hosts.every((host) => !host.hostPolicy.sleepEnabled && !host.hostPolicy.hibernateEnabled),
      watchdogEverywhere: hosts.every((host) => host.hostPolicy.watchdog),
      approvedEverywhere: approved,
    },
    nonClaims: [
      "A passing example inventory is not production evidence.",
      "The validator does not discover hardware or independently verify evidence identifiers.",
      "Live power, WAN, thermal, rebuild, revocation, and failure tests remain required.",
    ],
  };
  return report;
}

export function loadInventory(file) {
  if (!file || !fs.existsSync(file)) fail(`inventory file does not exist: ${file || "(none)"}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid inventory JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usage() {
  return [
    "usage: node tools/validate-laptop-inventory.mjs --inventory <file> [--allow-example] [--now <iso-timestamp>]",
    "",
    `default example: ${path.relative(root, defaultInventoryPath)}`,
  ].join("\n");
}

function parseArgs(argv) {
  const args = { inventory: null, allowExample: false, now: new Date() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--inventory") args.inventory = path.resolve(argv[++index] ?? "");
    else if (arg === "--allow-example") args.allowExample = true;
    else if (arg === "--now") args.now = timestamp(argv[++index], "--now");
    else if (arg === "--help" || arg === "-h") args.help = true;
    else fail(`unknown argument ${JSON.stringify(arg)}\n${usage()}`);
  }
  return args;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    assert(args.inventory, `--inventory is required\n${usage()}`);
    const report = validateFleetInventory(loadInventory(args.inventory), {
      allowExample: args.allowExample,
      now: args.now,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
