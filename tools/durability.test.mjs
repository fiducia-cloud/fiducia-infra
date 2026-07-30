// Static and rendered contracts for DEN-437. These tests prove the Kubernetes
// half of Raft durability; application-consistent export/restore remains gated
// in docs/raft-durability.md.

import assert from "node:assert/strict";
import { test } from "node:test";

import { readManifests, renderOverlay } from "./manifests.mjs";

const productionOverlays = ["clusters/civo", "clusters/hetzner", "clusters/vultr"];
const raftWorkloads = new Map([
  ["fiducia-node", "/var/lib/fiducia"],
  ["fiducia-brain", "/var/lib/fiducia-brain"],
]);

function statefulSet(documents, name, origin) {
  const workload = documents.find(
    (document) => document.kind === "StatefulSet" && document.metadata?.name === name,
  );
  assert.ok(workload, `${origin} must contain StatefulSet/${name}`);
  return workload;
}

function assertDurabilityContract(workload, expectedDataDir, origin, requireStorageClass) {
  const spec = workload.spec ?? {};
  assert.equal(spec.updateStrategy?.type, "OnDelete", `${origin} must fail closed on rollout`);
  assert.deepEqual(
    spec.persistentVolumeClaimRetentionPolicy,
    { whenDeleted: "Retain", whenScaled: "Retain" },
    `${origin} must retain PVCs on delete and scale-down`,
  );

  const claims = spec.volumeClaimTemplates ?? [];
  const dataClaim = claims.find((claim) => claim.metadata?.name === "data");
  assert.ok(dataClaim, `${origin} must declare the data PVC`);
  assert.deepEqual(dataClaim.spec?.accessModes, ["ReadWriteOnce"], `${origin} needs RWO storage`);
  assert.match(
    dataClaim.spec?.resources?.requests?.storage ?? "",
    /^[1-9][0-9]*(?:Mi|Gi|Ti)$/,
    `${origin} must request non-zero storage`,
  );
  if (requireStorageClass) {
    assert.match(
      dataClaim.spec?.storageClassName ?? "",
      /\S/,
      `${origin} must render an explicit storageClassName`,
    );
  }

  const containers = spec.template?.spec?.containers ?? [];
  const primary = containers.find((container) =>
    (container.env ?? []).some((entry) => entry.name === "FIDUCIA_DATA_DIR"),
  );
  assert.ok(primary, `${origin} must configure FIDUCIA_DATA_DIR`);
  const dataDir = primary.env.find((entry) => entry.name === "FIDUCIA_DATA_DIR")?.value;
  assert.equal(dataDir, expectedDataDir, `${origin} has the wrong durable data directory`);
  assert.ok(
    (primary.volumeMounts ?? []).some(
      (mount) => mount.name === "data" && mount.mountPath === expectedDataDir,
    ),
    `${origin} must mount the data PVC at FIDUCIA_DATA_DIR`,
  );

  const volumes = spec.template?.spec?.volumes ?? [];
  assert.equal(
    volumes.find((volume) => volume.name === "data")?.emptyDir,
    undefined,
    `${origin} must never shadow the data PVC with emptyDir`,
  );
  const writableScratchMounts = containers
    .flatMap((container) => container.volumeMounts ?? [])
    .filter((mount) => mount.mountPath === "/tmp");
  assert.ok(writableScratchMounts.length > 0, `${origin} should keep scratch writes on /tmp`);
}

test("base Raft StatefulSets retain durable PVCs", () => {
  const base = [
    ...readManifests("base/node/statefulset.yaml"),
    ...readManifests("base/components/brain/statefulset.yaml"),
  ];
  for (const [name, dataDir] of raftWorkloads) {
    assertDurabilityContract(statefulSet(base, name, "base"), dataDir, `base ${name}`, false);
  }
});

for (const overlay of productionOverlays) {
  test(`${overlay} renders explicit retained Raft storage`, () => {
    const documents = renderOverlay(overlay);
    for (const [name, dataDir] of raftWorkloads) {
      assertDurabilityContract(
        statefulSet(documents, name, overlay),
        dataDir,
        `${overlay} ${name}`,
        true,
      );
    }
  });
}

test("backup documentation refuses unsafe PVC copying and defines clean-room proof", async () => {
  const { readFile } = await import("node:fs/promises");
  const documentation = await readFile(
    new URL("../docs/raft-durability.md", import.meta.url),
    "utf8",
  );

  assert.match(documentation, /does not ship a CronJob that copies\s+live PVC files/);
  assert.match(documentation, /application-coordinated export and restore validation API/);
  assert.match(documentation, /fencing-token high-water marks/);
  assert.match(documentation, /Restore always targets an empty generation/);
  assert.match(documentation, /revisions, CAS conflicts, auth key records/);
});
