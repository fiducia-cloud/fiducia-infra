#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseToml } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const defaultPolicyPath = path.join(root, "acceptance", "laptop-fleet-campaign.toml");
const SHA_RE = /^[0-9a-f]{40}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
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

function splitList(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty comma-separated string`);
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (new Set(items).size !== items.length) fail(`${field} contains duplicates`);
  return items;
}

function exactSet(actual, expected, field) {
  if (!Array.isArray(actual)) fail(`${field} must be an array`);
  const set = new Set(actual);
  if (set.size !== actual.length) fail(`${field} contains duplicates`);
  const missing = expected.filter((item) => !set.has(item));
  const extra = [...set].filter((item) => !expected.includes(item));
  if (missing.length || extra.length) {
    fail(`${field} does not match policy; missing=[${missing.join(",")}], extra=[${extra.join(",")}]`);
  }
}

function integer(value, field, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) fail(`${field} must be an integer >= ${minimum}`);
  return value;
}

function timestamp(value, field) {
  if (typeof value !== "string") fail(`${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(`${field} must be an ISO timestamp`);
  return parsed;
}

function stringProof(value, field, evidenceMode) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must contain a proof identifier`);
  if (evidenceMode === "live" && /^example(?:-|$)/i.test(value.trim())) {
    fail(`${field} cannot use example proof data in live evidence`);
  }
  return value.trim();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function scanSecrets(value, location = "evidence") {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) fail(`${location} contains a prohibited credential or private-key pattern`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:password|token|privateKey|secretValue|clientSecret)$/i.test(key)) {
        fail(`${location}.${key} is a prohibited secret-bearing field`);
      }
      scanSecrets(entry, `${location}.${key}`);
    }
  }
}

export function loadAcceptancePolicy(file = defaultPolicyPath) {
  if (!fs.existsSync(file)) fail(`missing acceptance policy: ${file}`);
  const raw = parseToml(fs.readFileSync(file, "utf8"));
  const policy = {
    ...raw,
    clusters: splitList(raw.clusters, "clusters"),
    requiredScenarios: splitList(raw.required_scenarios, "required_scenarios"),
    requiredRestoreProofs: splitList(raw.required_restore_proofs, "required_restore_proofs"),
    requiredAlerts: splitList(raw.required_alerts, "required_alerts"),
    requiredRevocations: splitList(raw.required_revocations, "required_revocations"),
  };
  if (typeof policy.campaign_id !== "string" || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(policy.campaign_id)) {
    fail("campaign_id must be a lowercase DNS-like identifier");
  }
  for (const field of [
    "minimum_soak_hours",
    "minimum_soak_samples",
    "maximum_sample_gap_minutes",
    "maximum_observation_age_hours",
    "maximum_public_failover_rto_seconds",
    "maximum_member_rebuild_rto_seconds",
    "maximum_fleet_restore_rto_seconds",
    "maximum_critical_rpo_seconds",
    "maximum_acknowledged_message_loss",
    "maximum_duplicate_protected_mutations",
    "maximum_unresolved_critical_findings",
    "minimum_external_probe_regions",
  ]) integer(policy[field], field, 0);
  if (policy.minimum_soak_hours < 168) fail("minimum_soak_hours cannot be less than seven days");
  if (policy.clusters.length !== 3) fail("the acceptance policy requires exactly three laptop clusters");
  return policy;
}

function validateDomains(evidence, policy) {
  if (!evidence.failureDomains || typeof evidence.failureDomains !== "object") {
    fail("failureDomains is required");
  }
  exactSet(Object.keys(evidence.failureDomains), policy.clusters, "failureDomains keys");
  const values = { site: [], network: [], power: [] };
  for (const cluster of policy.clusters) {
    const domain = evidence.failureDomains[cluster];
    for (const field of ["site", "network", "power", "physicalAccessOwner"]) {
      if (typeof domain?.[field] !== "string" || !domain[field].trim()) {
        fail(`failureDomains.${cluster}.${field} is required`);
      }
    }
    values.site.push(domain.site);
    values.network.push(domain.network);
    values.power.push(domain.power);
  }
  const result = {
    distinctSites: new Set(values.site).size === policy.clusters.length,
    distinctNetworks: new Set(values.network).size === policy.clusters.length,
    distinctPowerDomains: new Set(values.power).size === policy.clusters.length,
  };
  result.qualifiesForLimitedProduction =
    (!policy.require_distinct_sites_for_limited_production || result.distinctSites) &&
    (!policy.require_distinct_networks_for_limited_production || result.distinctNetworks) &&
    (!policy.require_distinct_power_domains_for_limited_production || result.distinctPowerDomains);
  return result;
}

function validateRequiredMap(map, keys, field, evidenceMode, scenario = false) {
  if (!map || typeof map !== "object") fail(`${field} is required`);
  exactSet(Object.keys(map), keys, `${field} keys`);
  for (const key of keys) {
    if (scenario) {
      if (map[key]?.passed !== true) fail(`${field}.${key}.passed must be true`);
      stringProof(map[key]?.proofId, `${field}.${key}.proofId`, evidenceMode);
    } else {
      stringProof(map[key], `${field}.${key}`, evidenceMode);
    }
  }
}

function validateMeasurements(evidence, policy) {
  const m = evidence.measurements;
  if (!m || typeof m !== "object") fail("measurements is required");
  const limits = [
    ["publicFailoverRtoSeconds", "maximum_public_failover_rto_seconds"],
    ["memberRebuildRtoSeconds", "maximum_member_rebuild_rto_seconds"],
    ["fleetRestoreRtoSeconds", "maximum_fleet_restore_rto_seconds"],
    ["criticalRpoSeconds", "maximum_critical_rpo_seconds"],
    ["acknowledgedMessageLoss", "maximum_acknowledged_message_loss"],
    ["duplicateProtectedMutations", "maximum_duplicate_protected_mutations"],
  ];
  for (const [field, policyField] of limits) {
    integer(m[field], `measurements.${field}`, 0);
    if (m[field] > policy[policyField]) {
      fail(`measurements.${field}=${m[field]} exceeds ${policyField}=${policy[policyField]}`);
    }
  }
  for (const field of [
    "maximumObservedCpuPercent",
    "maximumObservedMemoryPercent",
    "maximumObservedDiskPercent",
    "maximumObservedUploadPercent",
  ]) {
    integer(m[field], `measurements.${field}`, 0);
    if (m[field] > 100) fail(`measurements.${field} cannot exceed 100`);
  }
}

function validateSoak(evidence, policy, started, ended) {
  const soak = evidence.soak;
  if (!soak || typeof soak !== "object") fail("soak is required");
  integer(soak.durationHours, "soak.durationHours", 0);
  integer(soak.sampleCount, "soak.sampleCount", 0);
  integer(soak.maximumSampleGapMinutes, "soak.maximumSampleGapMinutes", 0);
  integer(soak.operatorInterventions, "soak.operatorInterventions", 0);
  if (soak.durationHours < policy.minimum_soak_hours) fail("soak duration is shorter than policy");
  if (soak.sampleCount < policy.minimum_soak_samples) fail("soak sample count is below policy");
  if (soak.maximumSampleGapMinutes > policy.maximum_sample_gap_minutes) fail("soak sample gap exceeds policy");
  if (soak.representativeTraffic !== true) fail("soak.representativeTraffic must be true");
  if (soak.boundedFaultInjection !== true) fail("soak.boundedFaultInjection must be true");
  if (!Array.isArray(soak.unresolvedCriticalFindings)) fail("soak.unresolvedCriticalFindings must be an array");
  if (soak.unresolvedCriticalFindings.length > policy.maximum_unresolved_critical_findings) {
    fail("soak contains unresolved critical findings");
  }
  const elapsedHours = (ended.getTime() - started.getTime()) / 3_600_000;
  if (elapsedHours < policy.minimum_soak_hours) fail("campaign timestamps cover less than seven days");
  if (Math.abs(elapsedHours - soak.durationHours) > 1) fail("soak.durationHours disagrees with campaign timestamps");
}

function validateApprovals(evidence, policy, ended) {
  const approvals = evidence.approvals;
  if (!approvals?.operator || !approvals?.reviewer) fail("operator and reviewer approvals are required");
  const operator = approvals.operator;
  const reviewer = approvals.reviewer;
  for (const [role, approval] of [["operator", operator], ["reviewer", reviewer]]) {
    if (typeof approval.identity !== "string" || !approval.identity.trim()) fail(`approvals.${role}.identity is required`);
    const approvedAt = timestamp(approval.approvedAt, `approvals.${role}.approvedAt`);
    if (approvedAt < ended) fail(`approvals.${role}.approvedAt must be after campaign end`);
  }
  if (policy.require_distinct_operator_and_reviewer && operator.identity === reviewer.identity) {
    fail("operator and reviewer must be distinct identities");
  }
}

export function validateAcceptanceEvidence(evidence, policy, { allowExample = false, now = new Date() } = {}) {
  if (!evidence || typeof evidence !== "object") fail("evidence must be a JSON object");
  scanSecrets(evidence);
  if (!new Set(["example", "live"]).has(evidence.evidenceMode)) fail("evidenceMode must be example or live");
  if (evidence.evidenceMode === "example" && !allowExample) {
    fail("example evidence is non-production and requires --allow-example");
  }
  if (evidence.campaignId !== policy.campaign_id) fail("campaignId does not match policy");
  if (!new Set(["limited-production", "beta-only"]).has(evidence.classificationRequested)) {
    fail("classificationRequested must be limited-production or beta-only");
  }
  if (!SHA_RE.test(evidence.gitRevision ?? "")) fail("gitRevision must be an exact 40-character Git SHA");
  if (!SHA_RE.test(evidence.rollbackRevision ?? "")) fail("rollbackRevision must be an exact 40-character Git SHA");
  if (!evidence.imageDigests || typeof evidence.imageDigests !== "object" || !Object.keys(evidence.imageDigests).length) {
    fail("imageDigests is required");
  }
  for (const [name, digest] of Object.entries(evidence.imageDigests)) {
    if (!DIGEST_RE.test(digest)) fail(`imageDigests.${name} must be an immutable sha256 digest`);
  }
  exactSet(evidence.clusters, policy.clusters, "clusters");

  const observedAt = timestamp(evidence.observedAt, "observedAt");
  const startedAt = timestamp(evidence.campaignStartedAt, "campaignStartedAt");
  const endedAt = timestamp(evidence.campaignEndedAt, "campaignEndedAt");
  if (endedAt <= startedAt) fail("campaignEndedAt must be after campaignStartedAt");
  if (observedAt < endedAt) fail("observedAt must not precede campaign end");
  if (observedAt.getTime() > now.getTime() + 60_000) fail("observedAt cannot be materially in the future");
  if (evidence.evidenceMode === "live") {
    const ageHours = (now.getTime() - observedAt.getTime()) / 3_600_000;
    if (ageHours > policy.maximum_observation_age_hours) fail("live evidence is stale; recapture final observations");
  }

  const domains = validateDomains(evidence, policy);
  if (evidence.classificationRequested === "limited-production" && !domains.qualifiesForLimitedProduction) {
    fail("correlated site, network, or power domains may request only beta-only classification");
  }

  if (!Array.isArray(evidence.externalProbeRegions)) fail("externalProbeRegions must be an array");
  if (new Set(evidence.externalProbeRegions).size < policy.minimum_external_probe_regions) {
    fail("insufficient independent external probe regions");
  }

  validateRequiredMap(evidence.scenarios, policy.requiredScenarios, "scenarios", evidence.evidenceMode, true);
  validateRequiredMap(evidence.restoreProofs, policy.requiredRestoreProofs, "restoreProofs", evidence.evidenceMode);
  validateRequiredMap(evidence.alertReceipts, policy.requiredAlerts, "alertReceipts", evidence.evidenceMode);
  validateRequiredMap(evidence.revocationProofs, policy.requiredRevocations, "revocationProofs", evidence.evidenceMode);
  validateMeasurements(evidence, policy);
  validateSoak(evidence, policy, startedAt, endedAt);

  if (!Array.isArray(evidence.findings)) fail("findings must be an array");
  const unresolvedCritical = evidence.findings.filter((finding) =>
    finding?.severity === "critical" && finding?.resolved !== true
  );
  if (unresolvedCritical.length > policy.maximum_unresolved_critical_findings) {
    fail("findings contains unresolved critical issues");
  }
  validateApprovals(evidence, policy, endedAt);

  const productionApproval = evidence.evidenceMode === "live";
  const decision = !productionApproval
    ? "example-only"
    : evidence.classificationRequested === "limited-production"
      ? "eligible-limited-production"
      : "eligible-beta-only";

  return {
    schemaVersion: 1,
    campaignId: policy.campaign_id,
    evidenceMode: evidence.evidenceMode,
    evidenceFingerprint: sha256(evidence),
    policyFingerprint: sha256(policy),
    decision,
    productionApproval,
    classification: evidence.classificationRequested,
    failureDomains: domains,
    soak: {
      hours: evidence.soak.durationHours,
      samples: evidence.soak.sampleCount,
      maximumGapMinutes: evidence.soak.maximumSampleGapMinutes,
    },
    measurements: evidence.measurements,
    passedScenarioCount: policy.requiredScenarios.length,
    provedAlertCount: policy.requiredAlerts.length,
    provedRestoreCount: policy.requiredRestoreProofs.length,
    provedRevocationCount: policy.requiredRevocations.length,
    warnings: evidence.evidenceMode === "example"
      ? ["Example evidence validates structure only and cannot approve any production launch."]
      : evidence.classificationRequested === "beta-only"
        ? ["Evidence is eligible only for explicitly limited beta use."]
        : [],
  };
}

function usage() {
  return "usage: node tools/validate-laptop-acceptance-evidence.mjs --evidence <json> [--policy <toml>] [--allow-example]";
}

function parseArgs(argv) {
  const args = { policy: defaultPolicyPath, evidence: null, allowExample: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--policy") args.policy = path.resolve(argv[++index] ?? "");
    else if (arg === "--evidence") args.evidence = path.resolve(argv[++index] ?? "");
    else if (arg === "--allow-example") args.allowExample = true;
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
    if (!args.evidence || !fs.existsSync(args.evidence)) fail(`--evidence must name an existing JSON file\n${usage()}`);
    const policy = loadAcceptancePolicy(args.policy);
    const evidence = JSON.parse(fs.readFileSync(args.evidence, "utf8"));
    const report = validateAcceptanceEvidence(evidence, policy, { allowExample: args.allowExample });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
