// Contract tests for the staged Fiducia operator boundary.
//   node --test tools/*.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Raft workloads cannot roll automatically before the operator safety gates exist", () => {
  const architecture = read("docs/operator-architecture.md");
  const rollout = read("docs/ROLLOUT.md");
  const node = read("base/node/statefulset.yaml");
  const brain = read("base/components/brain/statefulset.yaml");

  for (const manifest of [node, brain]) {
    assert.match(manifest, /updateStrategy:\s*\n\s+type:\s*OnDelete/);
    assert.doesNotMatch(manifest, /rollingUpdate:/);
  }

  assert.match(architecture, /Phase 0 guardrails implemented/);
  assert.match(architecture, /initial controller must be read-only/);
  assert.match(architecture, /fixed membership/);
  assert.match(architecture, /must never simulate these contracts by editing `FIDUCIA_PEERS`/);
  assert.match(rollout, /no pod is deleted\s+until this checklist passes/);
});

test("operator contract separates Kubernetes storage from Raft lifecycle safety", () => {
  const architecture = read("docs/operator-architecture.md");

  assert.match(architecture, /Application\/diagnostic logs go to stdout\/stderr and OpenTelemetry/);
  assert.match(architecture, /Raft logs and state-machine snapshots are authoritative/);
  assert.match(architecture, /A PodDisruptionBudget only constrains clients that use the Eviction API/);
  assert.match(architecture, /never delete PVCs/);
  assert.match(architecture, /never acts from Pod\s+readiness alone/);
});

test("future mutating phases require fencing, service capabilities, and restore proof", () => {
  const architecture = read("docs/operator-architecture.md");

  assert.match(architecture, /global,\s+renewable, fenced Fiducia maintenance lock/);
  assert.match(architecture, /Leadership transfer to a named, in-sync voter/);
  assert.match(architecture, /Dynamic membership primitives: add learner/);
  assert.match(architecture, /fencing-token\s+monotonicity/);
  assert.match(architecture, /\*\*2 — safe restart\/upgrade\*\*/);
  assert.match(architecture, /\*\*3 — backup\/restore\*\*/);
  assert.match(architecture, /\*\*4 — elastic membership\*\*/);
});
