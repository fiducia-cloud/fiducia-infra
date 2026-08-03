#!/usr/bin/env node
// Verify that K3s reports a recent, ready local and S3 ETCDSnapshotFile pair
// with the same snapshot name, size, creation time, and token-hash annotation.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

function dateMs(value, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(`${field} must be an ISO timestamp`);
  return parsed.getTime();
}

function storageNode(item) {
  return item.metadata?.labels?.["etcd.k3s.cattle.io/snapshot-storage-node"];
}

function tokenHash(item) {
  return item.metadata?.annotations?.["etcd.k3s.cattle.io/snapshot-token-hash"];
}

function ready(item) {
  return item.status?.readyToUse === true && Number(item.status?.size) > 0;
}

export function verifySnapshotEvidence(list, clusterName, { maxAgeHours = 8, now = new Date() } = {}) {
  if (!["laptop-aws-sim", "laptop-gcp-sim", "laptop-azure-sim"].includes(clusterName)) {
    fail(`unknown laptop cluster ${JSON.stringify(clusterName)}`);
  }
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 168) {
    fail("maxAgeHours must be in (0, 168]");
  }
  if (!Array.isArray(list?.items)) fail("evidence must be a Kubernetes List with items");

  const local = list.items.filter((item) =>
    item.apiVersion === "k3s.cattle.io/v1" &&
    item.kind === "ETCDSnapshotFile" &&
    item.spec?.nodeName === clusterName &&
    String(item.spec?.location ?? "").startsWith("file://") &&
    storageNode(item) === clusterName &&
    ready(item)
  );
  const s3 = list.items.filter((item) =>
    item.apiVersion === "k3s.cattle.io/v1" &&
    item.kind === "ETCDSnapshotFile" &&
    item.spec?.nodeName === "s3" &&
    String(item.spec?.location ?? "").startsWith("s3://") &&
    storageNode(item) === "s3" &&
    item.spec?.s3?.skipSSLVerify !== true &&
    ready(item)
  );

  const pairs = [];
  for (const localItem of local) {
    for (const s3Item of s3) {
      if (localItem.spec.snapshotName !== s3Item.spec.snapshotName) continue;
      if (Number(localItem.status.size) !== Number(s3Item.status.size)) continue;
      const localTime = dateMs(localItem.status.creationTime, `${localItem.metadata?.name}.status.creationTime`);
      const s3Time = dateMs(s3Item.status.creationTime, `${s3Item.metadata?.name}.status.creationTime`);
      if (Math.abs(localTime - s3Time) > 5 * 60 * 1000) continue;
      const localToken = tokenHash(localItem);
      const s3Token = tokenHash(s3Item);
      if (!localToken || localToken !== s3Token) continue;
      pairs.push({ localItem, s3Item, creationMs: Math.max(localTime, s3Time) });
    }
  }

  if (!pairs.length) fail("no ready local/S3 snapshot pair with matching name, size, time, and token hash");
  pairs.sort((a, b) => b.creationMs - a.creationMs);
  const latest = pairs[0];
  const ageMs = now.getTime() - latest.creationMs;
  if (ageMs < -60_000) fail("latest snapshot evidence is materially in the future");
  if (ageMs > maxAgeHours * 60 * 60 * 1000) {
    fail(`latest matched snapshot is older than ${maxAgeHours} hours`);
  }

  return {
    cluster: clusterName,
    snapshotName: latest.localItem.spec.snapshotName,
    creationTime: new Date(latest.creationMs).toISOString(),
    size: Number(latest.localItem.status.size),
    localResource: latest.localItem.metadata.name,
    s3Resource: latest.s3Item.metadata.name,
    tokenHashMatched: true,
    readyLocal: true,
    readyS3: true,
    tlsVerification: latest.s3Item.spec?.s3?.skipSSLVerify !== true,
  };
}

function usage() {
  return [
    "usage: node tools/verify-etcd-snapshot-evidence.mjs",
    "  --cluster <laptop-*-sim>",
    "  --file <etcdsnapshotfile-list.json>",
    "  [--max-age-hours 8]",
    "  [--now <ISO timestamp>]",
  ].join("\n");
}

function main() {
  try {
    const args = process.argv.slice(2);
    const value = (name) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : null;
    };
    const cluster = value("--cluster");
    const file = value("--file");
    if (!cluster || !file) fail(usage());
    const maxAgeHours = Number(value("--max-age-hours") ?? 8);
    const nowValue = value("--now");
    const now = nowValue ? new Date(nowValue) : new Date();
    const list = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    const summary = verifySnapshotEvidence(list, cluster, { maxAgeHours, now });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
