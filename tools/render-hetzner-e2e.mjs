#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadTopology, render } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const sourceName = "k3s/hetzner-e2e/topology.toml";
const topologyPath = path.join(root, sourceName);
const renderOptions = {
  clusterRoot: "k3s/hetzner-e2e/clusters",
  edgeOutput: "k3s/hetzner-e2e/generated/lb-endpoints.json",
  sourceName,
};

export function loadHetznerE2eTopology() {
  const topology = loadTopology(topologyPath);
  const expected = ["hetzner-fsn1", "hetzner-nbg1", "hetzner-hel1"];
  const actual = topology.cluster.map((cluster) => cluster.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Hetzner E2E members must be exactly ${expected.join(", ")}`);
  }
  if (topology.connectivity !== "private-network" || topology.replication_factor !== 3) {
    throw new Error("Hetzner E2E requires private-network connectivity and replication_factor=3");
  }
  if (topology.cluster.some((cluster) => !cluster.node_api_endpoint)) {
    throw new Error("every Hetzner E2E member needs a fixed private node_api_endpoint");
  }
  return topology;
}

export function renderHetznerE2e() {
  return render(loadHetznerE2eTopology(), renderOptions);
}

function main() {
  const check = process.argv.includes("--check");
  const files = renderHetznerE2e();
  let drift = 0;
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    if (check) {
      const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : null;
      if (current !== content) {
        console.error(`drift: ${relativePath}`);
        drift += 1;
      }
      continue;
    }
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
    console.log(`wrote ${relativePath}`);
  }
  if (check && drift > 0) {
    console.error(`${drift} Hetzner E2E file(s) stale — run: node tools/render-hetzner-e2e.mjs`);
    process.exitCode = 1;
  } else if (check) {
    console.log("Hetzner E2E topology in sync");
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
