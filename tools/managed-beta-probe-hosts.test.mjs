import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  FAILURE_DOMAIN_FIELDS,
  PROBE_IMAGE,
  PROBE_SOURCE_COMMIT,
  REQUIRED_OPERATIONS,
  loadProbeInventory,
  renderProbeHostFleet,
  validateProbeFleet,
  writeProbeHostFleet,
} from "./render-managed-beta-probe-hosts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const examplePath = path.join(root, "external-probes", "managed-beta", "fleet.example.json");
const example = () => structuredClone(loadProbeInventory(examplePath));

function makeLive() {
  const inventory = example();
  inventory.evidenceMode = "live";
  for (const location of inventory.locations) {
    location.metricsTarget = location.metricsTarget.replace("example.invalid", "example.com");
    location.metricsServerName = location.metricsServerName.replace("example.invalid", "example.com");
    for (const operation of location.operations) {
      operation.endpoint = operation.endpoint.replace("example.invalid", "example.com");
    }
  }
  return inventory;
}

function serviceFiles(rendered) {
  return Object.entries(rendered.files).filter(([name]) => name.endsWith(".service"));
}

test("example inventory is explicit, exact-digest, and accepted only in rehearsal mode", () => {
  assert.throws(() => validateProbeFleet(example()), /requires --allow-example/);
  const fleet = validateProbeFleet(example(), { allowExample: true });
  assert.equal(fleet.evidenceMode, "example");
  assert.equal(fleet.sourceCommit, PROBE_SOURCE_COMMIT);
  assert.equal(fleet.image, PROBE_IMAGE);
  assert.equal(fleet.locations.length, 2);
  assert.match(fleet.inventoryFingerprint, /^[a-f0-9]{64}$/);
});

test("every location covers the exact bounded operation matrix", () => {
  const fleet = validateProbeFleet(example(), { allowExample: true });
  for (const location of fleet.locations) {
    assert.deepEqual(
      location.operations.map((operation) => operation.operationClass).sort(),
      [...REQUIRED_OPERATIONS].sort(),
    );
    assert.ok(location.operations.every((operation) => operation.endpoint.startsWith("https://")));
    assert.ok(location.operations.every((operation) => !operation.endpoint.includes("?")));
  }
});

test("all independence authorities and sensitive runtime paths are distinct", () => {
  const fleet = validateProbeFleet(example(), { allowExample: true });
  for (const field of FAILURE_DOMAIN_FIELDS) {
    assert.equal(new Set(fleet.locations.map((location) => location.failureDomains[field])).size, 2, field);
  }
  for (const selector of [
    (location) => location.stateRoot,
    (location) => location.textfileRoot,
    (location) => location.bearerFile,
    (location) => location.metricsTarget,
    (location) => location.serverTls.privateKeyFile,
    (location) => location.scrapeTls.privateKeyFile,
  ]) {
    assert.equal(new Set(fleet.locations.map(selector)).size, 2);
  }
});

test("renderer emits rootless immutable probe units without self-asserted location labels", () => {
  const rendered = renderProbeHostFleet(example(), { allowExample: true });
  assert.equal(Object.keys(rendered.files).length, 44);
  for (const [name, content] of serviceFiles(rendered)) {
    if (name.includes("node-exporter")) continue;
    assert.ok(content.includes(PROBE_IMAGE));
    assert.match(content, /User=fiducia-probe/);
    assert.match(content, /--pull=never/);
    assert.match(content, /--userns=keep-id/);
    assert.match(content, /--read-only/);
    assert.match(content, /--cap-drop=ALL/);
    assert.match(content, /--security-opt=no-new-privileges/);
    assert.match(content, /--network=slirp4netns:allow_host_loopback=false/);
    assert.match(content, /dst=\/run\/secrets\/bearer,ro/);
    assert.match(content, /NoNewPrivileges=true/);
    assert.doesNotMatch(content, /probe_location|--privileged|--network=host|--pull=always/);
  }
  for (const [name, content] of Object.entries(rendered.files).filter(([file]) => file.includes("/env/"))) {
    assert.match(content, /^FIDUCIA_PROBE_ENDPOINT=https:\/\//m, name);
    assert.match(content, /^FIDUCIA_PROBE_BEARER_FILE=\/run\/secrets\/bearer$/m, name);
    assert.match(content, /^FIDUCIA_PROBE_STATE_FILE=\/state\//m, name);
    assert.match(content, /^FIDUCIA_PROBE_TEXTFILE=\/textfile\//m, name);
    assert.doesNotMatch(content, /probe_location|Bearer |token=/i, name);
  }
});

test("one timer per operation is persistent, non-overlapping by systemd, and independently jittered", () => {
  const rendered = renderProbeHostFleet(example(), { allowExample: true });
  const timers = Object.entries(rendered.files).filter(([name]) => name.endsWith(".timer"));
  assert.equal(timers.length, 12);
  for (const [name, content] of timers) {
    assert.match(content, /OnUnitActiveSec=60s/, name);
    assert.match(content, /RandomizedDelaySec=(?:10|25)s/, name);
    assert.match(content, /Persistent=true/, name);
    assert.match(content, /Unit=fiducia-managed-beta-probe-/, name);
  }
});

test("textfile exporter is checksum-gated and requires TLS 1.3 mutual authentication", () => {
  const rendered = renderProbeHostFleet(example(), { allowExample: true });
  for (const location of ["probe-a", "probe-b"]) {
    const web = rendered.files[`locations/${location}/node-exporter-web.yml`];
    const service = rendered.files[`locations/${location}/systemd/fiducia-managed-beta-node-exporter.service`];
    const checksum = rendered.files[`locations/${location}/node-exporter.sha256`];
    assert.match(web, /client_auth_type: RequireAndVerifyClientCert/);
    assert.match(web, /client_ca_file:/);
    assert.match(web, /min_version: TLS13/);
    assert.match(service, /sha256sum --check/);
    assert.match(service, /--collector\.disable-defaults/);
    assert.match(service, /--collector\.textfile/);
    assert.match(service, /--web\.config\.file=/);
    assert.match(service, /NoNewPrivileges=true/);
    assert.match(checksum, /^[a-f0-9]{64}  \/usr\/local\/bin\/node_exporter\n$/);
  }
});

test("central scrape config injects trusted location identities and mTLS per target", () => {
  const rendered = renderProbeHostFleet(example(), { allowExample: true });
  const scrape = rendered.files["central-prometheus/managed-beta-external-probes.yml"];
  assert.equal((scrape.match(/job_name: managed-beta-external-probe-/g) ?? []).length, 2);
  assert.equal((scrape.match(/honor_labels: false/g) ?? []).length, 2);
  assert.equal((scrape.match(/probe_location: probe-[ab]/g) ?? []).length, 2);
  assert.equal((scrape.match(/min_version: TLS13/g) ?? []).length, 2);
  assert.equal((scrape.match(/server_name: probe-[ab]\.example\.invalid/g) ?? []).length, 2);
  assert.match(scrape, /cert_file: \/run\/secrets\/managed-beta-probes\/probe-a\/prometheus-client\.crt/);
  assert.match(scrape, /key_file: \/run\/secrets\/managed-beta-probes\/probe-b\/prometheus-client\.key/);
  assert.doesNotMatch(scrape, /honor_labels: true|http:\/\/|insecure_skip_verify|bearer_token:/);
});

test("correlated failure domains and shared authorities fail closed", () => {
  for (const field of FAILURE_DOMAIN_FIELDS) {
    const inventory = example();
    inventory.locations[1].failureDomains[field] = inventory.locations[0].failureDomains[field];
    assert.throws(
      () => validateProbeFleet(inventory, { allowExample: true }),
      new RegExp(`${field} must be distinct`),
      field,
    );
  }
  for (const [field, expected] of [
    ["stateRoot", /state root must be unique/],
    ["textfileRoot", /textfile root must be unique/],
    ["bearerFile", /bearer file must be unique/],
    ["metricsTarget", /metrics target must be unique/],
  ]) {
    const inventory = example();
    inventory.locations[1][field] = inventory.locations[0][field];
    if (field === "metricsTarget") inventory.locations[1].metricsServerName = inventory.locations[0].metricsServerName;
    assert.throws(() => validateProbeFleet(inventory, { allowExample: true }), expected, field);
  }
});

test("mutable images, plaintext/IP/query endpoints, unsupported operations, and unsafe users are rejected", () => {
  const mutable = example();
  mutable.image = "ghcr.io/fiducia-cloud/fiducia-managed-beta-probe:latest";
  assert.throws(() => validateProbeFleet(mutable, { allowExample: true }), /inventory\.image must equal/);

  const plaintext = example();
  plaintext.locations[0].operations[0].endpoint = "http://managed-beta.example.invalid/healthz";
  assert.throws(() => validateProbeFleet(plaintext, { allowExample: true }), /must use HTTPS/);

  const ip = example();
  ip.locations[0].operations[0].endpoint = "https://127.0.0.1/healthz";
  assert.throws(() => validateProbeFleet(ip, { allowExample: true }), /reviewed DNS hostname/);

  const query = example();
  query.locations[0].operations[0].endpoint = "https://managed-beta.example.invalid/healthz?key=secret";
  assert.throws(() => validateProbeFleet(query, { allowExample: true }), /query parameters/);

  const operation = example();
  operation.locations[0].operations[0].operationClass = "tenant_specific_check";
  assert.throws(() => validateProbeFleet(operation, { allowExample: true }), /unsupported|must exactly equal/);

  const rootUser = example();
  rootUser.locations[0].runtimeUser = "root";
  assert.throws(() => validateProbeFleet(rootUser, { allowExample: true }), /non-root account/);
});

test("credential-like values and direct secret fields are rejected recursively", () => {
  const secretField = example();
  secretField.locations[0].bearerToken = "redacted";
  assert.throws(() => validateProbeFleet(secretField, { allowExample: true }), /prohibited secret-value field|not allowed/);

  const token = example();
  token.locations[0].operations[0].endpoint = `https://ghp_${"A".repeat(40)}@managed-beta.example.invalid/healthz`;
  assert.throws(() => validateProbeFleet(token, { allowExample: true }), /credential-like value/);
});

test("live inventories reject example targets and cannot render inside the Git checkout", async () => {
  const stillExample = example();
  stillExample.evidenceMode = "live";
  assert.throws(() => validateProbeFleet(stillExample), /example\.invalid/);

  const live = makeLive();
  assert.doesNotThrow(() => validateProbeFleet(live));
  await assert.rejects(
    () => writeProbeHostFleet(live, path.join(root, ".generated-live-probes")),
    /outside the Git checkout/,
  );
});

test("written bundles are deterministic, private where needed, and explicit about non-claims", async () => {
  const first = await fsp.mkdtemp(path.join(os.tmpdir(), "fiducia-probe-hosts-a-"));
  const second = await fsp.mkdtemp(path.join(os.tmpdir(), "fiducia-probe-hosts-b-"));
  try {
    const left = await writeProbeHostFleet(example(), first, { allowExample: true });
    const right = await writeProbeHostFleet(example(), second, { allowExample: true });
    assert.deepEqual(left.files, right.files);
    assert.deepEqual(left.manifest, right.manifest);
    const env = path.join(first, "locations", "probe-a", "env", "health.env");
    const unit = path.join(first, "locations", "probe-a", "systemd", "fiducia-managed-beta-probe-probe-a-health.service");
    assert.equal(fs.statSync(env).mode & 0o777, 0o600);
    assert.equal(fs.statSync(unit).mode & 0o777, 0o644);
    assert.ok(left.manifest.nonClaims.some((claim) => claim.includes("do not prove")));
    assert.ok(left.manifest.nonClaims.some((claim) => claim.includes("DEN-1619 remains open")));
  } finally {
    await fsp.rm(first, { recursive: true, force: true });
    await fsp.rm(second, { recursive: true, force: true });
  }
});
