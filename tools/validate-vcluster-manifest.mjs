#!/usr/bin/env node

// Fail closed when the vCluster control-plane datastore stops using the
// reviewed local-path/5Gi profile. This intentionally validates the rendered
// chart output, not only the checked-in values, because an omitted Helm value
// silently inherits the host's default StorageClass.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

function documentName(document) {
  const metadata = document.match(/^metadata:\s*\n((?:^[ \t]+.*\n?)*)/m)?.[1] ?? "";
  return metadata.match(/^  name:\s*([^#\s]+)\s*$/m)?.[1] ?? "";
}

function indentedBlock(document, key, indentation) {
  const lines = document.split("\n");
  const prefix = " ".repeat(indentation);
  const start = lines.findIndex((line) => line === `${prefix}${key}:`);
  if (start === -1) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const leading = line.length - line.trimStart().length;
    // YAML permits sequence indicators at the same indentation as their key
    // (`volumeClaimTemplates:\n  - metadata:`), so that line remains inside.
    if (leading < indentation || (leading === indentation && !line.trimStart().startsWith("-"))) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function validateVclusterManifest(manifest, release) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(release)) {
    throw new Error("release must be a DNS label");
  }
  const documents = manifest.split(/^---\s*$/m);
  const statefulSets = documents.filter(
    (document) => /^kind:\s*StatefulSet\s*$/m.test(document) && documentName(document) === release,
  );
  if (statefulSets.length !== 1) {
    throw new Error(`expected exactly one StatefulSet named ${release}; found ${statefulSets.length}`);
  }
  const claims = indentedBlock(statefulSets[0], "volumeClaimTemplates", 2);
  if (!claims) throw new Error(`${release} has no volumeClaimTemplates block`);
  if (!/^[ \t]+storageClassName:\s*local-path\s*$/m.test(claims)) {
    throw new Error(`${release} datastore must render storageClassName: local-path`);
  }
  if (!/^[ \t]+storage:\s*5Gi\s*$/m.test(claims)) {
    throw new Error(`${release} datastore must render a 5Gi storage request`);
  }
  return true;
}

function main() {
  const [manifestPath, release] = process.argv.slice(2);
  if (!manifestPath || !release || process.argv.length !== 4) {
    throw new Error("usage: tools/validate-vcluster-manifest.mjs <manifest.yaml> <release>");
  }
  validateVclusterManifest(fs.readFileSync(manifestPath, "utf8"), release);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
