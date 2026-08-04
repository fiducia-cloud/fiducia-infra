#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const defaultInventory = path.join(root, "external-probes", "managed-beta", "fleet.example.json");

export const PROBE_SOURCE_COMMIT = "a46f116853875b5a3a1b633ab1591253b1bbd4ed";
export const PROBE_IMAGE = "ghcr.io/fiducia-cloud/fiducia-managed-beta-probe@sha256:cc251cb82f131616e73c070929f4dd9066228d1a90e86c627933f787e63e0941";
export const REQUIRED_OPERATIONS = [
  "health",
  "linearizable_read",
  "committed_write",
  "renewal",
  "secret_read",
  "watch_reconcile",
];
export const FAILURE_DOMAIN_FIELDS = [
  "physicalHostHash",
  "schedulerHash",
  "runtimeIdentityHash",
  "stateAuthorityHash",
  "credentialHash",
  "outboundNetworkHash",
  "dnsResolverHash",
  "localProxyHash",
  "operatorOwnerHash",
];

const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DNS_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TARGET_RE = /^((?=.{1,253}:)[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):([1-9][0-9]{0,4})$/;
const METHOD_SET = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\btskey-(?:auth|client)-[A-Za-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
];
const FORBIDDEN_VALUE_KEYS = /^(?:bearerToken|tokenValue|password|privateKeyPem|clientSecret|secretValue)$/i;

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

function boundedInteger(value, minimum, maximum, label) {
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label} must be an integer in ${minimum}..${maximum}`);
  return value;
}

function boundedLabel(value, label) {
  assert(typeof value === "string" && LABEL_RE.test(value), `${label} must match ${LABEL_RE}`);
  return value;
}

function absolutePath(value, label) {
  assert(typeof value === "string" && path.isAbsolute(value), `${label} must be an absolute path`);
  assert(!/[\s\0]/u.test(value), `${label} must not contain whitespace or NUL`);
  assert(!value.split(path.sep).includes(".."), `${label} must not contain parent traversal`);
  return path.normalize(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableDigest(value) {
  return sha256(JSON.stringify(stableValue(value)));
}

function exactSet(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(new Set(actual).size === actual.length, `${label} contains duplicates`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(JSON.stringify(left) === JSON.stringify(right), `${label} must exactly equal [${right.join(", ")}]`);
}

function scanCredentials(value, location = "inventory") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanCredentials(entry, `${location}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assert(!FORBIDDEN_VALUE_KEYS.test(key), `${location}.${key} is a prohibited secret-value field`);
      scanCredentials(child, `${location}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    for (const pattern of CREDENTIAL_PATTERNS) {
      assert(!pattern.test(value), `${location} contains a credential-like value`);
    }
  }
}

function validateEndpoint(value, label, evidenceMode) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  assert(endpoint.protocol === "https:", `${label} must use HTTPS`);
  assert(!endpoint.username && !endpoint.password && !endpoint.hash, `${label} must not contain userinfo or a fragment`);
  assert(!endpoint.search, `${label} must not contain query parameters or resource keys`);
  assert(net.isIP(endpoint.hostname) === 0, `${label} must use a reviewed DNS hostname rather than an IP literal`);
  assert(DNS_RE.test(endpoint.hostname), `${label} hostname is invalid`);
  if (evidenceMode === "live") assert(!endpoint.hostname.endsWith(".invalid"), `${label} cannot use an example.invalid hostname in live mode`);
  return endpoint.toString();
}

function validateTarget(value, label, evidenceMode) {
  assert(typeof value === "string", `${label} must be a string`);
  const match = value.match(TARGET_RE);
  assert(match, `${label} must be a DNS hostname and port`);
  const port = Number(match[2]);
  assert(port <= 65535, `${label} port must be <= 65535`);
  assert(net.isIP(match[1]) === 0 && DNS_RE.test(match[1]), `${label} must not use an IP literal`);
  if (evidenceMode === "live") assert(!match[1].endsWith(".invalid"), `${label} cannot use an example.invalid hostname in live mode`);
  return { host: match[1], port };
}

function validateTls(value, label) {
  exactKeys(value, ["certificateFile", "privateKeyFile"], ["clientCaFile"], label);
  absolutePath(value.certificateFile, `${label}.certificateFile`);
  absolutePath(value.privateKeyFile, `${label}.privateKeyFile`);
  if (Object.hasOwn(value, "clientCaFile")) absolutePath(value.clientCaFile, `${label}.clientCaFile`);
}

function validateOperation(operation, locationId, index, evidenceMode) {
  const label = `locations.${locationId}.operations[${index}]`;
  exactKeys(operation, ["operationClass", "endpoint", "method", "expectedStatuses", "timeoutMs"], [], label);
  boundedLabel(operation.operationClass, `${label}.operationClass`);
  assert(REQUIRED_OPERATIONS.includes(operation.operationClass), `${label}.operationClass is unsupported`);
  validateEndpoint(operation.endpoint, `${label}.endpoint`, evidenceMode);
  assert(METHOD_SET.has(operation.method), `${label}.method is unsupported`);
  assert(Array.isArray(operation.expectedStatuses) && operation.expectedStatuses.length >= 1 && operation.expectedStatuses.length <= 10, `${label}.expectedStatuses must contain 1..10 statuses`);
  assert(new Set(operation.expectedStatuses).size === operation.expectedStatuses.length, `${label}.expectedStatuses contains duplicates`);
  for (const [statusIndex, status] of operation.expectedStatuses.entries()) {
    boundedInteger(status, 100, 599, `${label}.expectedStatuses[${statusIndex}]`);
  }
  boundedInteger(operation.timeoutMs, 100, 30000, `${label}.timeoutMs`);
  return operation;
}

function validateLocation(location, index, evidenceMode) {
  const label = `locations[${index}]`;
  exactKeys(
    location,
    [
      "id",
      "platform",
      "runtimeUser",
      "podmanBinary",
      "nodeExporterBinary",
      "nodeExporterBinarySha256",
      "stateRoot",
      "textfileRoot",
      "bearerFile",
      "metricsTarget",
      "metricsServerName",
      "serverTls",
      "scrapeTls",
      "schedule",
      "failureDomains",
      "operations",
    ],
    [],
    label,
  );
  boundedLabel(location.id, `${label}.id`);
  assert(["linux/amd64", "linux/arm64"].includes(location.platform), `${label}.platform must be linux/amd64 or linux/arm64`);
  assert(typeof location.runtimeUser === "string" && USER_RE.test(location.runtimeUser) && location.runtimeUser !== "root", `${label}.runtimeUser must be a bounded non-root account`);
  absolutePath(location.podmanBinary, `${label}.podmanBinary`);
  absolutePath(location.nodeExporterBinary, `${label}.nodeExporterBinary`);
  assert(SHA256_RE.test(location.nodeExporterBinarySha256), `${label}.nodeExporterBinarySha256 must be lowercase SHA-256`);
  absolutePath(location.stateRoot, `${label}.stateRoot`);
  absolutePath(location.textfileRoot, `${label}.textfileRoot`);
  absolutePath(location.bearerFile, `${label}.bearerFile`);
  const target = validateTarget(location.metricsTarget, `${label}.metricsTarget`, evidenceMode);
  assert(location.metricsServerName === target.host, `${label}.metricsServerName must match the metrics target hostname`);
  validateTls(location.serverTls, `${label}.serverTls`);
  validateTls(location.scrapeTls, `${label}.scrapeTls`);
  assert(Object.hasOwn(location.serverTls, "clientCaFile"), `${label}.serverTls.clientCaFile is required for mTLS`);
  assert(!Object.hasOwn(location.scrapeTls, "clientCaFile"), `${label}.scrapeTls must contain only the central client CA/certificate/key paths`);

  exactKeys(location.schedule, ["intervalSeconds", "randomizedDelaySeconds"], [], `${label}.schedule`);
  boundedInteger(location.schedule.intervalSeconds, 30, 300, `${label}.schedule.intervalSeconds`);
  boundedInteger(location.schedule.randomizedDelaySeconds, 0, location.schedule.intervalSeconds - 1, `${label}.schedule.randomizedDelaySeconds`);

  exactKeys(location.failureDomains, FAILURE_DOMAIN_FIELDS, [], `${label}.failureDomains`);
  for (const field of FAILURE_DOMAIN_FIELDS) {
    assert(SHA256_RE.test(location.failureDomains[field]), `${label}.failureDomains.${field} must be lowercase SHA-256`);
  }

  assert(Array.isArray(location.operations), `${label}.operations must be an array`);
  const operations = location.operations.map((operation, operationIndex) => validateOperation(operation, location.id, operationIndex, evidenceMode));
  exactSet(operations.map((operation) => operation.operationClass), REQUIRED_OPERATIONS, `${label}.operationClasses`);
  return { ...location, target, operations };
}

export function validateProbeFleet(inventory, { allowExample = false } = {}) {
  scanCredentials(inventory);
  exactKeys(inventory, ["schemaVersion", "evidenceMode", "sourceCommit", "image", "cell", "locations"], [], "inventory");
  assert(inventory.schemaVersion === 1, "inventory.schemaVersion must equal 1");
  assert(["example", "live"].includes(inventory.evidenceMode), "inventory.evidenceMode must be example or live");
  if (inventory.evidenceMode === "example" && !allowExample) fail("example probe inventory requires --allow-example");
  assert(inventory.sourceCommit === PROBE_SOURCE_COMMIT, `inventory.sourceCommit must equal ${PROBE_SOURCE_COMMIT}`);
  assert(inventory.image === PROBE_IMAGE, `inventory.image must equal the published immutable digest ${PROBE_IMAGE}`);
  boundedLabel(inventory.cell, "inventory.cell");
  assert(Array.isArray(inventory.locations) && inventory.locations.length >= 2 && inventory.locations.length <= 8, "inventory.locations must contain 2..8 independent locations");

  const locations = inventory.locations.map((location, index) => validateLocation(location, index, inventory.evidenceMode));
  const uniqueFields = [
    ["location id", locations.map((location) => location.id)],
    ["state root", locations.map((location) => location.stateRoot)],
    ["textfile root", locations.map((location) => location.textfileRoot)],
    ["bearer file", locations.map((location) => location.bearerFile)],
    ["metrics target", locations.map((location) => location.metricsTarget)],
    ["server certificate", locations.map((location) => location.serverTls.certificateFile)],
    ["server private key", locations.map((location) => location.serverTls.privateKeyFile)],
    ["scrape client certificate", locations.map((location) => location.scrapeTls.certificateFile)],
    ["scrape client private key", locations.map((location) => location.scrapeTls.privateKeyFile)],
  ];
  for (const [field, values] of uniqueFields) {
    assert(new Set(values).size === values.length, `${field} must be unique across probe locations`);
  }
  for (const field of FAILURE_DOMAIN_FIELDS) {
    const values = locations.map((location) => location.failureDomains[field]);
    assert(new Set(values).size === values.length, `${field} must be distinct across probe locations`);
  }

  return {
    schemaVersion: 1,
    evidenceMode: inventory.evidenceMode,
    sourceCommit: inventory.sourceCommit,
    image: inventory.image,
    cell: inventory.cell,
    locations,
    inventoryFingerprint: stableDigest(inventory),
  };
}

function quoteEnvironment(value) {
  return JSON.stringify(String(value));
}

function operationSlug(operationClass) {
  return operationClass.replaceAll("_", "-");
}

function renderEnvironment(fleet, location, operation) {
  return [
    `FIDUCIA_PROBE_ENDPOINT=${quoteEnvironment(operation.endpoint)}`,
    `FIDUCIA_PROBE_CELL=${quoteEnvironment(fleet.cell)}`,
    `FIDUCIA_PROBE_OPERATION_CLASS=${quoteEnvironment(operation.operationClass)}`,
    `FIDUCIA_PROBE_METHOD=${quoteEnvironment(operation.method)}`,
    `FIDUCIA_PROBE_TIMEOUT_MS=${quoteEnvironment(operation.timeoutMs)}`,
    `FIDUCIA_PROBE_EXPECT_STATUS=${quoteEnvironment(operation.expectedStatuses.join(","))}`,
    `FIDUCIA_PROBE_BEARER_FILE=${quoteEnvironment("/run/secrets/bearer")}`,
    `FIDUCIA_PROBE_STATE_FILE=${quoteEnvironment(`/state/${operation.operationClass}.json`)}`,
    `FIDUCIA_PROBE_TEXTFILE=${quoteEnvironment(`/textfile/fiducia_external_probe_${operation.operationClass}.prom`)}`,
    "",
  ].join("\n");
}

function renderProbeService(fleet, location, operation) {
  const slug = operationSlug(operation.operationClass);
  const name = `fiducia-managed-beta-probe-${location.id}-${slug}`;
  const envPath = `/etc/fiducia-managed-beta-probe/${location.id}/${operation.operationClass}.env`;
  const podman = location.podmanBinary;
  const exec = [
    podman,
    "run",
    "--rm",
    `--name=${name}`,
    "--pull=never",
    "--userns=keep-id",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=128m",
    "--cpus=0.50",
    "--network=slirp4netns:allow_host_loopback=false",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--log-driver=journald",
    `--env-file=${envPath}`,
    `--mount=type=bind,src=${location.stateRoot},dst=/state`,
    `--mount=type=bind,src=${location.textfileRoot},dst=/textfile`,
    `--mount=type=bind,src=${location.bearerFile},dst=/run/secrets/bearer,ro=true`,
    fleet.image,
  ].join(" ");

  return `[Unit]
Description=Fiducia managed-beta external probe ${location.id}/${operation.operationClass}
Documentation=https://linear.app/denman/issue/DEN-1619
After=network-online.target
Wants=network-online.target
ConditionPathIsDirectory=${location.stateRoot}
ConditionPathIsDirectory=${location.textfileRoot}
ConditionPathExists=${location.bearerFile}

[Service]
Type=oneshot
User=${location.runtimeUser}
Group=${location.runtimeUser}
UMask=0077
Environment=HOME=/var/lib/fiducia-managed-beta-runtime
Environment=XDG_RUNTIME_DIR=/run/fiducia-managed-beta-runtime
EnvironmentFile=${envPath}
RuntimeDirectory=fiducia-managed-beta-runtime
RuntimeDirectoryMode=0700
StateDirectory=fiducia-managed-beta-runtime
StateDirectoryMode=0700
ExecStartPre=/usr/bin/test -s ${location.bearerFile}
ExecStart=${exec}
NoNewPrivileges=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true

# The host firewall/egress gateway must independently restrict outbound DNS and
# the reviewed Fiducia HTTPS endpoint. Standard rootless Podman networking cannot
# express an FQDN allowlist, so this unit does not claim that control.
`;
}

function renderProbeTimer(location, operation) {
  const slug = operationSlug(operation.operationClass);
  return `[Unit]
Description=Schedule Fiducia managed-beta external probe ${location.id}/${operation.operationClass}

[Timer]
OnBootSec=30s
OnUnitActiveSec=${location.schedule.intervalSeconds}s
RandomizedDelaySec=${location.schedule.randomizedDelaySeconds}s
AccuracySec=1s
Persistent=true
Unit=fiducia-managed-beta-probe-${location.id}-${slug}.service

[Install]
WantedBy=timers.target
`;
}

function renderNodeExporterWeb(location) {
  return `tls_server_config:
  cert_file: ${location.serverTls.certificateFile}
  key_file: ${location.serverTls.privateKeyFile}
  client_auth_type: RequireAndVerifyClientCert
  client_ca_file: ${location.serverTls.clientCaFile}
  min_version: TLS13
`;
}

function renderNodeExporterService(location) {
  return `[Unit]
Description=Fiducia managed-beta textfile exporter ${location.id}
Documentation=https://linear.app/denman/issue/DEN-1619
After=network-online.target
Wants=network-online.target
ConditionPathIsDirectory=${location.textfileRoot}
ConditionPathExists=${location.serverTls.certificateFile}
ConditionPathExists=${location.serverTls.privateKeyFile}
ConditionPathExists=${location.serverTls.clientCaFile}

[Service]
Type=simple
User=${location.runtimeUser}
Group=${location.runtimeUser}
UMask=0077
ExecStartPre=/usr/bin/sha256sum --check /etc/fiducia-managed-beta-probe/${location.id}/node-exporter.sha256
ExecStart=${location.nodeExporterBinary} --collector.disable-defaults --collector.textfile --collector.textfile.directory=${location.textfileRoot} --web.listen-address=:${location.target.port} --web.config.file=/etc/fiducia-managed-beta-probe/${location.id}/node-exporter-web.yml
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true
ReadOnlyPaths=${location.textfileRoot}
ReadOnlyPaths=${location.serverTls.certificateFile}
ReadOnlyPaths=${location.serverTls.privateKeyFile}
ReadOnlyPaths=${location.serverTls.clientCaFile}

# Host firewall policy must allow this mTLS listener only from the central
# Prometheus monitoring identity/private path. Binding does not establish trust.

[Install]
WantedBy=multi-user.target
`;
}

function renderScrapeConfig(fleet) {
  return fleet.locations.map((location) => `- job_name: managed-beta-external-probe-${location.id}
  honor_labels: false
  scheme: https
  metrics_path: /metrics
  scrape_interval: 30s
  scrape_timeout: 10s
  static_configs:
    - targets: ["${location.metricsTarget}"]
      labels:
        probe_location: ${location.id}
  tls_config:
    ca_file: ${location.scrapeTls.caFile}
    cert_file: ${location.scrapeTls.certificateFile}
    key_file: ${location.scrapeTls.privateKeyFile}
    server_name: ${location.metricsServerName}
    min_version: TLS13
`).join("\n");
}

export function renderProbeHostFleet(inventory, options = {}) {
  const fleet = validateProbeFleet(inventory, options);
  const files = {};
  for (const location of fleet.locations) {
    const prefix = `locations/${location.id}`;
    files[`${prefix}/node-exporter-web.yml`] = renderNodeExporterWeb(location);
    files[`${prefix}/node-exporter.sha256`] = `${location.nodeExporterBinarySha256}  ${location.nodeExporterBinary}\n`;
    files[`${prefix}/systemd/fiducia-managed-beta-node-exporter.service`] = renderNodeExporterService(location);
    for (const operation of location.operations) {
      const slug = operationSlug(operation.operationClass);
      files[`${prefix}/env/${operation.operationClass}.env`] = renderEnvironment(fleet, location, operation);
      files[`${prefix}/systemd/fiducia-managed-beta-probe-${location.id}-${slug}.service`] = renderProbeService(fleet, location, operation);
      files[`${prefix}/systemd/fiducia-managed-beta-probe-${location.id}-${slug}.timer`] = renderProbeTimer(location, operation);
    }
  }
  files["central-prometheus/managed-beta-external-probes.yml"] = renderScrapeConfig(fleet);

  const fileDigests = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => [name, sha256(content)]),
  );
  const manifest = {
    schemaVersion: 1,
    evidenceMode: fleet.evidenceMode,
    sourceCommit: fleet.sourceCommit,
    image: fleet.image,
    cell: fleet.cell,
    locations: fleet.locations.map((location) => ({
      id: location.id,
      platform: location.platform,
      metricsTarget: location.metricsTarget,
      operationClasses: location.operations.map((operation) => operation.operationClass).sort(),
    })),
    inventoryFingerprint: fleet.inventoryFingerprint,
    fileDigests,
    nonClaims: [
      "Rendered files do not prove that a probe host or monitoring target is deployed.",
      "Opaque hashes and distinct labels do not independently prove physical failure-domain independence.",
      "The host firewall, credential delivery, binary installation, private DNS, and central Prometheus rollout remain deployment responsibilities.",
      "DEN-1619 remains open until both live locations and all failure/recovery drills have reviewed evidence.",
    ],
  };
  files["manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  return { fleet, files, manifest };
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export async function writeProbeHostFleet(inventory, outputDir, { allowExample = false, overwrite = false } = {}) {
  const rendered = renderProbeHostFleet(inventory, { allowExample });
  const destination = path.resolve(outputDir);
  if (rendered.fleet.evidenceMode === "live") {
    assert(!isInside(root, destination), "live rendered deployment material must be written outside the Git checkout");
  }
  if (fs.existsSync(destination)) {
    const entries = await fsp.readdir(destination);
    assert(overwrite || entries.length === 0, `output directory is not empty: ${destination}; pass --overwrite explicitly`);
  }
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [relativePath, content] of Object.entries(rendered.files)) {
    const absolute = path.join(destination, relativePath);
    await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    const privateFile = relativePath.includes("/env/") || relativePath.endsWith("node-exporter-web.yml");
    await fsp.writeFile(absolute, content, { mode: privateFile ? 0o600 : 0o644 });
    await fsp.chmod(absolute, privateFile ? 0o600 : 0o644);
  }
  return { ...rendered, outputDir: destination };
}

export function loadProbeInventory(file) {
  assert(typeof file === "string" && file, "inventory file is required");
  assert(fs.existsSync(file), `inventory file does not exist: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid inventory JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usage() {
  return [
    "usage:",
    "  node tools/render-managed-beta-probe-hosts.mjs --inventory <json> --output-dir <dir> [--allow-example] [--overwrite]",
    "",
    `example inventory: ${path.relative(root, defaultInventory)}`,
  ].join("\n");
}

function parseArgs(argv) {
  const args = { inventory: null, outputDir: null, allowExample: false, overwrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--inventory") args.inventory = path.resolve(argv[++index] ?? "");
    else if (arg === "--output-dir") args.outputDir = path.resolve(argv[++index] ?? "");
    else if (arg === "--allow-example") args.allowExample = true;
    else if (arg === "--overwrite") args.overwrite = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else fail(`unknown argument ${JSON.stringify(arg)}\n${usage()}`);
  }
  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    assert(args.inventory && args.outputDir, `--inventory and --output-dir are required\n${usage()}`);
    const result = await writeProbeHostFleet(loadProbeInventory(args.inventory), args.outputDir, args);
    process.stdout.write(`${JSON.stringify({
      status: "rendered",
      evidenceMode: result.fleet.evidenceMode,
      outputDir: result.outputDir,
      locationCount: result.fleet.locations.length,
      fileCount: Object.keys(result.files).length,
      inventoryFingerprint: result.fleet.inventoryFingerprint,
      manifestFingerprint: sha256(result.files["manifest.json"]),
      nonClaims: result.manifest.nonClaims,
    }, null, 2)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
