// Structured manifest access for the contract tests.
//
// This repo carries no npm dependencies (see package.json), so there is no YAML
// parser available — and regex assertions over raw YAML have repeatedly been
// too weak (`resources: {}` satisfies /resources:/). kubectl is already a hard
// requirement of CI and of tools/render-hetzner-e2e-release.mjs, and
// `kubectl patch --local` parses YAML into JSON entirely offline (no cluster,
// no API discovery), so it is the parser.
//
//   parseManifests(yamlText)  -> [{apiVersion, kind, ...}, ...]
//   readManifests(relPath)    -> the same, for a checked-in file
//   renderOverlay(relDir)     -> `kubectl kustomize <dir>`, parsed
//   podSpecsOf(documents)     -> [{ where, spec }] for every workload pod spec

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KUBECTL = process.env.FIDUCIA_KUBECTL || "kubectl";
const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

/** Split kubectl's concatenated pretty-printed JSON objects into values. */
function splitJsonStream(text) {
  const documents = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) documents.push(JSON.parse(text.slice(start, index + 1)));
    }
  }
  return documents;
}

export function parseManifests(yamlText) {
  if (!yamlText.trim()) return [];
  const json = execFileSync(
    KUBECTL,
    ["patch", "--local", "-f", "-", "-o", "json", "--type", "merge", "-p", "{}"],
    { input: yamlText, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return splitJsonStream(json);
}

export function readManifests(relativePath) {
  return parseManifests(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

export function renderOverlay(relativeDir) {
  const yaml = execFileSync(KUBECTL, ["kustomize", path.join(root, relativeDir)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseManifests(yaml);
}

/** Every YAML file under `relativeDir` that declares a workload. */
export function workloadFiles(relativeDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, relativeDir));
  return files
    .filter((file) => /kind:\s*(Deployment|StatefulSet|DaemonSet)/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
}

/** Pod specs of every workload document, labelled for assertion messages. */
export function podSpecsOf(documents, origin) {
  return documents
    .filter((document) => WORKLOAD_KINDS.has(document.kind))
    .map((document) => ({
      where: `${origin} ${document.kind}/${document.metadata?.name}`,
      spec: document.spec?.template?.spec ?? {},
    }));
}
