// Contract tests for the workload security baseline, applied to EVERY container
// in EVERY workload manifest under base/ (including kustomize components).
// Cluster-free: parses the YAML sources directly, complementing kustomize
// validation in CI. If a new container is added anywhere, these assertions
// cover it automatically — the baseline cannot silently regress per-workload.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every YAML file under base/ holding a Deployment/StatefulSet/DaemonSet. */
function workloadFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, "base"));
  return files.filter((file) =>
    /kind:\s*(Deployment|StatefulSet|DaemonSet)/.test(fs.readFileSync(file, "utf8")),
  );
}

/** Split a manifest into per-container blocks (name + following indented body). */
function containerBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s+containers:\s*$/.test(lines[i])) continue;
    // Collect each "- name:" item until dedent below the containers key.
    const baseIndent = lines[i].match(/^(\s+)/)[1].length;
    let current = null;
    let itemIndent = null; // the container items' own indent — env lists also
    // use "- name:" but sit DEEPER; only same-indent dashes start a container.
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      const indent = line.match(/^(\s*)/)[1].length;
      if (line.trim() && indent <= baseIndent) break;
      const item = /^(\s*)-\s+name:\s*(\S+)/.exec(line);
      if (item && (itemIndent === null || item[1].length === itemIndent)) {
        itemIndent = item[1].length;
        if (current) blocks.push(current);
        current = { name: item[2], body: "" };
      } else if (current) {
        current.body += `${line}\n`;
      }
    }
    if (current) blocks.push(current);
  }
  return blocks;
}

test("every base workload container is non-root, read-only, and probe-covered", () => {
  const files = workloadFiles();
  assert.ok(files.length >= 3, `expected node/LB/otel/brain workloads, found ${files.length}`);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    // Pod-level runAsNonRoot must be declared — OR the workload runs as root
    // under the fleet's documented-exception pattern (e.g. otel-agent reading
    // root-owned /var/log/pods), which requires an inline justification
    // comment so the exception is reviewable, never accidental.
    if (/runAsUser:\s*0(\s|$)/m.test(source)) {
      assert.match(
        source,
        /#.*root only/i,
        `${rel}: runs as root without a documented "root only" justification`,
      );
    } else {
      assert.match(source, /runAsNonRoot:\s*true/, `${rel}: runAsNonRoot missing`);
    }
    for (const container of containerBlocks(source)) {
      const where = `${rel} container '${container.name}'`;
      assert.match(
        container.body,
        /readOnlyRootFilesystem:\s*true/,
        `${where}: rootfs must be read-only`,
      );
      assert.match(
        container.body,
        /drop:\s*\["?ALL"?\]/,
        `${where}: capabilities must drop ALL`,
      );
      assert.match(
        container.body,
        /allowPrivilegeEscalation:\s*false/,
        `${where}: privilege escalation must be off`,
      );
      assert.match(
        container.body,
        /(readinessProbe|livenessProbe):/,
        `${where}: at least one probe required`,
      );
      assert.match(container.body, /resources:/, `${where}: resource bounds required`);
    }
  }
});

test("no base workload consumes a mutable image tag", () => {
  for (const file of workloadFiles()) {
    const rel = path.relative(root, file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/image:\s*(\S+)/g)) {
      const image = match[1].replace(/["']/g, "");
      assert.ok(
        !/(:latest|:main|:edge)$/.test(image),
        `${rel}: mutable tag on ${image}`,
      );
      assert.match(
        image,
        /(:v[0-9][\w.-]*|@sha256:[0-9a-f]{64})$/,
        `${rel}: ${image} must be version- or digest-pinned`,
      );
    }
  }
});

test("fiducia-node consumes only the provider-neutral KV protection Secret", () => {
  const source = fs.readFileSync(path.join(root, "base/node/statefulset.yaml"), "utf8");

  assert.match(
    source,
    /envFrom:\s*[\s\S]*secretRef:\s*\n\s+name:\s*fiducia-kv-protection\s*\n\s+optional:\s*true/,
    "node must accept an out-of-band fiducia-kv-protection Secret",
  );
  assert.doesNotMatch(
    source,
    /FIDUCIA_KV_(?:ENCRYPTION_KEY|ENCRYPTION_KEYS|VAULT_TOKEN):\s*\S+/,
    "KV encryption material must never be embedded in the workload manifest",
  );
});
