#!/usr/bin/env node
// Validate the external Cloudflare Tunnel token Secret without printing the
// token. This supports only the reviewed stringData form used by the laptop
// bootstrap path.

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

export function validateCloudflaredTokenSecret(text) {
  if (!/^apiVersion:\s*v1\s*$/m.test(text)) fail("Secret apiVersion must be v1");
  if (!/^kind:\s*Secret\s*$/m.test(text)) fail("manifest kind must be Secret");
  if (!/^\s+name:\s*cloudflared-tunnel-token\s*$/m.test(text)) fail("unexpected Secret name");
  if (!/^\s+namespace:\s*fiducia\s*$/m.test(text)) fail("Secret must be in fiducia");
  if (!/^type:\s*Opaque\s*$/m.test(text)) fail("Secret type must be Opaque");
  if (!/^stringData:\s*$/m.test(text)) fail("reviewed Secret shape requires stringData");

  const token = scalar(text, "token");
  if (!token) fail("missing stringData.token");
  if (/CHANGEME|REPLACE_ME|EXTERNAL_|<[^>]+>/i.test(token)) fail("token still contains a placeholder");
  if (/\s/.test(token)) fail("token must not contain whitespace");
  if (!token.startsWith("eyJ") || token.length < 100) fail("token does not match the expected remotely-managed tunnel token shape");

  return {
    name: "cloudflared-tunnel-token",
    namespace: "fiducia",
    tokenConfigured: true,
    tokenLengthClass: token.length >= 180 ? "long" : "standard",
  };
}

function usage() {
  return "usage: node tools/validate-cloudflared-token-secret.mjs --file <secret.yaml>";
}

function main() {
  try {
    const args = process.argv.slice(2);
    const fileIndex = args.indexOf("--file");
    if (fileIndex < 0 || !args[fileIndex + 1]) fail(usage());
    const summary = validateCloudflaredTokenSecret(fs.readFileSync(path.resolve(args[fileIndex + 1]), "utf8"));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
