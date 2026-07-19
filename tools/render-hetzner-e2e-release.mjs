#!/usr/bin/env node

// Render a deployable three-cluster release outside the repository. Kustomize
// overlays intentionally retain human-readable tag placeholders; this tool is
// the mandatory release boundary and only accepts immutable GHCR digests.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export const CLUSTERS = Object.freeze(["hetzner-fsn1", "hetzner-nbg1", "hetzner-hel1"]);
export const CORE_IMAGES = Object.freeze({
  node: "ghcr.io/fiducia-cloud/fiducia-node",
  sidecar: "ghcr.io/fiducia-cloud/fiducia-node-sidecar",
  brain: "ghcr.io/fiducia-cloud/fiducia-brain",
  load_balance: "ghcr.io/fiducia-cloud/fiducia-load-balance",
});

const EXPECTED_OCCURRENCES = Object.freeze({ node: 1, sidecar: 2, brain: 1, load_balance: 1 });
const PROFILES = Object.freeze({
  vcluster: "vcluster/hetzner-e2e/clusters",
  vm: "k3s/hetzner-e2e/clusters",
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateImageRefs(imageRefs) {
  const keys = Object.keys(CORE_IMAGES);
  if (Object.keys(imageRefs).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`supply exactly these image keys: ${keys.join(", ")}`);
  }
  for (const [key, repository] of Object.entries(CORE_IMAGES)) {
    const expected = new RegExp(`^${escapeRegExp(repository)}@sha256:[0-9a-f]{64}$`);
    if (!expected.test(imageRefs[key])) {
      throw new Error(`${key} must be ${repository}@sha256:<64 lowercase hex characters>`);
    }
  }
  return imageRefs;
}

export function pinManifestImages(manifest, imageRefs) {
  validateImageRefs(imageRefs);
  if (/^kind:\s*Secret\s*$/m.test(manifest)) {
    throw new Error("rendered releases must not contain Kubernetes Secret objects");
  }

  let pinned = manifest;
  for (const [key, repository] of Object.entries(CORE_IMAGES)) {
    const matcher = new RegExp(
      `(image:\\s*)${escapeRegExp(repository)}(?::[^\\s]+|@sha256:[0-9a-f]{64})`,
      "g",
    );
    let occurrences = 0;
    pinned = pinned.replace(matcher, (_match, prefix) => {
      occurrences += 1;
      return `${prefix}${imageRefs[key]}`;
    });
    if (occurrences !== EXPECTED_OCCURRENCES[key]) {
      throw new Error(
        `${repository} occurred ${occurrences} time(s); expected ${EXPECTED_OCCURRENCES[key]} — inspect base drift`,
      );
    }
  }

  const coreImageLines = pinned
    .split("\n")
    .filter((line) => Object.values(CORE_IMAGES).some((repository) => line.includes(repository)));
  if (
    coreImageLines.length !== Object.values(EXPECTED_OCCURRENCES).reduce((sum, count) => sum + count, 0) ||
    coreImageLines.some((line) => !/@sha256:[0-9a-f]{64}\s*$/.test(line))
  ) {
    throw new Error("every Fiducia workload image must be digest-pinned in the release manifest");
  }
  return pinned;
}

export function parseImageArgs(argv) {
  const imageRefs = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--image") continue;
    const assignment = argv[index + 1] ?? "";
    const separator = assignment.indexOf("=");
    if (separator < 1) throw new Error("--image requires key=repository@sha256:digest");
    imageRefs[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    index += 1;
  }
  return validateImageRefs(imageRefs);
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1 || !argv[index + 1]) throw new Error(`${flag} is required`);
  return argv[index + 1];
}

function optionalArgumentValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argumentValue(argv, flag);
}

function refuseRepositoryOutput(outputRoot) {
  if (!path.isAbsolute(outputRoot)) throw new Error("--output must be an absolute path outside the repository");
  const relative = path.relative(root, outputRoot);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error("release output must stay outside the repository");
  }

  // Resolve the closest existing ancestor too, so a symlink cannot redirect an
  // apparently external release directory back into the checkout.
  let existing = outputRoot;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realCandidate = path.join(fs.realpathSync(existing), path.relative(existing, outputRoot));
  const realRelative = path.relative(fs.realpathSync(root), realCandidate);
  if (realRelative === "" || (!realRelative.startsWith(`..${path.sep}`) && realRelative !== "..")) {
    throw new Error("release output resolves inside the repository");
  }
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function sourceEvidence() {
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const status = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain", "--untracked-files=normal"],
    { encoding: "utf8" },
  );
  if (status !== "") {
    throw new Error("release rendering requires a clean committed fiducia-infra source tree");
  }
  return { repository: "fiducia-infra", commit, clean: true };
}

export function renderRelease(imageRefs, { profile = "vcluster" } = {}) {
  const clusterRoot = PROFILES[profile];
  if (!clusterRoot) throw new Error(`--profile must be one of: ${Object.keys(PROFILES).join(", ")}`);
  const manifests = {};
  for (const cluster of CLUSTERS) {
    const overlay = path.join(root, clusterRoot, cluster);
    const raw = execFileSync("kubectl", ["kustomize", overlay], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!new RegExp(`FIDUCIA_CLUSTER:\\s+${escapeRegExp(cluster)}(?:\\s|$)`).test(raw)) {
      throw new Error(`${cluster} manifest does not carry its expected cluster identity`);
    }
    manifests[cluster] = pinManifestImages(raw, imageRefs);
  }
  return manifests;
}

function main() {
  const argv = process.argv.slice(2);
  const profile = optionalArgumentValue(argv, "--profile", "vcluster");
  const outputArgument = argumentValue(argv, "--output");
  if (!path.isAbsolute(outputArgument)) {
    throw new Error("--output must be an absolute path outside the repository");
  }
  const outputRoot = path.resolve(outputArgument);
  if (argv.includes("--check")) {
    throw new Error("release rendering is already validation-only until --output is written; --check is unsupported");
  }
  refuseRepositoryOutput(outputRoot);
  const imageRefs = parseImageArgs(argv);
  const source = sourceEvidence();
  const manifests = renderRelease(imageRefs, { profile });
  const manifestDirectory = path.join(outputRoot, "manifests");
  const evidenceDirectory = path.join(outputRoot, "evidence");
  fs.mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });

  const manifestDigests = {};
  for (const [cluster, content] of Object.entries(manifests)) {
    const destination = path.join(manifestDirectory, `${cluster}.yaml`);
    fs.writeFileSync(destination, content, { encoding: "utf8", mode: 0o600 });
    manifestDigests[cluster] = `sha256:${sha256(content)}`;
  }

  const release = {
    schema_version: 1,
    topology: profile === "vcluster"
      ? "three-logically-isolated-vclusters-on-existing-hetzner-kubeadm"
      : "three-independent-single-node-k3s-on-hetzner",
    profile,
    source,
    clusters: CLUSTERS,
    images: imageRefs,
    manifests: manifestDigests,
    rendered_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(evidenceDirectory, "release.json"), `${JSON.stringify(release, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`rendered ${CLUSTERS.length} digest-pinned manifests under ${outputRoot}`);
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
