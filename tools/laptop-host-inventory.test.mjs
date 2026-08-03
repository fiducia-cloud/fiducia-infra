import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  loadInventory,
  validateFleetInventory,
} from "./validate-laptop-inventory.mjs";

const exampleUrl = new URL("../laptop/inventory/fleet.example.json", import.meta.url);
const fixedNow = new Date("2026-08-03T18:00:00Z");
const example = () => structuredClone(loadInventory(exampleUrl.pathname));

function liveInventory() {
  const inventory = example();
  inventory.evidenceMode = "live";
  inventory.capturedAt = "2026-08-03T16:00:00Z";
  inventory.reviewedAt = "2026-08-03T17:00:00Z";
  for (const host of inventory.hosts) {
    host.firmware.firmwareUpdatedAt = "2026-08-01T12:00:00Z";
    host.network.backupWan.testedAt = "2026-08-03T15:00:00Z";
    host.approval.reviewedAt = "2026-08-03T17:00:00Z";
    for (const key of Object.keys(host.evidence)) {
      host.evidence[key] = host.evidence[key].replace(/^example:/, "evidence:");
    }
  }
  return inventory;
}

test("the example fleet passes only in explicit rehearsal mode and emits bounded capacity", () => {
  assert.throws(() => validateFleetInventory(example(), { now: fixedNow }), /requires --allow-example/);
  const report = validateFleetInventory(example(), { allowExample: true, now: fixedNow });
  assert.equal(report.status, "passed");
  assert.equal(report.evidenceMode, "example");
  assert.equal(report.launchClassification, "limited-production");
  assert.equal(report.capacity.totalLogicalCpuCount, 26);
  assert.equal(report.capacity.totalMemoryMiB, 98304);
  assert.equal(report.capacity.totalDiskGiB, 2859);
  assert.equal(report.capacity.minimumUploadMbps, 80);
  assert.equal(report.capacity.minimumLaptopBatteryMinutes, 150);
  assert.equal(report.capacity.minimumRouterUpsMinutes, 45);
  assert.equal(report.failureDomains.distinctIsps, true);
  assert.equal(report.controls.approvedEverywhere, true);
  assert.match(report.fleetFingerprint, /^[a-f0-9]{64}$/);
});

test("fleet identity, provider mapping, sites, disks, and ISP domains must be unique", () => {
  const duplicateSite = example();
  duplicateSite.hosts[1].siteId = duplicateSite.hosts[0].siteId;
  assert.throws(() => validateFleetInventory(duplicateSite, { allowExample: true, now: fixedNow }), /siteId must be unique/);

  const duplicateDisk = example();
  duplicateDisk.hosts[1].serialHash = duplicateDisk.hosts[0].serialHash;
  assert.throws(() => validateFleetInventory(duplicateDisk, { allowExample: true, now: fixedNow }), /serialHash must be unique/);

  const wrongProvider = example();
  wrongProvider.hosts[0].syntheticProvider = "gcp";
  assert.throws(() => validateFleetInventory(wrongProvider, { allowExample: true, now: fixedNow }), /does not match/);

  const duplicateIsp = example();
  duplicateIsp.hosts[1].network.ispFingerprint = duplicateIsp.hosts[0].network.ispFingerprint;
  assert.throws(() => validateFleetInventory(duplicateIsp, { allowExample: true, now: fixedNow }), /distinct ISP fingerprints/);
});

test("home LANs cannot collide with laptop Pod, Service, or peer home networks", () => {
  const podCollision = example();
  podCollision.hosts[0].network.homeLanCidrs = ["10.41.10.0/24"];
  assert.throws(() => validateFleetInventory(podCollision, { allowExample: true, now: fixedNow }), /overlaps laptop-aws-sim\.pod_cidr/);

  const peerCollision = example();
  peerCollision.hosts[1].network.homeLanCidrs = [peerCollision.hosts[0].network.homeLanCidrs[0]];
  assert.throws(() => validateFleetInventory(peerCollision, { allowExample: true, now: fixedNow }), /home LAN CIDRs overlap across hosts/);
});

test("hardware and appliance controls fail closed below the production floor", () => {
  const weakMemory = example();
  weakMemory.hosts[0].hardware.memoryMiB = 8192;
  assert.throws(() => validateFleetInventory(weakMemory, { allowExample: true, now: fixedNow }), /memoryMiB must be in 16384/);

  const unhealthyDisk = example();
  unhealthyDisk.hosts[0].hardware.disk.smartPassed = false;
  assert.throws(() => validateFleetInventory(unhealthyDisk, { allowExample: true, now: fixedNow }), /smartPassed must be true/);

  const passwordSsh = example();
  passwordSsh.hosts[0].hostPolicy.passwordSsh = true;
  assert.throws(() => validateFleetInventory(passwordSsh, { allowExample: true, now: fixedNow }), /passwordSsh must be false/);

  const sleep = example();
  sleep.hosts[0].hostPolicy.sleepEnabled = true;
  assert.throws(() => validateFleetInventory(sleep, { allowExample: true, now: fixedNow }), /sleepEnabled must be false/);

  const automaticFleetUpdate = example();
  automaticFleetUpdate.hosts[0].hostPolicy.automaticFleetWideUpdates = true;
  assert.throws(() => validateFleetInventory(automaticFleetUpdate, { allowExample: true, now: fixedNow }), /automaticFleetWideUpdates must be false/);
});

test("limited production requires independent sites, utilities, backup WAN, Secure Boot, and approval", () => {
  const correlated = example();
  correlated.hosts[0].network.failureDomainIndependent = false;
  assert.throws(() => validateFleetInventory(correlated, { allowExample: true, now: fixedNow }), /independent site and utility failure domains/);

  const noBackup = example();
  noBackup.hosts[0].network.backupWan.available = false;
  noBackup.hosts[0].network.backupWan.exception = "This example site has not yet provisioned an independent backup WAN path.";
  assert.throws(() => validateFleetInventory(noBackup, { allowExample: true, now: fixedNow }), /tested independent backup WAN/);

  const insecureBoot = example();
  insecureBoot.hosts[0].firmware.secureBoot = false;
  insecureBoot.hosts[0].firmware.secureBootException = "This example hardware does not currently support the approved Secure Boot chain.";
  assert.throws(() => validateFleetInventory(insecureBoot, { allowExample: true, now: fixedNow }), /Secure Boot/);

  const pending = example();
  pending.hosts[0].approval.status = "pending";
  pending.hosts[0].approval.reviewedAt = null;
  assert.throws(() => validateFleetInventory(pending, { allowExample: true, now: fixedNow }), /explicit approval/);
});

test("correlated or incomplete infrastructure can be represented only as beta with an explicit exception", () => {
  const beta = example();
  beta.launchClassification = "beta-only";
  beta.fleetException = "The three machines are temporarily correlated by one utility domain and cannot support a limited-production availability claim.";
  beta.hosts[0].network.failureDomainIndependent = false;
  beta.hosts[0].power.independentUtilityDomain = false;
  beta.hosts[0].network.backupWan.available = false;
  beta.hosts[0].network.backupWan.independentProvider = false;
  beta.hosts[0].network.backupWan.testedAt = null;
  beta.hosts[0].network.backupWan.exception = "The site has no independent backup WAN and remains restricted to beta traffic.";
  assert.doesNotThrow(() => validateFleetInventory(beta, { allowExample: true, now: fixedNow }));

  beta.fleetException = null;
  assert.throws(() => validateFleetInventory(beta, { allowExample: true, now: fixedNow }), /fleetException/);
});

test("live evidence must be fresh, concrete, reviewed, and non-example", () => {
  const live = liveInventory();
  assert.doesNotThrow(() => validateFleetInventory(live, { now: fixedNow }));

  const staleCapture = liveInventory();
  staleCapture.capturedAt = "2026-06-01T00:00:00Z";
  assert.throws(() => validateFleetInventory(staleCapture, { now: fixedNow }), /older than 30 days/);

  const staleReview = liveInventory();
  staleReview.reviewedAt = "2026-07-01T00:00:00Z";
  assert.throws(() => validateFleetInventory(staleReview, { now: fixedNow }), /older than 7 days/);

  const exampleProof = liveInventory();
  exampleProof.hosts[0].evidence.smart = "example:site-a:smart";
  assert.throws(() => validateFleetInventory(exampleProof, { now: fixedNow }), /cannot use example evidence/);

  const pending = liveInventory();
  pending.hosts[0].approval.status = "pending";
  pending.hosts[0].approval.reviewedAt = null;
  assert.throws(() => validateFleetInventory(pending, { now: fixedNow }), /requires explicit approval/);
});

test("secret-bearing keys and credential-like values are rejected recursively", () => {
  const secretKey = example();
  secretKey.hosts[0].network.accessToken = "redacted";
  assert.throws(() => validateFleetInventory(secretKey, { allowExample: true, now: fixedNow }), /forbidden secret-bearing/);

  const credential = example();
  credential.hosts[0].physicalAccessOwner = "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.throws(() => validateFleetInventory(credential, { allowExample: true, now: fixedNow }), /credential-like/);

  const rawSerial = example();
  rawSerial.hosts[0].rawSerial = "ABC123";
  assert.throws(() => validateFleetInventory(rawSerial, { allowExample: true, now: fixedNow }), /forbidden secret-bearing/);
});

test("identical live inventory produces a deterministic fleet fingerprint", () => {
  const first = validateFleetInventory(liveInventory(), { now: fixedNow });
  const second = validateFleetInventory(liveInventory(), { now: fixedNow });
  assert.equal(first.fleetFingerprint, second.fleetFingerprint);
});

test("inventory schema is strict and documents every production control group", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../laptop/inventory/fleet.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.host.additionalProperties, false);
  assert.equal(schema.$defs.host.properties.hardware.additionalProperties, false);
  assert.equal(schema.$defs.host.properties.network.additionalProperties, false);
  assert.equal(schema.$defs.host.properties.hostPolicy.additionalProperties, false);
  assert.equal(schema.$defs.host.properties.evidence.additionalProperties, false);
  assert.deepEqual(schema.properties.hosts.minItems, 3);
  assert.deepEqual(schema.properties.hosts.maxItems, 3);
});

test("NixOS module restricts management to the mesh and disables unattended fleet-wide changes", () => {
  const module = fs.readFileSync(new URL("../nix/modules/fiducia-laptop-host.nix", import.meta.url), "utf8");
  assert.match(module, /services\.openssh[\s\S]*openFirewall = false/);
  assert.match(module, /PasswordAuthentication = false/);
  assert.match(module, /KbdInteractiveAuthentication = false/);
  assert.match(module, /PermitRootLogin = "no"/);
  assert.match(module, /AllowUsers = \[ cfg\.operatorUser \]/);
  assert.match(module, /interfaces\.\$\{cfg\.meshInterface\}\.allowedTCPPorts = \[[\s\S]*22[\s\S]*6443/);
  assert.match(module, /allowedTCPPorts = \[ \]/);
  assert.doesNotMatch(module, /trustedInterfaces/);
  assert.match(module, /services\.tailscale\.enable = true/);
  assert.match(module, /services\.smartd[\s\S]*enable = true[\s\S]*autodetect = true/);
  assert.match(module, /services\.fstrim\.enable = true/);
  assert.match(module, /services\.timesyncd\.enable = true/);
  assert.match(module, /HandleLidSwitch = "ignore"/);
  assert.match(module, /AllowSuspend=no/);
  assert.match(module, /AllowHibernation=no/);
  assert.match(module, /RuntimeWatchdogSec = "60s"/);
  assert.match(module, /system\.autoUpgrade\.enable = false/);
  assert.match(module, /fiducia-laptop-host-audit[\s\S]*OnUnitActiveSec = "15min"/);
  assert.doesNotMatch(module, /wheelNeedsPassword = false/);
});

test("host evidence capture is read-only, redacted, local, and root-gated", () => {
  const script = fs.readFileSync(new URL("../scripts/capture-laptop-host-evidence.sh", import.meta.url), "utf8");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /umask 077/);
  assert.match(script, /production evidence capture must run as root/);
  assert.match(script, /serialNumbers: "excluded"/);
  assert.match(script, /macAddresses: "excluded"/);
  assert.match(script, /ipAddresses: "excluded"/);
  assert.match(script, /credentials: "excluded"/);
  assert.match(script, /rawFirewallRules: "hashed-not-stored"/);
  assert.match(script, /chmod 600/);
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b/);
  assert.doesNotMatch(script, /set -x|set -o xtrace/);
  assert.doesNotMatch(script, /printenv|\/proc\/[0-9]+\/environ/);
  assert.doesNotMatch(script, /SERIAL|MACADDRESS|ADDRESS=/i);
});
