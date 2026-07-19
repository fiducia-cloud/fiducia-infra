# Hetzner locks/leases proof fleet (three vClusters, zero new servers)

This is the default Hetzner-only proof topology. It installs three isolated
[vCluster](https://www.vcluster.com/docs) control planes on three distinct Nodes
of the existing five-node `dd-k8s-*` kubeadm cluster:

| Logical cluster | Default host Node | Expected region / zone | Host namespace | Local API |
|---|---|---|---|---|
| `hetzner-fsn1` | `dd-k8s-fsn1` | `eu-central` / `fsn1` | `fiducia-vc-fsn1` | `https://127.0.0.1:18403` |
| `hetzner-nbg1` | `dd-k8s-nbg1` | `eu-central` / `nbg1` | `fiducia-vc-nbg1` | `https://127.0.0.1:18404` |
| `hetzner-hel1` | `dd-k8s-hel1` | `eu-central` / `hel1` | `fiducia-vc-hel1` | `https://127.0.0.1:18405` |

No Hetzner servers, networks, public load balancers, or NodePorts are created.
The optional three-VM Terraform profile is a future physical-isolation path and
is disabled by default.

## What this proves

Each tenant has its own Kubernetes API, datastore, namespace/RBAC boundary,
cluster UID, resource quota, limit range, and default-deny network policy. The
three control planes and all synced tenant workloads are pinned to three
distinct host Nodes. vCluster service replication gives the three Fiducia node
and brain members stable, private cross-tenant Raft addresses.

The strict `fiducia-e2e` proof records the virtual Kubernetes UID, API endpoint,
visible Node UID/provider ID/region/zone, workload `nodeName`, and Fiducia member
identity, then tests lock exclusion, lease fencing/expiry, cross-endpoint
visibility, and quorum behavior.

This is **logical isolation on one physical kubeadm cluster**. It exercises
three Kubernetes control planes and three region-pinned Fiducia members, but it
does not survive loss of the shared host control plane or reproduce independent
cloud networks. Use three physical clusters later for that stronger claim.

## Safety boundary

- All credentials, plans, rendered releases, kubeconfigs, and evidence stay
  outside Git under `~/.local/state/fiducia/hetzner-e2e` by default.
- Every host command requires an explicit kubeconfig or context. The scripts
  never fall back to the current kubectl context.
- The vCluster chart and every runtime image are version/digest pinned. A plan
  records the host UID, exact Node UIDs and `hcloud://` provider IDs, authoritative
  Hetzner region/zone evidence, source commit, and manifest hashes.
- Installation, workload deployment, and teardown each require distinct exact
  confirmation strings. Teardown also refuses to run before evidence capture.
- Access is through foreground loopback-only port forwards. No public service is
  created.
- The install and proof gates require clean, committed source checkouts.

## Prerequisites

Install `kubectl`, Helm 3, Node.js, `jq`, `openssl`, and `nc`. For location
verification, install `hcloud` with read-only access or provide a reviewed JSON
capture from `hcloud server list -o json`. The host cluster must have at least
three Ready, uncordoned Nodes, the `local-path` StorageClass, and a
NetworkPolicy-enforcing CNI.

Use an existing administrator kubeconfig whenever possible. If the only copy is
on a Hetzner control-plane host, retrieve it through a key already under
`~/.ssh`; keep the result outside the repository and verify the SSH host key:

```sh
export FIDUCIA_HETZNER_E2E_STATE_DIR="$HOME/.local/state/fiducia/hetzner-e2e"
export CONTROL_PLANE_HOST='reviewed-existing-hostname-or-address'
install -d -m 700 "$FIDUCIA_HETZNER_E2E_STATE_DIR"
ssh -i "$HOME/.ssh/id_hetzner" \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  root@"$CONTROL_PLANE_HOST" \
  'sudo cat /etc/kubernetes/admin.conf' \
  | tee "$FIDUCIA_HETZNER_E2E_STATE_DIR/host.kubeconfig" >/dev/null
chmod 600 "$FIDUCIA_HETZNER_E2E_STATE_DIR/host.kubeconfig"
export FIDUCIA_HOST_KUBECONFIG="$FIDUCIA_HETZNER_E2E_STATE_DIR/host.kubeconfig"
```

If that kubeconfig names a host-local API address, update only its `server`
field to a reviewed reachable private endpoint. Never commit or print it.

## Operator flow

First prove the selected host and three Node targets are suitable. Override the
default Node map only after inspecting actual Node names and capacity. Preflight
requires three distinct numeric `hcloud://` provider IDs and resolves each ID
against read-only Hetzner inventory. It requires `eu-central/fsn1`,
`eu-central/nbg1`, and `eu-central/hel1` respectively. Existing Kubernetes Nodes
are never relabelled; matching topology labels are checked when present, while
the authoritative provider-ID/location evidence covers hosts without those
labels.

```sh
export FIDUCIA_HOST_KUBECONFIG="$HOME/.local/state/fiducia/hetzner-e2e/host.kubeconfig"
# Optional: export FIDUCIA_VCLUSTER_NODE_MAP='{"hetzner-fsn1":"node-a","hetzner-nbg1":"node-b","hetzner-hel1":"node-c"}'
scripts/hetzner-e2e-vclusters.sh preflight
```

The default preflight runs only the read-only `hcloud server list -o json`
inventory call. To capture, review, and reuse that evidence explicitly, keep it
outside Git and point preflight at the absolute file:

```sh
hcloud server list -o json \
  | tee "$FIDUCIA_HETZNER_E2E_STATE_DIR/hcloud-servers.json" >/dev/null
chmod 600 "$FIDUCIA_HETZNER_E2E_STATE_DIR/hcloud-servers.json"
export FIDUCIA_HCLOUD_INVENTORY_FILE="$FIDUCIA_HETZNER_E2E_STATE_DIR/hcloud-servers.json"
scripts/hetzner-e2e-vclusters.sh preflight
```

If neither a successful live inventory query nor a reviewed external inventory
file is available, preflight fails closed before Helm or Kubernetes mutation.

Render an immutable, non-mutating plan. Review `plan.json` and all three YAML
files before installing anything:

```sh
PLAN_ID=hetzner-vcluster-proof-20260718
scripts/hetzner-e2e-vclusters.sh plan "$PLAN_ID"
FIDUCIA_CONFIRM_VCLUSTER_INSTALL=install-three-logical-vclusters-no-new-servers \
  scripts/hetzner-e2e-vclusters.sh install "$PLAN_ID"
scripts/hetzner-e2e-vclusters.sh status
```

Fetch the three tenant kubeconfigs, then keep the nine loopback port forwards
open in a dedicated terminal:

```sh
scripts/hetzner-e2e-fetch-vcluster-kubeconfigs.sh
scripts/hetzner-e2e-vcluster-tunnels.sh
```

In a second terminal, create two distinct high-entropy runtime secrets without
placing them in a manifest. Then render a release using exact GHCR digests:

```sh
export FIDUCIA_INTERNAL_SECRET="$(openssl rand -hex 32)"
export FIDUCIA_BRAIN_RAFT_SECRET="$(openssl rand -hex 32)"
scripts/hetzner-e2e-secrets.sh

export FIDUCIA_NODE_IMAGE='ghcr.io/fiducia-cloud/fiducia-node@sha256:<digest>'
export FIDUCIA_NODE_SIDECAR_IMAGE='ghcr.io/fiducia-cloud/fiducia-node-sidecar@sha256:<digest>'
export FIDUCIA_BRAIN_IMAGE='ghcr.io/fiducia-cloud/fiducia-brain@sha256:<digest>'
export FIDUCIA_LOAD_BALANCE_IMAGE='ghcr.io/fiducia-cloud/fiducia-load-balance@sha256:<digest>'
RELEASE_ID=locks-leases-proof-20260718
scripts/hetzner-e2e-vcluster-deploy.sh preflight
scripts/hetzner-e2e-vcluster-deploy.sh render "$RELEASE_ID"
```

Review the external rendered manifests and release metadata. Apply, verify, and
run the strict proof only after that review:

```sh
FIDUCIA_CONFIRM_DEPLOY=deploy-to-three-logical-vclusters \
  scripts/hetzner-e2e-vcluster-deploy.sh apply "$RELEASE_ID"
scripts/hetzner-e2e-vcluster-deploy.sh verify "$RELEASE_ID"
export FIDUCIA_E2E_ORG_ID='<dedicated-test-org-id>'
scripts/hetzner-e2e-vcluster-deploy.sh proof "$RELEASE_ID"
```

The proof prints the external evidence directory. `proof-input.json` binds the
exact bytes of `proof-topology.json` and `infra-evidence.json` by SHA-256; the
strict suite rehashes both before testing. Preserve those files and the proof
manifest before any teardown.

## Explicit teardown

Teardown removes only Helm releases and namespaces carrying this fleet's
ownership labels. It does not touch host Nodes or any Hetzner server:

```sh
FIDUCIA_CONFIRM_VCLUSTER_DESTROY=destroy-three-logical-vclusters \
FIDUCIA_CONFIRM_EVIDENCE_CAPTURED=evidence-captured \
  scripts/hetzner-e2e-vclusters.sh destroy
```

Do not use teardown as a substitute for restoring or deleting application data
inside a tenant; capture the evidence first and follow the operator's retention
policy for the external state directory.

## Pinned upstream inputs

- vCluster chart `0.35.1`, downloaded from the official Loft chart host and
  verified as SHA-256
  `ec1db9e9faf2da674eba5df3594b9d209861ee8e5889be850a9bb60861158c5b`.
- vCluster OSS `0.35.1`, Kubernetes `v1.36.0`, CoreDNS `v1.14.2`, and the small
  host-rewrite init image are pinned by immutable registry digest in
  [`values/common.yaml`](values/common.yaml).

CI re-renders all three chart profiles and workload overlays, checks the pinned
digests, rejects host NodePort/LoadBalancer Services, checks generated topology
freshness, and syntax-checks every operator script.
