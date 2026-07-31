import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  assertCommitRevision,
  assertLaptopCluster,
  laptopClusters,
  renderLaptopGitOps,
} from "./render-laptop-gitops.mjs";

const revision = "a".repeat(40);

test("laptop GitOps renderer exposes exactly the three independent clusters", () => {
  assert.deepEqual(laptopClusters().sort(), [
    "laptop-aws-sim",
    "laptop-azure-sim",
    "laptop-gcp-sim",
  ]);
});

test("production root applications are local, immutable, secret-free, and manual-sync", () => {
  for (const cluster of laptopClusters()) {
    const yaml = renderLaptopGitOps(cluster, revision);
    assert.match(yaml, /kind: AppProject/);
    assert.match(yaml, /kind: Application/);
    assert.match(yaml, new RegExp(`name: fiducia-${cluster}`));
    assert.match(yaml, new RegExp(`targetRevision: ${revision}`));
    assert.match(yaml, new RegExp(`path: laptop/clusters/${cluster}`));
    assert.match(yaml, /repoURL: https:\/\/github\.com\/fiducia-cloud\/fiducia-infra\.git/);
    assert.match(yaml, /server: https:\/\/kubernetes\.default\.svc/);
    assert.doesNotMatch(yaml, /server: ["']?\*["']?/);
    assert.doesNotMatch(yaml, /targetRevision: (main|dev|master|HEAD)\b/i);
    assert.doesNotMatch(yaml, /kind: Secret/);
    assert.doesNotMatch(yaml, /\n\s+automated:/);
    assert.match(yaml, /PruneLast=true/);
    assert.match(yaml, /ApplyOutOfSyncOnly=true/);
  }
});

test("mutable or abbreviated revisions fail closed", () => {
  for (const value of ["main", "HEAD", "abc1234", "g".repeat(40), "a".repeat(39), "a".repeat(41)]) {
    assert.throws(() => assertCommitRevision(value), /exact 40-character Git commit SHA/);
  }
  assert.equal(assertCommitRevision("ABCDEF0123456789ABCDEF0123456789ABCDEF01"), "abcdef0123456789abcdef0123456789abcdef01");
});

test("unknown clusters cannot receive a production root", () => {
  assert.throws(() => assertLaptopCluster("laptop-random-sim"), /unknown laptop cluster/);
  assert.throws(() => renderLaptopGitOps("laptop-random-sim", revision), /unknown laptop cluster/);
});

test("bootstrap consumes only local checksum-verified install and secret inputs", () => {
  const script = fs.readFileSync(new URL("../scripts/bootstrap-laptop-gitops.sh", import.meta.url), "utf8");
  assert.match(script, /sha256sum/);
  assert.match(script, /--argocd-install/);
  assert.match(script, /--repo-secret/);
  assert.match(script, /--server-side --dry-run=server/);
  assert.match(script, /fiducia\.cloud\/substrate=laptop-k3s/);
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b/);
});

test("promotion separates stateless and stateful resources and guards leader order", () => {
  const script = fs.readFileSync(new URL("../scripts/promote-laptop-cluster.sh", import.meta.url), "utf8");
  assert.match(script, /--phase stateless\|stateful/);
  assert.match(script, /apps:Deployment:\*/);
  assert.match(script, /apps:StatefulSet:\*/);
  assert.match(script, /--ack-one-member-at-a-time/);
  assert.match(script, /--ack-leader-last/);
  assert.match(script, /followers before leader/);
  assert.match(script, /--prune=false/);
});
