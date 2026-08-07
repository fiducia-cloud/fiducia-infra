#!/usr/bin/env node
// Validate the external K3s S3 snapshot Secret without printing credential
// values. This intentionally supports only the reviewed stringData shape.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scalar(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^\\s{2,}${escaped}:\\s*(.+?)\\s*$`, "m"));
  return match ? unquote(match[1]) : null;
}

export function validateK3sS3Secret(text, clusterName) {
  if (!["laptop-aws-sim", "laptop-gcp-sim", "laptop-azure-sim"].includes(clusterName)) {
    fail(`unknown laptop cluster ${JSON.stringify(clusterName)}`);
  }
  if (!/^apiVersion:\s*v1\s*$/m.test(text)) fail("Secret apiVersion must be v1");
  if (!/^kind:\s*Secret\s*$/m.test(text)) fail("manifest kind must be Secret");
  if (!/^\s+name:\s*k3s-etcd-snapshot-s3-config\s*$/m.test(text)) fail("unexpected Secret name");
  if (!/^\s+namespace:\s*kube-system\s*$/m.test(text)) fail("Secret must be in kube-system");
  if (!/^type:\s*etcd\.k3s\.cattle\.io\/s3-config-secret\s*$/m.test(text)) fail("unexpected Secret type");
  if (!/^stringData:\s*$/m.test(text)) fail("reviewed Secret shape requires stringData");

  const required = [
    "etcd-s3-endpoint",
    "etcd-s3-access-key",
    "etcd-s3-secret-key",
    "etcd-s3-bucket",
    "etcd-s3-folder",
    "etcd-s3-region",
    "etcd-s3-skip-ssl-verify",
    "etcd-s3-insecure",
  ];
  const values = Object.fromEntries(required.map((key) => [key, scalar(text, key)]));
  for (const [key, value] of Object.entries(values)) {
    if (!value) fail(`missing stringData.${key}`);
    if (/CHANGEME|REPLACE_ME|EXTERNAL_|<[^>]+>/i.test(value)) fail(`stringData.${key} still contains a placeholder`);
  }
  if (values["etcd-s3-skip-ssl-verify"] !== "false") fail("TLS verification must remain enabled");
  if (values["etcd-s3-insecure"] !== "false") fail("plaintext S3 transport must remain disabled");
  if (/^http:\/\//i.test(values["etcd-s3-endpoint"])) fail("S3 endpoint cannot use http://");
  if (!values["etcd-s3-folder"].split("/").includes(clusterName)) {
    fail(`etcd-s3-folder must contain the exact cluster identity ${clusterName}`);
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/.test(values["etcd-s3-bucket"])) {
    fail("etcd-s3-bucket is not a conservative DNS-style bucket name");
  }

  return {
    name: "k3s-etcd-snapshot-s3-config",
    namespace: "kube-system",
    cluster: clusterName,
    endpointConfigured: true,
    bucketConfigured: true,
    folderEndsWithCluster: values["etcd-s3-folder"].endsWith(clusterName),
    tlsVerification: true,
    plaintextTransport: false,
  };
}

function usage() {
  return "usage: node tools/validate-k3s-s3-secret.mjs --cluster <laptop-*-sim> --file <secret.yaml>";
}

function main() {
  try {
    const args = process.argv.slice(2);
    const clusterIndex = args.indexOf("--cluster");
    const fileIndex = args.indexOf("--file");
    if (clusterIndex < 0 || fileIndex < 0 || !args[clusterIndex + 1] || !args[fileIndex + 1]) fail(usage());
    const cluster = args[clusterIndex + 1];
    const file = path.resolve(args[fileIndex + 1]);
    const summary = validateK3sS3Secret(fs.readFileSync(file, "utf8"), cluster);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
