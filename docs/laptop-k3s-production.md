# Three-laptop K3s production substrate

Status: implementation profile for **limited, pre-funding production/beta**. This
is not equivalent to managed cloud infrastructure and must not be sold as AWS,
GCP, or Azure hosting.

Linear parent: `DEN-941`.

## Decision

Run one independent, single-node K3s cluster on each of three dedicated laptops.
The clusters deliberately model three cloud failure domains:

| Cluster | Synthetic provider | Required physical site | Pod CIDR | Service CIDR |
|---|---|---|---|---|
| `laptop-aws-sim` | AWS | `site-a` | `10.41.0.0/16` | `10.81.0.0/16` |
| `laptop-gcp-sim` | GCP | `site-b` | `10.42.0.0/16` | `10.82.0.0/16` |
| `laptop-azure-sim` | Azure | `site-c` | `10.43.0.0/16` | `10.83.0.0/16` |

The provider names are behavior and placement labels only. The actual substrate
is `laptop-k3s`.

The Kubernetes control planes are **not** highly available. Each entire cluster
may disappear. Availability comes from application-level replication across the
three clusters:

- one `fiducia-node` voter per laptop;
- one `fiducia-brain` voter per laptop;
- one NATS/JetStream member per laptop;
- one stateless API/load-balancer replica per laptop;
- one outbound Cloudflare Tunnel connector per laptop;
- independent pull-based GitOps reconciliation per laptop.

The supported failure is loss of **one** laptop/site. Two simultaneous site
losses remove the 2-of-3 quorum and must stop authoritative writes.

## Non-negotiable launch boundary

Three laptops in one room behind one router and one utility circuit are one
physical failure domain. That arrangement is acceptable for bootstrap and test,
but not for a meaningful customer-facing availability claim.

Before limited production, prefer all of the following:

1. three distinct physical locations;
2. three distinct routers and WAN connections;
3. router/modem/switch power protected by a UPS;
4. wired Ethernet as the primary connection;
5. an independent LTE/5G or second-ISP recovery path where practical;
6. a named person who can physically restart or replace each host.

When these are not available, classify the environment explicitly as low-SLA
beta and reduce tenant count, data volume, and job concurrency.

## Repository layout

```text
laptop/
  topology.toml                         source of truth for the laptop profile
  clusters/<cluster>/                   Kustomize overlays + generated inputs
  components/substrate/                 laptop-only Service behavior
  hosts/<cluster>/k3s-config.yaml       generated K3s host configuration
  generated/edge-regions.json           generated public-origin catalog
tools/
  render-laptop-fleet.mjs               render/check command
  laptop-fleet.test.mjs                 safety and drift contracts
```

The canonical `topology.toml` remains the real-cloud profile. The laptop profile
is separate so pre-funding decisions do not silently rewrite the Hetzner/Vultr/
Civo production contract. Both profiles reuse `base/` and the same renderer.

Render and validate:

```sh
npm run render:laptop
npm run check:laptop
node --test tools/laptop-fleet.test.mjs
for cluster in laptop/clusters/*/; do kubectl kustomize "$cluster" >/dev/null; done
```

Generated files must not be edited by hand.

## Host baseline

Each laptop is a dedicated appliance, not a developer workstation.

Minimum practical baseline:

- 64-bit Linux;
- 4 CPU cores, 16 GiB RAM, and a healthy 500 GB-class SSD;
- full-disk encryption and Secure Boot where supported;
- wired Ethernet;
- battery health sufficient to act as a short UPS;
- no sleep, hibernate, or lid-close shutdown;
- key-only SSH on the private mesh;
- automatic clock synchronization;
- SMART/NVMe, disk-space, temperature, throttling, battery, fan, and WAN alerts;
- automatic restart after power restoration where firmware supports it;
- no personal browsing, CI builds, cryptocurrency workloads, or unrelated apps.

Manage host state declaratively with Nix/versioned automation: packages, users,
firewall, SSH policy, Tailscale/WireGuard, K3s version and config, mounts,
monitoring, backup jobs, power behavior, and watchdog settings.

Record actual CPU, RAM, disk health, battery health, firmware behavior, location,
ISP, upload bandwidth, CGNAT status, and physical access in `DEN-942` before
installation.

## K3s installation

The renderer creates one host file per laptop under
`laptop/hosts/<cluster>/k3s-config.yaml`. Install it as:

```text
/etc/rancher/k3s/config.yaml
```

The generated configuration intentionally:

- initializes a single-member embedded-etcd control plane;
- uses a unique Pod and Service CIDR;
- enables Kubernetes secret encryption at rest;
- disables bundled Traefik and ServiceLB;
- gives the Kubernetes API a private DNS SAN;
- labels the node with cluster, site, substrate, and synthetic provider;
- schedules embedded-etcd snapshots every six hours.

Install a repository-approved, immutable K3s version. Do not use an unpinned
`curl | sh` command in production. Keep the local-path provisioner enabled: the
laptop overlay uses encrypted host SSD storage through the `local-path` storage
class.

The three laptops are three independent clusters. Never join them into one
Kubernetes cluster over the WAN, and never stretch Ceph, Longhorn, GlusterFS, or
another synchronous block-storage layer across the sites.

## Private networking

Use Tailscale initially as the WireGuard control plane. Keep a documented plain
WireGuard configuration as the fallback.

Required private DNS records or equivalent MagicDNS names:

```text
k8s.<cluster>.fiducia.internal       Kubernetes API over the private mesh
brain.<cluster>.fiducia.internal     fiducia-brain peer port 9095
node.<cluster>.fiducia.internal      fiducia-node peer 9090 and API 8090
```

Expose only the exact services required for:

- operator SSH and Kubernetes API access;
- Fiducia node/brain peer traffic;
- NATS cluster or leaf-node traffic;
- telemetry and health checks;
- encrypted backup coordination.

Use deny-by-default ACLs. Workload identities must not gain arbitrary access to
operator devices or the host's home LAN. The private mesh is defense in depth,
not a substitute for TLS/mTLS, service authentication, fencing, or NetworkPolicy.

No router should publish SSH, Kubernetes, NATS, Raft, databases, or NodePorts.

## Public ingress

The laptop substrate component changes `fiducia-load-balance` from
`LoadBalancer` to `ClusterIP`. This prevents K3s ServiceLB from binding public
host ports.

Run one outbound Cloudflare Tunnel connector in each cluster. Each connector may
reach only its local `fiducia-load-balance` Service. Public hostnames are declared
in `laptop/topology.toml` and rendered into
`laptop/generated/edge-regions.json`.

Do not commit tunnel credentials. Provision them through the approved SOPS/age
bootstrap and External Secrets/Fiducia secret-delivery path. Validate trusted
proxy headers and add black-box probes from at least two independent external
locations.

## GitOps and promotion

Run one pull-based Argo CD installation in each laptop cluster. A cluster must
continue reconciling when either of the other laptops is offline.

Production must remain revision-pinned. Do not point a production Application at
mutable `fiducia-infra/main`. Promote a reviewed commit/image digest through the
canonical application registry in `DEN-630`, or pin the exact 40-character Git
commit during bootstrap until that registry supports the laptop overlays.

Roll out stateless services one cluster at a time. Stateful and quorum changes
require a manual gate:

1. verify all three members are healthy and caught up;
2. remove one follower cluster from public traffic;
3. update/restart that follower only;
4. wait for full catch-up;
5. repeat for the second follower;
6. transfer/restart the leader last.

Never allow unattended host, K3s, Fiducia, or JetStream upgrades across all
three laptops in the same maintenance window.

## State and durability

Authoritative-state boundaries remain unchanged:

- Fiducia coordination state: durable local PVC plus cross-cluster Raft;
- workflow/application state: managed PostgreSQL/Supabase with outbox/inbox and
  idempotency records;
- messaging: NATS/JetStream for durable delivery and replay, not the only system
  of record;
- desired state: Git and immutable image digests;
- backups and large artifacts: independent S3-compatible object storage.

Every laptop uses encrypted local SSD-backed PVCs. Backups must leave the host:

- K3s embedded-etcd snapshots;
- encrypted Fiducia Raft snapshots/WAL;
- managed database PITR or encrypted logical dumps;
- critical JetStream snapshots, while retaining database replay;
- offline recovery material that is not stored on any production laptop.

A backup is not accepted until a clean replacement host has restored it.

## Secrets and device loss

Fiducia cannot be the only system holding the material required to start
Fiducia. Bootstrap only the minimum mesh, Git/registry, and external secret-store
credentials with SOPS and age:

- one distinct recipient per laptop;
- one offline recovery recipient;
- no shared private key copied to all three machines.

For a lost or stolen laptop, revoke and rotate at least:

- Tailscale/WireGuard identity;
- SSH/operator identity;
- Git deploy and registry credentials;
- TLS/mTLS identity;
- SOPS recipient;
- Cloudflare connector identity;
- runtime secret-store access;
- Fiducia and JetStream membership.

Never reuse the removed Raft or NATS member identity for replacement hardware.

## Monitoring and capacity limits

Alert on:

- external HTTP availability and latency per public origin;
- Cloudflare connector count and failures;
- pairwise private-mesh packet loss and latency;
- Fiducia leader, quorum, member lag, election churn, snapshot age, and fencing;
- JetStream replica health, storage, consumer lag, redelivery, and DLQ depth;
- Kubernetes API health, restarts, scheduling, PVC use, and image pulls;
- CPU, memory, I/O latency, disk wear/health, disk usage, temperature,
  throttling, fan, battery, clock drift, and WAN state;
- backup completion, backup age, upload failure, and restore-test age.

Start with conservative operating limits. Trigger migration or capacity work at
60% sustained safe CPU, memory, storage, I/O, or upload bandwidth—not at 100%.

## Required acceptance campaign

`DEN-946` is the launch gate. At minimum, prove all of the following on the
physical fleet:

- power off each follower and the current leader in separate tests;
- disconnect each WAN and exercise backup connectivity;
- inject an asymmetric private-mesh partition;
- stop a Cloudflare connector, K3s API, Fiducia member, JetStream member, disk
  mount, and telemetry path independently;
- test disk pressure, bounded clock drift, thermal pressure, failed image pull,
  and interrupted upgrade;
- rebuild one replacement laptop from versioned host config, Git, and backups;
- revoke a simulated stolen device across every trust system;
- restore K3s, Fiducia, database, and messaging state in a clean-room exercise;
- run at least seven consecutive days of representative traffic and bounded fault
  injection.

Launch only when one-laptop loss preserves public traffic, safe 2-of-3 Fiducia
quorum, acknowledged critical-message behavior, and fencing/idempotency for
protected external mutations.

## Cloud migration

The profile intentionally retains `cluster_id = "fiducia-prod"`, the production
shard count, the shared base manifests, and the same application contract. This
allows a rolling exit rather than a rewrite:

1. add one real-cloud cluster overlay to the canonical registry;
2. establish networking, trust, GitOps, telemetry, storage, and backups;
3. add one new cloud Fiducia member and remove one laptop member while preserving
   an odd quorum;
4. repeat one member at a time;
5. replace JetStream members only after catch-up and replay verification;
6. shift stateless public origins progressively;
7. retain laptops as rollback capacity for a measured soak window;
8. revoke identities and securely wipe retired hosts.

Move off the laptops when funding/credits support six months of infrastructure,
a customer requires a contractual SLO or data-center controls, sustained load
crosses the safe threshold, physical/ISP incidents breach recovery targets, or
manual intervention becomes recurring operational work.
