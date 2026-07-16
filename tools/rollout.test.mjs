// Tests that the rollout runbook's Kubernetes guarantees are encoded in base.
//   node --test tools/*.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function containerBlock(manifest, name) {
  const marker = `- name: ${name}`;
  const start = manifest.indexOf(marker);
  assert.notEqual(start, -1, `missing container ${name}`);
  const rest = manifest.slice(start);
  const nextContainer = rest.indexOf("\n        - name: ", marker.length);
  return nextContainer === -1 ? rest : rest.slice(0, nextContainer);
}

function imageRef(block) {
  const match = block.match(/^\s*image:\s*(\S+)/m);
  assert.ok(match, "missing container image");
  return match[1];
}

function splitImage(ref) {
  const tagStart = ref.lastIndexOf(":");
  assert.notEqual(tagStart, -1, `image must include an explicit tag: ${ref}`);
  return {
    repository: ref.slice(0, tagStart),
    tag: ref.slice(tagStart + 1),
  };
}

function assertVersionedImage(ref, repository) {
  const image = splitImage(ref);
  assert.equal(image.repository, repository);
  assert.match(image.tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.notEqual(image.tag, "latest");
}

function assertVersionedFiduciaImage(ref) {
  const image = splitImage(ref);
  assert.match(image.repository, /^ghcr\.io\/fiducia-cloud\/[a-z0-9-]+$/);
  assert.match(image.tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.notEqual(image.tag, "latest");
}

test("load balancer rollout uses a zero-downtime Deployment strategy", () => {
  const doc = read("docs/ROLLOUT.md");
  const deployment = read("base/load-balance/deployment.yaml");

  assert.match(doc, /fiducia-load-balance[\s\S]*maxSurge: 1, maxUnavailable: 0/);
  assert.match(deployment, /kind:\s*Deployment/);
  assert.match(deployment, /name:\s*fiducia-load-balance/);
  assert.match(deployment, /strategy:\s*\n\s+type:\s*RollingUpdate/);
  assert.match(deployment, /rollingUpdate:\s*\n\s+maxSurge:\s*1\s*\n\s+maxUnavailable:\s*0/);
  // Readiness waits for a hydrated route table, while liveness only checks that
  // the process remains responsive. Keep both probes explicit so a regression
  // cannot make a live-but-unroutable LB receive traffic.
  assert.match(deployment, /readinessProbe:\s*\{\s*httpGet:\s*\{\s*path:\s*\/readyz/);
  assert.match(deployment, /livenessProbe:\s*\{\s*httpGet:\s*\{\s*path:\s*\/healthz/);
});

test("node rollout limits disruption and preserves StatefulSet canary mechanics", () => {
  const doc = read("docs/ROLLOUT.md");
  const statefulSet = read("base/node/statefulset.yaml");
  const pdb = read("base/node/pdb.yaml");
  const kustomization = read("base/kustomization.yaml");

  assert.match(doc, /PodDisruptionBudget present \(`maxUnavailable: 1` per cluster\)/);
  assert.match(doc, /StatefulSet `updateStrategy\.rollingUpdate\.partition`/);
  assert.match(statefulSet, /kind:\s*StatefulSet/);
  assert.match(statefulSet, /name:\s*fiducia-node/);
  assert.match(statefulSet, /replicas:\s*3/);
  assert.match(statefulSet, /updateStrategy:\s*\n\s+type:\s*RollingUpdate\s*\n\s+rollingUpdate:\s*\n\s+partition:\s*0/);
  assert.match(statefulSet, /readinessProbe:\s*\{\s*httpGet:\s*\{\s*path:\s*\/readyz/);
  assert.match(statefulSet, /livenessProbe:\s*\{\s*httpGet:\s*\{\s*path:\s*\/healthz/);
  assert.match(pdb, /kind:\s*PodDisruptionBudget/);
  assert.match(pdb, /maxUnavailable:\s*1/);
  assert.match(pdb, /app:\s*fiducia-node/);
  assert.match(kustomization, /node\/pdb\.yaml/);
});

test("brain rollout uses one rolling StatefulSet member per cluster", () => {
  const doc = read("docs/ROLLOUT.md");
  const statefulSet = read("base/components/brain/statefulset.yaml");

  assert.match(doc, /Brain upgrade \(per member, one per cluster\)/);
  assert.match(statefulSet, /kind:\s*StatefulSet/);
  assert.match(statefulSet, /name:\s*fiducia-brain/);
  assert.match(statefulSet, /replicas:\s*1/);
  assert.match(statefulSet, /updateStrategy:\s*\n\s+type:\s*RollingUpdate\s*\n\s+rollingUpdate:\s*\n\s+partition:\s*0/);
  assert.match(statefulSet, /readinessProbe:\s*\{\s*httpGet:\s*\{\s*path:\s*\/readyz/);
  assert.match(statefulSet, /livenessProbe:\s*\{\s*httpGet:\s*\{\s*path:\s*\/healthz/);
});

test("server rollout targets use versioned images for new releases", () => {
  const doc = read("docs/ROLLOUT.md");
  assert.match(doc, /New image built, signed, and smoke-tested in staging/);
  assert.match(doc, /previous image tag\s+recorded for rollback/);
  assert.match(doc, /Replace the pod[\s\S]*new image/);

  const targets = [
    {
      file: "base/load-balance/deployment.yaml",
      kind: "Deployment",
      workload: "fiducia-load-balance",
      container: "lb",
      repository: "ghcr.io/fiducia-cloud/fiducia-load-balance",
    },
    {
      file: "base/components/brain/statefulset.yaml",
      kind: "StatefulSet",
      workload: "fiducia-brain",
      container: "brain",
      repository: "ghcr.io/fiducia-cloud/fiducia-brain",
    },
    {
      file: "base/node/statefulset.yaml",
      kind: "StatefulSet",
      workload: "fiducia-node",
      container: "node",
      repository: "ghcr.io/fiducia-cloud/fiducia-node",
    },
    {
      file: "base/node/statefulset.yaml",
      kind: "StatefulSet",
      workload: "fiducia-node",
      container: "sidecar",
      repository: "ghcr.io/fiducia-cloud/fiducia-node-sidecar",
    },
    {
      file: "base/components/brain/statefulset.yaml",
      kind: "StatefulSet",
      workload: "fiducia-brain",
      container: "sidecar",
      repository: "ghcr.io/fiducia-cloud/fiducia-node-sidecar",
    },
  ];

  for (const target of targets) {
    const manifest = read(target.file);
    const block = containerBlock(manifest, target.container);
    assert.match(manifest, new RegExp(`kind:\\s*${target.kind}`));
    assert.match(manifest, new RegExp(`name:\\s*${target.workload}`));
    assertVersionedImage(imageRef(block), target.repository);
  }

  for (const file of new Set(targets.map((target) => target.file))) {
    const fiduciaImages = read(file).match(/^\s*image:\s*ghcr\.io\/fiducia-cloud\/\S+/gm) ?? [];
    assert.notEqual(fiduciaImages.length, 0, `${file} should contain Fiducia images`);
    for (const line of fiduciaImages) {
      assertVersionedFiduciaImage(line.trim().replace(/^image:\s*/, ""));
    }
  }
});

test("node and brain use one sidecar image with workload-specific profiles", () => {
  const node = read("base/node/statefulset.yaml");
  const brain = read("base/components/brain/statefulset.yaml");
  const nodeSidecar = containerBlock(node, "sidecar");
  const brainSidecar = containerBlock(brain, "sidecar");

  assert.equal(imageRef(nodeSidecar), imageRef(brainSidecar));
  assert.match(nodeSidecar, /name:\s*FIDUCIA_EXPORT_TARGET\s*\n\s+value:\s*"node"/);
  assert.match(nodeSidecar, /name:\s*FIDUCIA_SIDECAR_ROLE\s*\n\s+value:\s*"full"/);
  assert.match(brainSidecar, /name:\s*FIDUCIA_EXPORT_TARGET\s*\n\s+value:\s*"brain"/);
  assert.match(brainSidecar, /name:\s*FIDUCIA_SIDECAR_ROLE\s*\n\s+value:\s*"exporter"/);
  assert.match(nodeSidecar, /containerPort:\s*8091, name:\s*sidecar/);
  assert.match(brainSidecar, /containerPort:\s*8091, name:\s*sidecar/);
});

test("brain API credentials stay out of the observability sidecar", () => {
  const manifest = read("base/components/brain/statefulset.yaml");
  const brain = containerBlock(manifest, "brain");
  const sidecar = containerBlock(manifest, "sidecar");

  assert.match(manifest, /automountServiceAccountToken:\s*false/);
  assert.match(brain, /name:\s*brain-api-token/);
  assert.doesNotMatch(sidecar, /name:\s*brain-api-token/);
  assert.match(manifest, /serviceAccountToken:\s*\{\s*path:\s*token, expirationSeconds:\s*3600\s*\}/);
});

test("OpenTelemetry discovers and scrapes both sidecar profiles", () => {
  const manifest = read("base/observability/otel-agent.yaml");

  assert.match(manifest, /prometheus\/fiducia_sidecars:/);
  assert.match(manifest, /regex:\s*fiducia-\(node\|brain\)/);
  assert.match(manifest, /__meta_kubernetes_pod_container_port_name/);
  assert.match(manifest, /regex:\s*sidecar/);
  assert.match(manifest, /receivers:\s*\[otlp, prometheus\/fiducia_sidecars\]/);
});
