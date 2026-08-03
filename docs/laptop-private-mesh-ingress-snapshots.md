# Laptop private mesh, outbound ingress, and K3s snapshot recovery

Governing issue: `DEN-943`.

This document defines the software contract for connecting the three independent
laptop K3s clusters, publishing customer HTTP traffic without router port
forwarding, copying K3s control-plane snapshots off-host, and restoring one clean
replacement laptop.

It does not claim that a physical laptop, tailnet, Cloudflare tunnel, object
bucket, or restore drill already exists. Live installation and evidence remain
required in `DEN-942`, `DEN-943`, and `DEN-946`.

## Security boundary

The design uses several independent controls:

- the `fiducia` namespace already has default-deny ingress and egress;
- Tailscale grants restrict operator and cross-cluster peer identities;
- Fiducia node and brain peer planes retain their own application authentication;
- Cloudflare Tunnel is outbound-only and may reach only the local internal load
  balancer;
- Kubernetes and runtime credentials are supplied from private files and are not
  stored in Git;
- K3s S3 snapshot credentials are loaded from a Kubernetes Secret rather than
  embedded in `/etc/rancher/k3s/config.yaml`;
- restore uses a checksum-verified local snapshot and the independently recovered
  original K3s server token.

The VPN, Kubernetes NetworkPolicy, and application authentication are
complementary. None should be removed merely because another layer exists.

## Public HTTP ingress

Every laptop overlay includes `laptop/components/runtime`, which deploys one
`fiducia-cloudflared` connector.

The connector:

- uses the exact `cloudflare/cloudflared:2026.7.3` release tag and disables
  in-process auto-update;
- reads only `cloudflare-tunnel-token/token` from a required Secret;
- has no service-account token;
- runs as a non-root user with a read-only root filesystem, no Linux
  capabilities, no privilege escalation, and the runtime-default seccomp
  profile;
- exposes only its local metrics/readiness listener on port 2000;
- receives no public inbound connection;
- may reach the local `fiducia-load-balance` pods on port 8088;
- may establish Cloudflare Tunnel transport on TCP or UDP port 7844;
- has a `maxUnavailable: 0` PodDisruptionBudget because the cluster has only one
  connector.

The laptop substrate continues to patch `fiducia-load-balance` to `ClusterIP`.
K3s ServiceLB and bundled Traefik remain disabled, so the host does not publish a
NodePort, host port, or cloud-style LoadBalancer.

Configure the remotely managed Cloudflare route for each connector so its origin
is the local service only:

```text
http://fiducia-load-balance-internal.fiducia.svc.cluster.local:8088
```

Do not route the tunnel to the node API, brain control plane, NATS, Kubernetes
API, SSH, metrics endpoints, or any home-LAN address.

### Connector identity

Use a distinct connector token or separately revocable tunnel identity per
laptop. A stolen or retired laptop must be removable without rotating every
healthy connector in the fleet. The token is supplied through
`scripts/apply-laptop-runtime-secrets.sh`; never put it in an Argo CD
Application, ConfigMap, shell argument, CI variable dump, Linear comment, or Git
history.

### External health

Cloudflare connector readiness proves only that the connector process can serve
its local readiness endpoint. Production acceptance additionally requires:

- an external HTTPS probe for each laptop origin;
- at least two independent probe regions;
- verification that an unhealthy local origin is withdrawn;
- verification that the two remaining clusters serve traffic when one laptop or
  ISP disappears;
- trusted-proxy validation so arbitrary clients cannot forge forwarding headers.

## Tailscale private mesh

The initial mesh uses the Tailscale Kubernetes Operator and a deny-by-default
grant policy. The committed files are templates because the real operator email,
tailnet domain, OAuth identity, and device credentials are deployment-specific.

### Identity classes

| Tag | Purpose | Allowed destination ports |
|---|---|---|
| `tag:fiducia-laptop-host` | Host SSH and private K3s API | 22, 6443 from the named operator only |
| `tag:k8s-operator` | Kubernetes operator control identity | 443 from the named operator only |
| `tag:k8s` | Resources created by the operator | Owned by `tag:k8s-operator`; no broad grant by itself |
| `tag:fiducia-peer-egress` | Per-cluster egress proxy group | Node peer 9090 and brain peer 9095 only |
| `tag:fiducia-node-peer` | Exposed Fiducia node Raft endpoint | 9090 from peer-egress identities only |
| `tag:fiducia-brain-peer` | Exposed Fiducia brain Raft endpoint | 9095 from peer-egress identities only |

The policy intentionally does not grant peer proxies access to:

- SSH or the K3s API;
- the Kubernetes operator API;
- the Fiducia node client plane on 8090;
- the Fiducia brain control plane on 8095;
- arbitrary tailnet devices or home-LAN subnets.

`laptop/tailnet-policy.template.json` includes policy tests for the positive and
negative cases. Merge its rendered grants into the existing tailnet policy only
after the Tailscale policy editor/API accepts all tests.

### Render a reviewed policy

```sh
node tools/render-laptop-tailnet.mjs \
  --operator operator@example.com \
  --tailnet-domain example.ts.net \
  --policy-only > /secure/review/fiducia-tailnet-policy.json
```

The renderer rejects empty identities, placeholder domains, non-`ts.net`
MagicDNS domains, unresolved template tokens, and unknown cluster names.

### Render one cluster's service mirroring

```sh
node tools/render-laptop-tailnet.mjs \
  --operator operator@example.com \
  --tailnet-domain example.ts.net \
  --cluster laptop-aws-sim > /secure/review/laptop-aws-sim-tailnet.json
```

The JSON contains two non-secret strings:

- a Kubernetes bundle with one local node-peer ingress Service, one local
  brain-peer ingress Service, one two-replica egress ProxyGroup, and four remote
  peer egress Services;
- a two-line environment override pointing Fiducia node and brain peer lists at
  the cluster-local egress Services.

The generated bundle contains no Secret, OAuth client, auth key, or private key.
Install the operator and its OAuth Secret through the approved bootstrap path,
server-side dry-run the rendered resources, and then promote one laptop at a
time. Do not commit a materialized OAuth credential.

### Mesh rollout sequence

1. Approve the tag ownership and grants in the tailnet policy.
2. Create a least-privilege Tailscale OAuth client for the Kubernetes Operator.
3. Install a pinned operator release in each laptop cluster.
4. Apply the rendered local peer ingress and egress proxy resources for one
   follower cluster.
5. Wait for all proxy pods and Services to become healthy.
6. Apply the rendered `FIDUCIA_PEERS` and `FIDUCIA_BRAIN_PEERS` override only to
   that cluster.
7. Verify node and brain catch-up, authentication failures, latency, packet loss,
   and election stability.
8. Repeat for the second follower.
9. Move the current leaders last, with leadership transfer and re-observation.
10. Retain the old route until the new path has passed the rollback window.

Do not change all three peer paths simultaneously.

## Plain WireGuard fallback

Tailscale is the initial NAT-traversal and identity control plane, but the
application remains standard TCP on ports 9090 and 9095. A plain WireGuard
fallback therefore keeps the same logical peer planes and ports.

Before production, prepare a separate encrypted recovery bundle containing:

- one WireGuard private key per laptop, never shared between laptops;
- all three public keys;
- one unique overlay address per laptop;
- endpoint and keepalive settings appropriate to each real ISP/NAT;
- host firewall rules allowing UDP on the selected WireGuard listen port only;
- routes limited to the three overlay addresses, not entire home LANs;
- private DNS or host records for the existing `node.<cluster>.fiducia.internal`
  and `brain.<cluster>.fiducia.internal` names;
- revocation and peer-replacement instructions.

The fallback must not expose 8090, 8095, 4222, 6443, or SSH to general VPN peers.
Operator SSH/API access should use a separate operator peer or narrowly scoped
host firewall identity.

A fallback exercise must prove:

1. the Tailscale route for one follower is disabled;
2. its original Fiducia logical peer hostnames resolve over plain WireGuard;
3. only 9090 and 9095 are reachable between cluster peers;
4. 8090, 8095, 4222, 6443, SSH, and home-LAN addresses remain unreachable;
5. Raft and messaging health recover without changing application protocols or
   member identities;
6. the Tailscale path can be restored without creating a duplicate member.

The private WireGuard keys and actual ISP endpoints are recovery secrets and do
not belong in this repository.

## Runtime Secret materialization

Prepare private, non-symlink files. Every file must be nonempty and inaccessible
to group and world users.

Cloudflare input:

```text
/secure/cloudflare-token
```

K3s S3 directory, required files:

```text
/secure/k3s-s3/etcd-s3-endpoint
/secure/k3s-s3/etcd-s3-access-key
/secure/k3s-s3/etcd-s3-secret-key
/secure/k3s-s3/etcd-s3-bucket
```

The script also accepts K3s-supported optional S3 configuration files such as
region, folder, CA, session token, proxy, timeout, or bucket lookup type.

Review without changing a cluster:

```sh
scripts/apply-laptop-runtime-secrets.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --cloudflare-token-file /secure/cloudflare-token \
  --s3-config-dir /secure/k3s-s3
```

Apply after review:

```sh
scripts/apply-laptop-runtime-secrets.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --cloudflare-token-file /secure/cloudflare-token \
  --s3-config-dir /secure/k3s-s3 \
  --apply
```

The script verifies the live context contains exactly one node labeled for the
requested laptop and creates:

- `fiducia/cloudflare-tunnel-token`;
- `kube-system/k3s-etcd-snapshot-s3-config` with type
  `etcd.k3s.cattle.io/s3-config-secret`.

It uses file-backed `kubectl create secret ... --dry-run=client -o yaml |
kubectl apply --server-side`. It does not use `--from-literal`, echo secret
values, or enable shell tracing.

For the long-term bootstrap, replace the manual file source with the approved
SOPS/age and External Secrets flow in `DEN-433` and `DEN-434`. The object names
and K3s configuration remain the same.

## Scheduled off-host K3s snapshots

Each generated laptop K3s configuration now contains only:

```yaml
etcd-s3: true
etcd-s3-config-secret: k3s-etcd-snapshot-s3-config
etcd-snapshot-schedule-cron: "0 */6 * * *"
etcd-snapshot-retention: 14
```

No endpoint, bucket, access key, secret key, session token, region, or proxy is
embedded in the host configuration. This is important because K3s ignores the
S3 configuration Secret when conflicting command-line/config-file S3 options
are also supplied.

Before declaring snapshots healthy, prove all of the following:

- the K3s server reads the Secret and creates the scheduled snapshot;
- the snapshot appears in the intended external bucket/folder;
- the bucket is independent of the laptop's local disk and site;
- object encryption, retention, and access logging match the data policy;
- snapshot age and upload failure are monitored;
- a selected object can be retrieved without the live laptop;
- its checksum is captured through an independent evidence path;
- the original K3s server token is held in offline recovery custody.

A successful upload is not a successful backup until a replacement-host restore
has completed.

## Replacement-host restore

K3s cannot read its S3 configuration Secret while the API server is down during
restore. Retrieve the selected object through an independently audited recovery
path, then restore from the local file.

Plan-only validation:

```sh
sudo scripts/restore-laptop-k3s-snapshot.sh \
  --cluster laptop-aws-sim \
  --snapshot /secure/restore/etcd-snapshot \
  --snapshot-sha256 <expected-sha256> \
  --token-file /secure/restore/k3s-server-token
```

Destructive apply:

```sh
sudo scripts/restore-laptop-k3s-snapshot.sh \
  --cluster laptop-aws-sim \
  --snapshot /secure/restore/etcd-snapshot \
  --snapshot-sha256 <expected-sha256> \
  --token-file /secure/restore/k3s-server-token \
  --ack-stop-k3s \
  --ack-cluster-reset \
  --ack-replace-cluster-state \
  --apply
```

The script:

- verifies the snapshot checksum;
- requires a private non-symlink token file;
- checks the requested node identity where host config is available;
- refuses to proceed when an unresolved K3s reset flag exists;
- requires three explicit destructive acknowledgements;
- stops K3s;
- restores from the local snapshot with `--etcd-s3=false` and `--token-file`;
- starts K3s and verifies the service becomes active.

It deliberately does not place S3 access or secret keys on the restore command
line.

After the K3s service starts, the restore is still incomplete. The operator must:

1. verify the API server and node identity;
2. remove stale node objects if required by K3s recovery procedure;
3. bootstrap the exact Git revision through `DEN-944`;
4. restore or catch up Fiducia, JetStream, and application state through their
   separate durability procedures;
5. rotate any credential exposed by the lost machine;
6. prove node and brain membership has no duplicate/stale identity;
7. pass the external health, failover, fencing, replay, and restore checks in
   `DEN-946` before returning the laptop to traffic.

## CI contract

The laptop workflow and `tools/laptop-networking.test.mjs` verify:

- each laptop overlay contains the runtime connector component;
- the public application Service remains `ClusterIP` and no NodePort is added;
- cloudflared is exact-versioned, secret-backed, probeable, unprivileged, and
  bounded by a PodDisruptionBudget;
- its NetworkPolicy permits only the local origin plus TCP/UDP 7844;
- generated K3s configs use the S3 Secret and contain no S3 credential fields;
- Tailscale grants contain no wildcard source/destination and policy tests deny
  operator/client/control-plane escalation;
- every cluster render contains exactly two remote node and two remote brain
  egress Services and excludes itself;
- malformed identities, placeholder domains, and unknown clusters fail closed;
- secret materialization uses private files rather than literals;
- restore requires checksum, token file, local mode, and all destructive
  acknowledgements;
- new implementation inputs contain no credential-like GitHub, Tailscale, or
  private-key values;
- all three laptop overlays continue to build.

These are software-contract tests. They do not replace Tailscale policy
validation, live tunnel health, S3 upload, clean-room restore, power/ISP failure,
or the seven-day physical soak.
