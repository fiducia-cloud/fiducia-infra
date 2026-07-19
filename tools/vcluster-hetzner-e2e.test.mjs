import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  loadVclusterHetznerE2eTopology,
  renderVclusterHetznerE2e,
} from "./render-vcluster-hetzner-e2e.mjs";
import { CORE_IMAGES, renderRelease } from "./render-hetzner-e2e-release.mjs";
import { validateVclusterHost } from "./validate-vcluster-host.mjs";
import { validateVclusterManifest } from "./validate-vcluster-manifest.mjs";

const root = new URL("../", import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, root), "utf8");
const readJson = (relative) => JSON.parse(read(relative));

const NODE_MAP = {
  "hetzner-fsn1": "dd-k8s-fsn1",
  "hetzner-nbg1": "dd-k8s-nbg1",
  "hetzner-hel1": "dd-k8s-hel1",
};
const EXPECTED_FAILURE_DOMAINS = {
  "hetzner-fsn1": { region: "eu-central", zone: "fsn1" },
  "hetzner-nbg1": { region: "eu-central", zone: "nbg1" },
  "hetzner-hel1": { region: "eu-central", zone: "hel1" },
};

test("vCluster topology is exactly three logical Hetzner members", () => {
  const topology = loadVclusterHetznerE2eTopology();
  assert.deepEqual(topology.cluster.map(({ name }) => name), [
    "hetzner-fsn1",
    "hetzner-nbg1",
    "hetzner-hel1",
  ]);
  assert.equal(topology.replication_factor, 3);
  assert.equal(topology.auth_required, true);
  assert.ok(topology.cluster.every(({ platform, node_replicas, brain, storage_class }) =>
    platform === "vcluster" && node_replicas === 1 && brain === true && storage_class === "local-path"));
});

test("each logical member has two replicated-service peers and excludes itself", () => {
  const files = renderVclusterHetznerE2e();
  for (const cluster of ["hetzner-fsn1", "hetzner-nbg1", "hetzner-hel1"]) {
    const short = cluster.replace("hetzner-", "");
    const env = files[`vcluster/hetzner-e2e/clusters/${cluster}/topology.env`];
    const nodePeers = env.match(/^FIDUCIA_PEERS=(.*)$/m)[1].split(",");
    const brainPeers = env.match(/^FIDUCIA_BRAIN_PEERS=(.*)$/m)[1].split(",");
    assert.equal(nodePeers.length, 2);
    assert.equal(brainPeers.length, 2);
    assert.ok(nodePeers.every((peer) => !peer.includes(`-${short}.`)));
    assert.ok(brainPeers.every((peer) => !peer.includes(`-${short}.`)));
  }
});

test("checked-in vCluster topology render is byte-for-byte current", () => {
  for (const [relative, expected] of Object.entries(renderVclusterHetznerE2e())) {
    assert.equal(read(relative), expected, `${relative} is stale`);
  }
});

test("vCluster values pin official images and enable isolation without host exposure", () => {
  const values = read("vcluster/hetzner-e2e/values/common.yaml");
  assert.match(values, /repository: loft-sh\/vcluster-oss/);
  assert.match(values, /tag: 0\.35\.1@sha256:[0-9a-f]{64}/);
  assert.match(values, /repository: loft-sh\/kubernetes/);
  assert.match(values, /tag: v1\.36\.0@sha256:[0-9a-f]{64}/);
  assert.match(values, /podSecurityStandard: restricted/);
  assert.match(values, /networkPolicy:\n\s+enabled: true/);
  assert.match(values, /publicEgress: \{ enabled: false \}/);
  assert.match(values, /services\.nodeports: "0"/);
  assert.match(values, /services\.loadbalancers: "0"/);
  assert.match(values, /podAntiAffinity:\n\s+requiredDuringSchedulingIgnoredDuringExecution:/);
  assert.match(values, /storageClass: local-path/);
});

test("rendered vCluster datastore is pinned to local-path with a 5Gi request", () => {
  const fixture = `
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: fiducia-hetzner-fsn1
spec:
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 5Gi
        storageClassName: local-path
`;
  assert.equal(validateVclusterManifest(fixture, "fiducia-hetzner-fsn1"), true);
  assert.throws(
    () => validateVclusterManifest(fixture.replace("local-path", "gp3"), "fiducia-hetzner-fsn1"),
    /storageClassName: local-path/,
  );
  assert.throws(
    () => validateVclusterManifest(fixture.replace("5Gi", "10Gi"), "fiducia-hetzner-fsn1"),
    /5Gi storage request/,
  );
});

test("service replication defines stable cross-vCluster peer bridges", () => {
  for (const cluster of ["hetzner-fsn1", "hetzner-nbg1", "hetzner-hel1"]) {
    const values = read(`vcluster/hetzner-e2e/values/${cluster}.yaml`);
    assert.equal((values.match(/^\s+- from: fiducia\/fiducia-(?:node|brain)$/gm) ?? []).length, 2);
    assert.equal((values.match(/^\s+- from: fiducia-vc-/gm) ?? []).length, 4);
    assert.doesNotMatch(values, /NodePort|LoadBalancer/);
  }
});

test("release renderer makes all Fiducia workload references immutable", () => {
  const imageRefs = Object.fromEntries(
    Object.entries(CORE_IMAGES).map(([key, repository], index) => [
      key,
      `${repository}@sha256:${String(index + 1).repeat(64)}`,
    ]),
  );
  const releases = renderRelease(imageRefs, { profile: "vcluster" });
  assert.equal(Object.keys(releases).length, 3);
  for (const manifest of Object.values(releases)) {
    assert.doesNotMatch(manifest, /^kind:\s*Secret$/m);
    assert.doesNotMatch(manifest, /^\s*type:\s*(NodePort|LoadBalancer)\s*$/m);
    const coreLines = manifest.split("\n").filter((line) => line.includes("ghcr.io/fiducia-cloud/"));
    assert.equal(coreLines.length, 5);
    assert.ok(coreLines.every((line) => /@sha256:[0-9a-f]{64}$/.test(line)));
    assert.equal((manifest.match(/^\s*- name: fiducia-ghcr-pull$/gm) ?? []).length, 3);
  }
});

test("host gate binds three distinct hcloud provider IDs to expected locations", () => {
  const nodes = readJson("tools/fixtures/vcluster-host-nodes.json");
  const hcloudServers = readJson("tools/fixtures/vcluster-host-hcloud-servers.json");
  const selected = validateVclusterHost({
    nodes,
    hcloudServers,
    nodeMap: NODE_MAP,
    expectedFailureDomains: EXPECTED_FAILURE_DOMAINS,
  });

  assert.deepEqual(
    Object.values(selected).map(({ provider_id }) => provider_id),
    ["hcloud://139855460", "hcloud://139855544", "hcloud://139855672"],
  );
  assert.deepEqual(
    Object.values(selected).map(({ region, zone }) => `${region}/${zone}`),
    ["eu-central/fsn1", "eu-central/nbg1", "eu-central/hel1"],
  );

  const duplicateProvider = structuredClone(nodes);
  duplicateProvider.items[2].spec.providerID = "hcloud://139855544";
  assert.throws(
    () => validateVclusterHost({
      nodes: duplicateProvider,
      hcloudServers,
      nodeMap: NODE_MAP,
      expectedFailureDomains: EXPECTED_FAILURE_DOMAINS,
    }),
    /three distinct hcloud:\/\/ provider IDs/,
  );

  const wrongProvider = structuredClone(nodes);
  wrongProvider.items[0].spec.providerID = "aws:///i-not-hetzner";
  assert.throws(
    () => validateVclusterHost({
      nodes: wrongProvider,
      hcloudServers,
      nodeMap: NODE_MAP,
      expectedFailureDomains: EXPECTED_FAILURE_DOMAINS,
    }),
    /providerID must be hcloud:\/\//,
  );

  const wrongLocation = structuredClone(hcloudServers);
  wrongLocation[2].location.name = "nbg1";
  assert.throws(
    () => validateVclusterHost({
      nodes,
      hcloudServers: wrongLocation,
      nodeMap: NODE_MAP,
      expectedFailureDomains: EXPECTED_FAILURE_DOMAINS,
    }),
    /expected eu-central\/hel1/,
  );
});

test("tenant kubeconfig rewrite selects the source context before renaming it", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fiducia-vcluster-kubeconfig-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  const stateDir = path.join(temporaryRoot, "state");
  const kubectlLog = path.join(temporaryRoot, "kubectl.log");
  fs.mkdirSync(fakeBin);

  const fakeKubectl = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "args=(\"$@\")",
    "if [[ \"${args[0]:-}\" == --context=* || \"${args[0]:-}\" == --kubeconfig=* ]]; then args=(\"${args[@]:1}\"); fi",
    "if [[ \"${args[0]:-}\" == get && \"${args[1]:-}\" == namespace ]]; then",
    "  namespace=${args[2]}",
    "  if [[ \"${args[*]}\" == *vcluster-fleet* ]]; then printf 'hetzner-e2e'; exit 0; fi",
    "  case \"$namespace\" in",
    "    fiducia-vc-fsn1) printf 'hetzner-fsn1' ;;",
    "    fiducia-vc-nbg1) printf 'hetzner-nbg1' ;;",
    "    fiducia-vc-hel1) printf 'hetzner-hel1' ;;",
    "    *) exit 41 ;;",
    "  esac",
    "  exit 0",
    "fi",
    "if [[ \"${args[0]:-}\" == -n && \"${args[2]:-}\" == get && \"${args[3]:-}\" == secret ]]; then printf 'fixture-encoded-config'; exit 0; fi",
    "if [[ \"${args[0]:-}\" == config && \"${args[1]:-}\" == current-context ]]; then printf 'source-context\\n'; exit 0; fi",
    "if [[ \"${args[0]:-}\" == config && \"${args[1]:-}\" == view ]]; then command cat \"$FIXTURE_CONFIG_VIEW\"; exit 0; fi",
    "if [[ \"${args[0]:-}\" == config && \"${args[1]:-}\" == set-cluster ]]; then printf 'set %s %s\\n' \"${args[2]}\" \"${args[3]}\" >>\"$FAKE_KUBECTL_LOG\"; exit 0; fi",
    "if [[ \"${args[0]:-}\" == config && \"${args[1]:-}\" == rename-context ]]; then printf 'rename %s %s\\n' \"${args[2]}\" \"${args[3]}\" >>\"$FAKE_KUBECTL_LOG\"; exit 0; fi",
    "printf 'unexpected fake kubectl invocation: %s\\n' \"${args[*]}\" >&2",
    "exit 42",
    "",
  ].join("\n");
  const fakeBase64 = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' 'apiVersion: v1' 'kind: Config'",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(fakeBin, "kubectl"), fakeKubectl, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "base64"), fakeBase64, { mode: 0o755 });

  const result = spawnSync(
    "bash",
    [fileURLToPath(new URL("scripts/hetzner-e2e-fetch-vcluster-kubeconfigs.sh", root))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FIDUCIA_HOST_CONTEXT: "fixture-host",
        FIDUCIA_HOST_KUBECONFIG: "",
        FIDUCIA_HETZNER_E2E_STATE_DIR: stateDir,
        FIXTURE_CONFIG_VIEW: fileURLToPath(new URL("tools/fixtures/vcluster-kubeconfig-view.json", root)),
        FAKE_KUBECTL_LOG: kubectlLog,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(kubectlLog, "utf8").trim().split("\n");
  assert.deepEqual(
    calls.filter((call) => call.startsWith("set ")).map((call) => call.split(" ")[1]),
    ["source-cluster", "source-cluster", "source-cluster"],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("rename ")),
    [
      "rename source-context fiducia-e2e-hetzner-fsn1",
      "rename source-context fiducia-e2e-hetzner-nbg1",
      "rename source-context fiducia-e2e-hetzner-hel1",
    ],
  );
});

test("operator scripts fail closed on context, identity, install, and destroy", () => {
  const lifecycle = read("scripts/hetzner-e2e-vclusters.sh");
  const deploy = read("scripts/hetzner-e2e-vcluster-deploy.sh");
  const secrets = read("scripts/hetzner-e2e-secrets.sh");
  const tunnels = read("scripts/hetzner-e2e-vcluster-tunnels.sh");
  const hostValidator = read("tools/validate-vcluster-host.mjs");
  assert.match(lifecycle, /current-context fallback is forbidden/);
  assert.match(lifecycle, /install-three-logical-vclusters-no-new-servers/);
  assert.match(lifecycle, /destroy-three-logical-vclusters/);
  assert.match(lifecycle, /three distinct Node names/);
  assert.match(hostValidator, /three distinct hcloud:\/\/ provider IDs/);
  assert.match(lifecycle, /expected_failure_domains: \$expected_failure_domains/);
  assert.match(lifecycle, /host_nodes: \$host_nodes/);
  assert.match(lifecycle, /"hetzner-fsn1":"dd-k8s-fsn1"/);
  assert.match(lifecycle, /source\.dirty == false/);
  assert.match(lifecycle, /no longer renders byte-for-byte like the reviewed plan/);
  assert.match(lifecycle, /upgrade-owned-three-vcluster-fleet/);
  assert.match(lifecycle, /refusing to adopt pre-existing or mismatched namespace/);
  assert.match(deploy, /three distinct virtual Kubernetes UIDs/);
  assert.match(deploy, /isolationMode: "logical"/);
  assert.match(deploy, /kubernetesDistribution: "vcluster"/);
  assert.match(deploy, /FIDUCIA_E2E_INFRA_ATTESTATION_FILE/);
  assert.match(deploy, /topology: \{file: "proof-topology\.json", sha256: \$topology_sha\}/);
  assert.match(deploy, /infra_evidence: \{file: "infra-evidence\.json", sha256: \$infra_sha\}/);
  assert.match(secrets, /FIDUCIA_GHCR_TOKEN is required/);
  assert.match(secrets, /kubernetes\.io\/dockerconfigjson/);
  assert.match(tunnels, /api\|workloads\|all/);
  assert.match(tunnels, /deploy the release before workload tunnels/);
});
