// Contract tests for the deny-by-default namespace traffic model.
// These are intentionally DB/cluster-free and complement `kubectl kustomize`
// validation in CI.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

function policyDocument(manifest, name) {
  const document = manifest
    .split(/\n---\n/)
    .find((candidate) => new RegExp(`name:\\s*${name}(?:\\s|$)`).test(candidate));
  assert.ok(document, `missing NetworkPolicy ${name}`);
  return document;
}

test("namespace is default-deny and DNS is restricted to kube-system CoreDNS", () => {
  const manifest = read("base/networkpolicy.yaml");
  const deny = policyDocument(manifest, "fiducia-default-deny");
  assert.match(deny, /podSelector:\s*\{\}/);
  assert.match(deny, /policyTypes:\s*\[Ingress, Egress\]/);

  const dns = policyDocument(manifest, "fiducia-allow-dns-egress");
  assert.match(dns, /kubernetes\.io\/metadata\.name:\s*kube-system/);
  assert.match(dns, /k8s-app:\s*kube-dns/);
  assert.match(dns, /protocol:\s*UDP, port:\s*53/);
  assert.match(dns, /protocol:\s*TCP, port:\s*53/);
  assert.doesNotMatch(dns, /egress:\s*\n\s*- ports:/);
});

test("service and control traffic remains internal while peer Raft ports remain routable", () => {
  const base = read("base/networkpolicy.yaml");
  const eastWest = policyDocument(base, "fiducia-allow-namespace-internal");
  assert.match(eastWest, /kubernetes\.io\/metadata\.name:\s*fiducia/g);

  const node = read("base/node/networkpolicy.yaml");
  assert.match(node, /name:\s*fiducia-node-ingress/);
  assert.match(node, /protocol:\s*TCP, port:\s*9090/);
  assert.match(node, /name:\s*fiducia-node-peer-egress/);

  const brain = read("base/components/brain/networkpolicy.yaml");
  assert.match(brain, /name:\s*fiducia-brain-ingress/);
  assert.match(brain, /protocol:\s*TCP, port:\s*9095/);
  assert.match(brain, /name:\s*fiducia-brain-peer-egress/);
});

test("only the TLS load-balancer port is public and telemetry has required egress", () => {
  const edge = read("base/load-balance/networkpolicy.yaml");
  assert.match(edge, /protocol:\s*TCP, port:\s*8443/);
  assert.doesNotMatch(edge, /port:\s*8088/);

  const otel = read("base/observability/networkpolicy.yaml");
  for (const port of [4318, 443, 6443]) {
    assert.match(otel, new RegExp(`protocol:\\s*TCP, port:\\s*${port}`));
  }

  const kustomization = read("base/kustomization.yaml");
  for (const policy of [
    "networkpolicy.yaml",
    "node/networkpolicy.yaml",
    "load-balance/networkpolicy.yaml",
    "observability/networkpolicy.yaml",
  ]) {
    assert.match(kustomization, new RegExp(policy.replace("/", "\\/")));
  }
});
