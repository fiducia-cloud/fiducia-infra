#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const defaultContractPath = path.join(root, "bootstrap", "fiducia-secret-contract.json");
const PROOF_RE = /^[a-z0-9][a-z0-9._:/-]{7,255}$/i;
const SECRET_FIELD_RE = /^(?:value|rawValue|secretValue|password|privateKey|apiKey|bearerToken|credential|credentialValue)$/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bghp_[A-Za-z0-9]+\b/,
  /\bgithub_pat_[A-Za-z0-9_]+\b/,
  /\btskey-(?:auth|client)-[A-Za-z0-9_-]+\b/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/i,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
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

function exactSet(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(new Set(actual).size === actual.length, `${label} contains duplicates`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(JSON.stringify(left) === JSON.stringify(right), `${label} must exactly equal [${right.join(", ")}]`);
}

function integer(value, label, minimum = 0) {
  assert(Number.isSafeInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`);
  return value;
}

function timestamp(value, label) {
  assert(typeof value === "string", `${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  assert(!Number.isNaN(parsed.getTime()), `${label} must be an ISO timestamp`);
  return parsed;
}

function proof(value, label, evidenceMode) {
  assert(typeof value === "string" && PROOF_RE.test(value), `${label} must be an opaque proof identifier`);
  if (evidenceMode === "live") assert(!/^example(?:-|:|$)/i.test(value), `${label} cannot use example proof data in live mode`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function scanSecrets(value, location = "evidence") {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      assert(!pattern.test(value), `${location} contains a prohibited credential or private-key pattern`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assert(!SECRET_FIELD_RE.test(key), `${location}.${key} is a prohibited secret-value field`);
      scanSecrets(entry, `${location}.${key}`);
    }
  }
}

export function loadBootstrapSecretContract(file = defaultContractPath) {
  assert(fs.existsSync(file), `missing bootstrap secret contract: ${file}`);
  const contract = JSON.parse(fs.readFileSync(file, "utf8"));
  exactKeys(
    contract,
    [
      "schemaVersion",
      "contractId",
      "clusters",
      "cloudRecoveryStore",
      "dynamicFiduciaStore",
      "maximumObservationAgeMinutes",
      "maximumExternalSecretRefreshAgeMinutes",
      "maximumRotationAgeDays",
      "requiredReaderScopes",
      "minimumByteLengths",
      "noWhitespaceProperties",
      "stores",
      "cloudObjects",
    ],
    [],
    "contract",
  );
  assert(contract.schemaVersion === 1, "contract.schemaVersion must equal 1");
  assert(typeof contract.contractId === "string" && /^[a-z0-9][a-z0-9-]{7,95}$/.test(contract.contractId), "contract.contractId is invalid");
  exactSet(contract.clusters, ["laptop-aws-sim", "laptop-gcp-sim", "laptop-azure-sim"], "contract.clusters");
  exactSet(contract.stores, [contract.cloudRecoveryStore, contract.dynamicFiduciaStore], "contract.stores");
  integer(contract.maximumObservationAgeMinutes, "contract.maximumObservationAgeMinutes", 1);
  integer(contract.maximumExternalSecretRefreshAgeMinutes, "contract.maximumExternalSecretRefreshAgeMinutes", 1);
  integer(contract.maximumRotationAgeDays, "contract.maximumRotationAgeDays", 1);
  exactSet(contract.requiredReaderScopes, ["kv:read"], "contract.requiredReaderScopes");
  assert(isObject(contract.minimumByteLengths), "contract.minimumByteLengths must be an object");
  for (const [property, minimum] of Object.entries(contract.minimumByteLengths)) integer(minimum, `contract.minimumByteLengths.${property}`, 32);
  exactSet(contract.noWhitespaceProperties, Object.keys(contract.minimumByteLengths), "contract.noWhitespaceProperties");
  assert(Array.isArray(contract.cloudObjects) && contract.cloudObjects.length === 6, "contract.cloudObjects must contain six objects");
  assert(new Set(contract.cloudObjects.map((entry) => entry.name)).size === 6, "contract.cloudObjects contains duplicate names");
  assert(new Set(contract.cloudObjects.map((entry) => entry.trustDomain)).size === 6, "contract trust domains must be unique");
  for (const [index, object] of contract.cloudObjects.entries()) {
    exactKeys(
      object,
      ["name", "trustDomain", "namespace", "externalSecret", "targetSecret", "properties"],
      ["dedicatedOrganizationRequired", "scopeProperty", "fullHistoricalKeySetRequired"],
      `contract.cloudObjects[${index}]`,
    );
    assert(typeof object.name === "string" && object.name.startsWith("dd/remote-dev/"), `contract.cloudObjects[${index}].name is invalid`);
    assert(typeof object.namespace === "string" && object.namespace.trim(), `contract.cloudObjects[${index}].namespace is required`);
    assert(typeof object.externalSecret === "string" && object.externalSecret.trim(), `contract.cloudObjects[${index}].externalSecret is required`);
    assert(typeof object.targetSecret === "string" && object.targetSecret.trim(), `contract.cloudObjects[${index}].targetSecret is required`);
    assert(isObject(object.properties) && Object.keys(object.properties).length >= 1, `contract.cloudObjects[${index}].properties must be non-empty`);
    assert(new Set(Object.values(object.properties)).size === Object.keys(object.properties).length, `contract.cloudObjects[${index}] target keys contain duplicates`);
  }
  return contract;
}

function expectedExternalSecretPaths(contract) {
  return contract.cloudObjects.map((object) => `${object.namespace}/${object.externalSecret}`);
}

function expectedTargetKeysByPath(contract) {
  return Object.fromEntries(
    contract.cloudObjects.map((object) => [
      `${object.namespace}/${object.targetSecret}`,
      Object.values(object.properties).sort(),
    ]),
  );
}

function objectByName(contract) {
  return new Map(contract.cloudObjects.map((object) => [object.name, object]));
}

function validateCloudObjects(evidence, contract, observedAt) {
  exactKeys(evidence.cloudObjects, contract.cloudObjects.map((entry) => entry.name), [], "cloudObjects");
  const contractByName = objectByName(contract);
  const independenceProofs = [];

  for (const [name, actual] of Object.entries(evidence.cloudObjects)) {
    const expected = contractByName.get(name);
    const label = `cloudObjects.${name}`;
    exactKeys(
      actual,
      [
        "exists",
        "propertyNames",
        "lastRotatedAt",
        "rotationOwner",
        "emergencyRecoveryOwner",
        "independenceProofId",
        "existenceProofId",
        "valueChecks",
      ],
      [
        "dedicatedOrganization",
        "organizationProofId",
        "scopes",
        "fullHistoricalKeySetRetained",
        "activeKeyIdPresent",
        "keyCount",
      ],
      label,
    );
    assert(actual.exists === true, `${label}.exists must be true`);
    exactSet(actual.propertyNames, Object.keys(expected.properties), `${label}.propertyNames`);
    const rotatedAt = timestamp(actual.lastRotatedAt, `${label}.lastRotatedAt`);
    assert(rotatedAt <= observedAt, `${label}.lastRotatedAt cannot be in the future`);
    assert((observedAt - rotatedAt) / 86_400_000 <= contract.maximumRotationAgeDays, `${label} rotation is older than policy`);
    assert(typeof actual.rotationOwner === "string" && actual.rotationOwner.trim().length >= 3, `${label}.rotationOwner is required`);
    assert(typeof actual.emergencyRecoveryOwner === "string" && actual.emergencyRecoveryOwner.trim().length >= 3, `${label}.emergencyRecoveryOwner is required`);
    independenceProofs.push(proof(actual.independenceProofId, `${label}.independenceProofId`, evidence.evidenceMode));
    proof(actual.existenceProofId, `${label}.existenceProofId`, evidence.evidenceMode);

    const requiredValueChecks = Object.keys(expected.properties).filter((property) => Object.hasOwn(contract.minimumByteLengths, property));
    exactKeys(actual.valueChecks, requiredValueChecks, [], `${label}.valueChecks`);
    for (const property of requiredValueChecks) {
      const check = actual.valueChecks[property];
      exactKeys(check, ["byteLength", "containsWhitespace", "validationProofId"], [], `${label}.valueChecks.${property}`);
      integer(check.byteLength, `${label}.valueChecks.${property}.byteLength`, contract.minimumByteLengths[property]);
      assert(check.containsWhitespace === false, `${label}.valueChecks.${property}.containsWhitespace must be false`);
      proof(check.validationProofId, `${label}.valueChecks.${property}.validationProofId`, evidence.evidenceMode);
    }

    if (expected.dedicatedOrganizationRequired) {
      assert(actual.dedicatedOrganization === true, `${label}.dedicatedOrganization must be true`);
      exactSet(actual.scopes, contract.requiredReaderScopes, `${label}.scopes`);
      proof(actual.organizationProofId, `${label}.organizationProofId`, evidence.evidenceMode);
    }
    if (expected.fullHistoricalKeySetRequired) {
      assert(actual.fullHistoricalKeySetRetained === true, `${label}.fullHistoricalKeySetRetained must be true`);
      assert(actual.activeKeyIdPresent === true, `${label}.activeKeyIdPresent must be true`);
      integer(actual.keyCount, `${label}.keyCount`, 1);
    }
  }
  assert(new Set(independenceProofs).size === independenceProofs.length, "unrelated trust domains must have distinct independence proofs");
}

function validateClusterReadiness(evidence, contract, observedAt) {
  exactKeys(evidence.clusterReadiness, contract.clusters, [], "clusterReadiness");
  const externalSecretPaths = expectedExternalSecretPaths(contract);
  const targetKeys = expectedTargetKeysByPath(contract);

  for (const clusterName of contract.clusters) {
    const cluster = evidence.clusterReadiness[clusterName];
    const label = `clusterReadiness.${clusterName}`;
    exactKeys(
      cluster,
      [
        "readyStores",
        "storeProofId",
        "readyExternalSecrets",
        "refreshTimes",
        "materializedSecrets",
        "externalSecretProofId",
        "secretMetadataProofId",
      ],
      [],
      label,
    );
    exactSet(cluster.readyStores, contract.stores, `${label}.readyStores`);
    proof(cluster.storeProofId, `${label}.storeProofId`, evidence.evidenceMode);
    exactSet(cluster.readyExternalSecrets, externalSecretPaths, `${label}.readyExternalSecrets`);
    proof(cluster.externalSecretProofId, `${label}.externalSecretProofId`, evidence.evidenceMode);
    proof(cluster.secretMetadataProofId, `${label}.secretMetadataProofId`, evidence.evidenceMode);
    exactKeys(cluster.refreshTimes, externalSecretPaths, [], `${label}.refreshTimes`);
    for (const externalSecret of externalSecretPaths) {
      const refreshedAt = timestamp(cluster.refreshTimes[externalSecret], `${label}.refreshTimes.${externalSecret}`);
      assert(refreshedAt <= observedAt, `${label}.refreshTimes.${externalSecret} cannot be in the future`);
      assert(
        (observedAt - refreshedAt) / 60_000 <= contract.maximumExternalSecretRefreshAgeMinutes,
        `${label}.refreshTimes.${externalSecret} is stale`,
      );
    }
    exactKeys(cluster.materializedSecrets, Object.keys(targetKeys), [], `${label}.materializedSecrets`);
    for (const [secretPath, expectedKeys] of Object.entries(targetKeys)) {
      exactSet(cluster.materializedSecrets[secretPath], expectedKeys, `${label}.materializedSecrets.${secretPath}`);
    }
  }
}

function validateApprovals(evidence, observedAt) {
  exactKeys(evidence.approvals, ["operator", "reviewer"], [], "approvals");
  for (const role of ["operator", "reviewer"]) {
    exactKeys(evidence.approvals[role], ["identity", "approvedAt"], [], `approvals.${role}`);
    assert(typeof evidence.approvals[role].identity === "string" && evidence.approvals[role].identity.trim().length >= 3, `approvals.${role}.identity is required`);
    const approvedAt = timestamp(evidence.approvals[role].approvedAt, `approvals.${role}.approvedAt`);
    assert(approvedAt >= observedAt, `approvals.${role}.approvedAt must be after observation`);
  }
  assert(evidence.approvals.operator.identity !== evidence.approvals.reviewer.identity, "operator and reviewer must be distinct identities");
}

export function validateBootstrapSecretReadiness(evidence, contract, { allowExample = false, now = new Date() } = {}) {
  assert(isObject(evidence), "evidence must be an object");
  scanSecrets(evidence);
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "evidenceMode",
      "contractId",
      "observedAt",
      "environment",
      "cloudObjects",
      "clusterReadiness",
      "findings",
      "approvals",
    ],
    [],
    "evidence",
  );
  assert(evidence.schemaVersion === 1, "evidence.schemaVersion must equal 1");
  assert(["example", "live"].includes(evidence.evidenceMode), "evidence.evidenceMode must be example or live");
  if (evidence.evidenceMode === "example" && !allowExample) fail("example bootstrap evidence requires --allow-example");
  assert(evidence.contractId === contract.contractId, "evidence.contractId does not match contract");
  assert(evidence.environment === "remote-dev", "evidence.environment must equal remote-dev");
  const observedAt = timestamp(evidence.observedAt, "evidence.observedAt");
  assert(observedAt <= now, "evidence.observedAt cannot be in the future");
  if (evidence.evidenceMode === "live") {
    assert((now - observedAt) / 60_000 <= contract.maximumObservationAgeMinutes, "live bootstrap evidence is stale");
  }

  validateCloudObjects(evidence, contract, observedAt);
  validateClusterReadiness(evidence, contract, observedAt);

  assert(Array.isArray(evidence.findings), "evidence.findings must be an array");
  const unresolvedCritical = evidence.findings.filter((finding) => finding?.severity === "critical" && finding?.resolved !== true);
  assert(unresolvedCritical.length === 0, "evidence.findings contains unresolved critical issues");
  validateApprovals(evidence, observedAt);

  const propertyCount = contract.cloudObjects.reduce((sum, object) => sum + Object.keys(object.properties).length, 0);
  return {
    schemaVersion: 1,
    contractId: contract.contractId,
    evidenceMode: evidence.evidenceMode,
    evidenceFingerprint: digest(evidence),
    contractFingerprint: digest(contract),
    productionApproval: evidence.evidenceMode === "live",
    decision: evidence.evidenceMode === "live" ? "eligible-bootstrap-ready" : "example-only",
    cloudObjectCount: contract.cloudObjects.length,
    cloudPropertyCount: propertyCount,
    clusterCount: contract.clusters.length,
    storeCountPerCluster: contract.stores.length,
    externalSecretCountPerCluster: contract.cloudObjects.length,
    materializedSecretCountPerCluster: contract.cloudObjects.length,
    requiredReaderScopes: contract.requiredReaderScopes,
    warnings: evidence.evidenceMode === "example"
      ? ["Example evidence validates structure only and cannot approve bootstrap readiness."]
      : [],
  };
}

function usage() {
  return "usage: node tools/validate-fiducia-bootstrap-secret-readiness.mjs --evidence <json> [--contract <json>] [--allow-example] [--now <iso>]";
}

function parseArgs(argv) {
  const args = { contract: defaultContractPath, evidence: null, allowExample: false, now: new Date() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--contract") args.contract = path.resolve(argv[++index] ?? "");
    else if (arg === "--evidence") args.evidence = path.resolve(argv[++index] ?? "");
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
    assert(args.evidence && fs.existsSync(args.evidence), `--evidence must name an existing JSON file\n${usage()}`);
    const contract = loadBootstrapSecretContract(args.contract);
    const evidence = JSON.parse(fs.readFileSync(args.evidence, "utf8"));
    const report = validateBootstrapSecretReadiness(evidence, contract, {
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
