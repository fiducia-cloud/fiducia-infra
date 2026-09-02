import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  loadBootstrapSecretContract,
  validateBootstrapSecretReadiness,
} from "./validate-fiducia-bootstrap-secret-readiness.mjs";

const contract = loadBootstrapSecretContract();
const examplePath = new URL("../bootstrap/fiducia-secret-readiness.example.json", import.meta.url);
const example = () => JSON.parse(fs.readFileSync(examplePath, "utf8"));
const fixedNow = new Date("2026-08-03T20:30:00Z");

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function replaceExampleProofs(value) {
  if (Array.isArray(value)) return value.map(replaceExampleProofs);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceExampleProofs(child)]));
  }
  if (typeof value === "string" && /^example-(?:independence|existence|validation|dedicated|laptop|proof)/.test(value)) {
    return value.replace(/^example-/, "live-");
  }
  return value;
}

function makeLive() {
  const value = replaceExampleProofs(example());
  value.evidenceMode = "live";
  return value;
}

function externalSecretPath(object) {
  return `${object.namespace}/${object.externalSecret}`;
}

function targetSecretPath(object) {
  return `${object.namespace}/${object.targetSecret}`;
}

test("contract enumerates exactly six independent cloud objects and twenty required properties", () => {
  assert.equal(contract.cloudObjects.length, 6);
  assert.equal(new Set(contract.cloudObjects.map((entry) => entry.trustDomain)).size, 6);
  assert.equal(
    contract.cloudObjects.reduce((sum, entry) => sum + Object.keys(entry.properties).length, 0),
    20,
  );
  assert.deepEqual(contract.requiredReaderScopes, ["kv:read"]);
  assert.deepEqual(contract.minimumByteLengths, {
    FIDUCIA_KEY_IDEMPOTENCY_SECRET: 32,
    CUSTOMER_API_KEY_PEPPER: 32,
  });
  assert.deepEqual(
    [...contract.cloudObjects.map((entry) => entry.name)].sort(),
    [
      "dd/remote-dev/fiducia-admin-secrets",
      "dd/remote-dev/fiducia-auth-secrets",
      "dd/remote-dev/fiducia-backend-secrets",
      "dd/remote-dev/fiducia-cluster-secrets",
      "dd/remote-dev/fiducia-eso-reader",
      "dd/remote-dev/fiducia-kv-protection",
    ],
  );
});

test("ExternalSecret contract is exact, enumerated, retained, and never bulk-extracts", () => {
  const manifest = read("contracts/external-secrets/fiducia-bootstrap.externalsecret.yaml");
  const documents = manifest.split(/^---$/m).map((document) => document.trim()).filter(Boolean);
  assert.equal(documents.length, 6);
  assert.doesNotMatch(manifest, /\bdataFrom:/);
  assert.doesNotMatch(manifest, /kind: Secret\b/);
  assert.doesNotMatch(manifest, /stringData:|\bdata:\s*\{?\s*[A-Za-z0-9+/=]{16,}/);

  for (const object of contract.cloudObjects) {
    const document = documents.find((candidate) =>
      candidate.includes(`name: ${object.externalSecret}`)
      && candidate.includes(`namespace: ${object.namespace}`)
    );
    assert.ok(document, `missing ExternalSecret ${externalSecretPath(object)}`);
    assert.match(document, /apiVersion: external-secrets\.io\/v1/);
    assert.match(document, /kind: ExternalSecret/);
    assert.match(document, /refreshInterval: 15m/);
    assert.match(document, /kind: ClusterSecretStore[\s\S]*name: dd-cluster-secrets/);
    assert.ok(document.includes(`name: ${object.targetSecret}`));
    assert.match(document, /creationPolicy: Owner/);
    assert.match(document, /deletionPolicy: Retain/);
    assert.ok(document.includes(`key: ${object.name}`));
    for (const [property, secretKey] of Object.entries(object.properties)) {
      assert.ok(document.includes(`secretKey: ${secretKey}`), `missing target key ${targetSecretPath(object)}/${secretKey}`);
      assert.ok(document.includes(`property: ${property}`), `missing cloud property ${object.name}/${property}`);
    }
  }
});

test("example evidence validates structure only and cannot approve bootstrap readiness", () => {
  assert.throws(
    () => validateBootstrapSecretReadiness(example(), contract, { now: fixedNow }),
    /requires --allow-example/,
  );
  const report = validateBootstrapSecretReadiness(example(), contract, {
    allowExample: true,
    now: fixedNow,
  });
  assert.equal(report.productionApproval, false);
  assert.equal(report.decision, "example-only");
  assert.equal(report.cloudObjectCount, 6);
  assert.equal(report.cloudPropertyCount, 20);
  assert.equal(report.clusterCount, 3);
  assert.equal(report.externalSecretCountPerCluster, 6);
  assert.match(report.evidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(report.warnings.join("\n"), /cannot approve bootstrap readiness/i);
});

test("complete fresh live evidence is eligible for bootstrap readiness", () => {
  const report = validateBootstrapSecretReadiness(makeLive(), contract, { now: fixedNow });
  assert.equal(report.productionApproval, true);
  assert.equal(report.decision, "eligible-bootstrap-ready");
  assert.deepEqual(report.requiredReaderScopes, ["kv:read"]);
});

test("reader must use a dedicated organization and exactly kv:read", () => {
  const readerName = "dd/remote-dev/fiducia-eso-reader";
  const sharedOrg = makeLive();
  sharedOrg.cloudObjects[readerName].dedicatedOrganization = false;
  assert.throws(
    () => validateBootstrapSecretReadiness(sharedOrg, contract, { now: fixedNow }),
    /dedicatedOrganization must be true/,
  );

  const broadScope = makeLive();
  broadScope.cloudObjects[readerName].scopes.push("kv:write");
  assert.throws(
    () => validateBootstrapSecretReadiness(broadScope, contract, { now: fixedNow }),
    /scopes must exactly equal/,
  );
});

test("pepper and idempotency secret shape checks require at least 32 bytes and no whitespace", () => {
  const authName = "dd/remote-dev/fiducia-auth-secrets";
  for (const property of ["CUSTOMER_API_KEY_PEPPER", "FIDUCIA_KEY_IDEMPOTENCY_SECRET"]) {
    const tooShort = makeLive();
    tooShort.cloudObjects[authName].valueChecks[property].byteLength = 31;
    assert.throws(
      () => validateBootstrapSecretReadiness(tooShort, contract, { now: fixedNow }),
      new RegExp(`${property}\\.byteLength`),
    );

    const whitespace = makeLive();
    whitespace.cloudObjects[authName].valueChecks[property].containsWhitespace = true;
    assert.throws(
      () => validateBootstrapSecretReadiness(whitespace, contract, { now: fixedNow }),
      new RegExp(`${property}\\.containsWhitespace`),
    );
  }
});

test("KV protection retains the active and historical decryption-key set", () => {
  const name = "dd/remote-dev/fiducia-kv-protection";
  const missingHistory = makeLive();
  missingHistory.cloudObjects[name].fullHistoricalKeySetRetained = false;
  assert.throws(
    () => validateBootstrapSecretReadiness(missingHistory, contract, { now: fixedNow }),
    /fullHistoricalKeySetRetained must be true/,
  );

  const missingActive = makeLive();
  missingActive.cloudObjects[name].activeKeyIdPresent = false;
  assert.throws(
    () => validateBootstrapSecretReadiness(missingActive, contract, { now: fixedNow }),
    /activeKeyIdPresent must be true/,
  );

  const empty = makeLive();
  empty.cloudObjects[name].keyCount = 0;
  assert.throws(
    () => validateBootstrapSecretReadiness(empty, contract, { now: fixedNow }),
    /keyCount must be an integer >= 1/,
  );
});

test("all cloud object properties, rotations, owners, and trust-domain proofs are exact", () => {
  const objectName = "dd/remote-dev/fiducia-cluster-secrets";
  const missingProperty = makeLive();
  missingProperty.cloudObjects[objectName].propertyNames.pop();
  assert.throws(
    () => validateBootstrapSecretReadiness(missingProperty, contract, { now: fixedNow }),
    /propertyNames must exactly equal/,
  );

  const staleRotation = makeLive();
  staleRotation.cloudObjects[objectName].lastRotatedAt = "2025-01-01T00:00:00Z";
  assert.throws(
    () => validateBootstrapSecretReadiness(staleRotation, contract, { now: fixedNow }),
    /rotation is older than policy/,
  );

  const missingOwner = makeLive();
  missingOwner.cloudObjects[objectName].rotationOwner = "";
  assert.throws(
    () => validateBootstrapSecretReadiness(missingOwner, contract, { now: fixedNow }),
    /rotationOwner is required/,
  );

  const duplicateProof = makeLive();
  duplicateProof.cloudObjects["dd/remote-dev/fiducia-admin-secrets"].independenceProofId =
    duplicateProof.cloudObjects["dd/remote-dev/fiducia-backend-secrets"].independenceProofId;
  assert.throws(
    () => validateBootstrapSecretReadiness(duplicateProof, contract, { now: fixedNow }),
    /distinct independence proofs/,
  );
});

test("every cluster requires both stores, all six Ready ExternalSecrets, fresh refreshes, and exact target key names", () => {
  const cluster = contract.clusters[0];
  const missingStore = makeLive();
  missingStore.clusterReadiness[cluster].readyStores.pop();
  assert.throws(
    () => validateBootstrapSecretReadiness(missingStore, contract, { now: fixedNow }),
    /readyStores must exactly equal/,
  );

  const missingExternalSecret = makeLive();
  missingExternalSecret.clusterReadiness[cluster].readyExternalSecrets.pop();
  assert.throws(
    () => validateBootstrapSecretReadiness(missingExternalSecret, contract, { now: fixedNow }),
    /readyExternalSecrets must exactly equal/,
  );

  const staleRefresh = makeLive();
  staleRefresh.clusterReadiness[cluster].refreshTimes[externalSecretPath(contract.cloudObjects[0])] = "2026-08-03T18:00:00Z";
  assert.throws(
    () => validateBootstrapSecretReadiness(staleRefresh, contract, { now: fixedNow }),
    /is stale/,
  );

  const wrongKey = makeLive();
  wrongKey.clusterReadiness[cluster].materializedSecrets[targetSecretPath(contract.cloudObjects[3])].pop();
  assert.throws(
    () => validateBootstrapSecretReadiness(wrongKey, contract, { now: fixedNow }),
    /materializedSecrets.*must exactly equal/,
  );
});

test("stale, placeholder, self-approved, critical, and secret-bearing live evidence fails closed", () => {
  const stale = makeLive();
  stale.observedAt = "2026-08-03T20:00:00Z";
  assert.throws(
    () => validateBootstrapSecretReadiness(stale, contract, { now: new Date("2026-08-03T22:00:00Z") }),
    /stale/,
  );

  const placeholder = makeLive();
  placeholder.cloudObjects[contract.cloudObjects[0].name].existenceProofId = "example-not-live";
  assert.throws(
    () => validateBootstrapSecretReadiness(placeholder, contract, { now: fixedNow }),
    /cannot use example proof/,
  );

  const selfApproved = makeLive();
  selfApproved.approvals.reviewer.identity = selfApproved.approvals.operator.identity;
  assert.throws(
    () => validateBootstrapSecretReadiness(selfApproved, contract, { now: fixedNow }),
    /must be distinct/,
  );

  const critical = makeLive();
  critical.findings.push({ id: "missing-cloud-object", severity: "critical", resolved: false });
  assert.throws(
    () => validateBootstrapSecretReadiness(critical, contract, { now: fixedNow }),
    /unresolved critical/,
  );

  const secretField = makeLive();
  secretField.rawValue = "redacted";
  assert.throws(
    () => validateBootstrapSecretReadiness(secretField, contract, { now: fixedNow }),
    /prohibited secret-value field/,
  );

  const privateKey = makeLive();
  privateKey.findings.push({
    id: "bad-attachment",
    severity: "low",
    resolved: true,
    note: ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
  });
  assert.throws(
    () => validateBootstrapSecretReadiness(privateKey, contract, { now: fixedNow }),
    /private-key pattern/,
  );
});

test("capture script reads metadata and Secret key names only and cannot approve production", () => {
  const script = read("scripts/capture-fiducia-bootstrap-readiness.sh");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /umask 077/);
  assert.match(script, /fiducia\.cloud\/cluster=\$cluster/);
  assert.match(script, /get clustersecretstores\.external-secrets\.io/);
  assert.match(script, /get externalsecrets\.external-secrets\.io/);
  assert.match(script, /-o go-template='\{\{range \$key, \$_ := \.data\}\}/);
  assert.match(script, /secretKeyNamesOnly: true/);
  assert.match(script, /captureOnly: true/);
  assert.match(script, /productionApproval: false/);
  assert.match(script, /install -m 600/);
  assert.doesNotMatch(script, /get secret[^\n]*-o (?:json|yaml)/i);
  assert.doesNotMatch(script, /jsonpath='\{\.data\}'|\.data\.[A-Za-z0-9_-]+/);
  assert.doesNotMatch(script, /\bkubectl\b[^\n]*(?:apply|patch|delete|replace|scale|rollout|cordon|drain)\b/);
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b|set -x|set -o xtrace/);
});

test("tracked bootstrap files contain no private key or provider credential pattern", () => {
  const content = [
    read("bootstrap/fiducia-secret-contract.json"),
    read("bootstrap/fiducia-secret-readiness.example.json"),
    read("contracts/external-secrets/fiducia-bootstrap.externalsecret.yaml"),
    read("scripts/capture-fiducia-bootstrap-readiness.sh"),
  ].join("\n");
  assert.doesNotMatch(content, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.doesNotMatch(content, /ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|tskey-(?:auth|client)-[A-Za-z0-9_-]+/);
});

test("identical live evidence produces a deterministic readiness report", () => {
  const first = validateBootstrapSecretReadiness(makeLive(), contract, { now: fixedNow });
  const second = validateBootstrapSecretReadiness(makeLive(), contract, { now: fixedNow });
  assert.deepEqual(first, second);
  assert.match(first.contractFingerprint, /^[a-f0-9]{64}$/);
});
