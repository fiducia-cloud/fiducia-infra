#!/usr/bin/env node
// Render non-secret Tailscale policy and service-mirroring bundles. The actual
// operator identity and MagicDNS domain are required deployment inputs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadTopology } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const topologyPath = path.join(root, "laptop", "topology.toml");
const policyTemplatePath = path.join(root, "laptop", "tailnet-policy.template.json");
const clusterTemplatePath = path.join(root, "laptop", "tailnet-cluster.template.yaml");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAILNET_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;

function fail(message) {
  throw new Error(message);
}

function clusterSuffix(clusterName) {
  const suffix = clusterName.replace(/^laptop-/, "");
  if (!/^(aws|gcp|azure)-sim$/.test(suffix)) {
    fail(`cluster ${JSON.stringify(clusterName)} does not map to a reviewed peer-tag suffix`);
  }
  return suffix;
}

export function validateTailnetInputs({ operator, tailnetDomain }) {
  if (typeof operator !== "string" || !EMAIL_RE.test(operator)) {
    fail("operator must be a concrete email identity");
  }
  if (typeof tailnetDomain !== "string" || !TAILNET_RE.test(tailnetDomain)) {
    fail("tailnetDomain must be a concrete MagicDNS domain such as example.ts.net");
  }
  return {
    operator: operator.toLowerCase(),
    tailnetDomain: tailnetDomain.toLowerCase(),
  };
}

export function laptopClusterNames() {
  return loadTopology(topologyPath).cluster.map((cluster) => cluster.name);
}

function replaceAllTokens(content, replacements) {
  let output = content;
  for (const [token, value] of Object.entries(replacements)) {
    output = output.replaceAll(`__${token}__`, value);
  }
  const unresolved = output.match(/__[A-Z0-9_]+__/g);
  if (unresolved) fail(`unresolved template token(s): ${[...new Set(unresolved)].join(", ")}`);
  return output;
}

export function renderTailnetPolicy(inputs) {
  const { operator } = validateTailnetInputs(inputs);
  const template = fs.readFileSync(policyTemplatePath, "utf8");
  return JSON.parse(replaceAllTokens(template, { OPERATOR_EMAIL: operator }));
}

export function renderClusterTailnetBundle({ clusterName, operator, tailnetDomain }) {
  const validated = validateTailnetInputs({ operator, tailnetDomain });
  const clusters = laptopClusterNames();
  if (!clusters.includes(clusterName)) fail(`unknown laptop cluster ${JSON.stringify(clusterName)}`);
  const peers = clusters.filter((candidate) => candidate !== clusterName);
  const template = fs.readFileSync(clusterTemplatePath, "utf8");
  const manifest = replaceAllTokens(template, {
    CLUSTER: clusterName,
    CLUSTER_SUFFIX: clusterSuffix(clusterName),
    PEER1: peers[0],
    PEER2: peers[1],
    TAILNET_DOMAIN: validated.tailnetDomain,
  });
  const peerEnv = [
    `FIDUCIA_PEERS=${peers.map((peer) => `fiducia-node-${peer}-tailnet.fiducia.svc.cluster.local:9090`).join(",")}`,
    `FIDUCIA_BRAIN_PEERS=${peers.map((peer) => `fiducia-brain-${peer}-tailnet.fiducia.svc.cluster.local:9095`).join(",")}`,
    "",
  ].join("\n");
  return { cluster: clusterName, manifest, peerEnv };
}

export function renderTailnetBundle(inputs) {
  const validated = validateTailnetInputs(inputs);
  return {
    schemaVersion: 1,
    nonSecret: true,
    tailnetDomain: validated.tailnetDomain,
    policy: renderTailnetPolicy(validated),
    clusters: Object.fromEntries(
      laptopClusterNames().map((clusterName) => [
        clusterName,
        renderClusterTailnetBundle({ clusterName, ...validated }),
      ]),
    ),
    nonClaims: [
      "This render does not install the Tailscale Kubernetes Operator.",
      "This render contains no OAuth credential or auth key.",
      "The policy must pass Tailscale policy tests before rollout.",
      "Live ingress, egress, failover, and WireGuard fallback remain evidence gates.",
    ],
  };
}

function usage() {
  return "usage: node tools/render-laptop-tailnet.mjs --operator <email> --tailnet-domain <name.ts.net> [--cluster <name>] [--policy-only]";
}

function parseArgs(argv) {
  const args = { operator: null, tailnetDomain: null, cluster: null, policyOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--operator") args.operator = argv[++index];
    else if (arg === "--tailnet-domain") args.tailnetDomain = argv[++index];
    else if (arg === "--cluster") args.cluster = argv[++index];
    else if (arg === "--policy-only") args.policyOnly = true;
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
    const validated = validateTailnetInputs(args);
    const output = args.policyOnly
      ? renderTailnetPolicy(validated)
      : args.cluster
        ? renderClusterTailnetBundle({ clusterName: args.cluster, ...validated })
        : renderTailnetBundle(validated);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
