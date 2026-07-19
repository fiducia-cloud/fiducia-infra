import { pathToFileURL } from "node:url";

export const VCLUSTER_NAMES = [
  "hetzner-fsn1",
  "hetzner-nbg1",
  "hetzner-hel1",
];

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactClusterKeys(value, label) {
  assertRecord(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...VCLUSTER_NAMES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalTopologyLabel(labels, key, expected, nodeName) {
  if (!(key in labels)) return;
  const actual = requiredString(labels[key], `${nodeName} ${key} label`);
  if (actual !== expected) {
    throw new Error(`${nodeName} ${key} label is ${actual}, expected ${expected}`);
  }
}

/**
 * Bind the selected Kubernetes Nodes to authoritative Hetzner server inventory.
 * Region is Hetzner's network zone (eu-central); zone is its location
 * (fsn1/nbg1/hel1). Kubernetes topology labels are checked when present, but
 * cloud inventory remains the required source because existing hosts may not
 * have been labelled by cloud-controller-manager.
 */
export function validateVclusterHost({
  nodes,
  hcloudServers,
  nodeMap,
  expectedFailureDomains,
}) {
  if (!Array.isArray(nodes?.items)) {
    throw new Error("Kubernetes Node inventory must contain an items array");
  }
  if (!Array.isArray(hcloudServers)) {
    throw new Error("hcloud inventory must be the JSON array returned by hcloud server list -o json");
  }
  assertExactClusterKeys(nodeMap, "node map");
  assertExactClusterKeys(expectedFailureDomains, "expected failure-domain map");

  const selected = {};
  const providerIds = new Set();
  for (const cluster of VCLUSTER_NAMES) {
    const nodeName = requiredString(nodeMap[cluster], `${cluster} Node name`);
    const matches = nodes.items.filter((node) => node?.metadata?.name === nodeName);
    if (matches.length !== 1) {
      throw new Error(`${cluster} target Node ${nodeName} must appear exactly once`);
    }
    const node = matches[0];
    const ready = node?.status?.conditions?.some(
      (condition) => condition?.type === "Ready" && condition?.status === "True",
    );
    if (!ready || node?.spec?.unschedulable === true) {
      throw new Error(`${cluster} target Node ${nodeName} is NotReady or cordoned`);
    }

    const labels = node?.metadata?.labels ?? {};
    assertRecord(labels, `${nodeName} labels`);
    const hostname = requiredString(labels["kubernetes.io/hostname"], `${nodeName} hostname label`);
    const nodeUid = requiredString(node?.metadata?.uid, `${nodeName} UID`);
    const providerId = requiredString(node?.spec?.providerID, `${nodeName} providerID`);
    const providerMatch = /^hcloud:\/\/([1-9][0-9]*)$/.exec(providerId);
    if (!providerMatch) {
      throw new Error(`${nodeName} providerID must be hcloud:// followed by a positive numeric server ID`);
    }
    if (providerIds.has(providerId)) {
      throw new Error(`selected Nodes must have three distinct hcloud:// provider IDs; repeated ${providerId}`);
    }
    providerIds.add(providerId);

    const serverId = providerMatch[1];
    const serverMatches = hcloudServers.filter((server) => String(server?.id) === serverId);
    if (serverMatches.length !== 1) {
      throw new Error(`${providerId} must resolve exactly once in the supplied hcloud inventory`);
    }
    const server = serverMatches[0];
    const expected = expectedFailureDomains[cluster];
    assertRecord(expected, `${cluster} expected failure domain`);
    const expectedRegion = requiredString(expected.region, `${cluster} expected region`);
    const expectedZone = requiredString(expected.zone, `${cluster} expected zone`);
    // Current hcloud CLI list output exposes location at the top level. Accept
    // the nested API representation too so a reviewed API capture is usable.
    const location = server?.location ?? server?.datacenter?.location;
    const region = requiredString(location?.network_zone, `${providerId} Hetzner network zone`);
    const zone = requiredString(location?.name, `${providerId} Hetzner location`);
    if (region !== expectedRegion || zone !== expectedZone) {
      throw new Error(
        `${providerId} resolves to region/zone ${region}/${zone}, expected ${expectedRegion}/${expectedZone} for ${cluster}`,
      );
    }
    optionalTopologyLabel(labels, "topology.kubernetes.io/region", expectedRegion, nodeName);
    optionalTopologyLabel(labels, "topology.kubernetes.io/zone", expectedZone, nodeName);

    selected[cluster] = {
      node: nodeName,
      node_uid: nodeUid,
      hostname,
      provider_id: providerId,
      hcloud_server_id: serverId,
      hcloud_server_name: requiredString(server?.name, `${providerId} hcloud server name`),
      region,
      zone,
    };
  }

  if (providerIds.size !== VCLUSTER_NAMES.length) {
    throw new Error("selected Nodes must have three distinct hcloud:// provider IDs");
  }
  return selected;
}

async function runCli() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const parsed = JSON.parse(input);
  process.stdout.write(`${JSON.stringify(validateVclusterHost(parsed))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
