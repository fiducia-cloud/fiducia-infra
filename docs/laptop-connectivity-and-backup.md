# Laptop private mesh, outbound ingress, and K3s snapshot evidence

Governing issue: `DEN-943`. Parent: `DEN-941`.

This document implements the private-network, public-ingress, and K3s control-
plane backup portions of the pre-funding three-laptop production plan. It does
not claim that the three physical laptops, tailnet, Cloudflare tunnel, object
store, or restore path have already been provisioned.

## Security and failure-domain model

Each laptop owns one independent single-node K3s cluster. Kubernetes control-
plane availability does not span laptops. Cross-cluster connectivity is limited
to explicitly proxied Fiducia peer ports, while customer HTTP traffic enters
through an outbound-only Cloudflare Tunnel connector in each cluster.

```text
                       Cloudflare edge
                    outbound TCP/UDP 7844
                  /          |           \
       cloudflared A   cloudflared B   cloudflared C
             |               |               |
      local ClusterIP  local ClusterIP  local ClusterIP

 Fiducia node/brain A <---- encrypted tailnet ----> B <----> C
        ingress Service       HA egress ProxyGroup
        ports 9090/9095       stable local Service names

 K3s embedded etcd -> local compressed snapshot + independent S3 copy
```

The tailnet is defense in depth, not the only authentication layer. Fiducia
node, brain, and messaging protocols must still use the TLS/mTLS, fencing,
idempotency, and authorization work tracked by DEN-82, DEN-433, DEN-434,
DEN-437, and DEN-438.

## Repository layout

```text
laptop/
  components/connectivity/          cloudflared and laptop-only policies
  network/tailnet-policy.hujson      reviewed grants plus allow/deny tests
  network/tailnet-observations...    non-production endpoint shape
  connectivity/*.example.yaml       structural Secret examples only
  backup/*.example.yaml             structural S3 Secret example only
  clusters/<cluster>/
    tailnet-ingress.yaml             private node/brain ingress Services
  hosts/<cluster>/
    k3s-config.yaml                  Secret-backed compressed S3 snapshots
    tailscale-egress-proxygroup.yaml cluster-scoped HA egress bootstrap
scripts/
  bootstrap-laptop-tailscale-operator.sh
  capture-laptop-tailnet-observations.sh
  apply-laptop-tailnet-egress.sh
  apply-cloudflared-tunnel-secret.sh
  apply-k3s-etcd-s3-secret.sh
  capture-laptop-etcd-snapshot-evidence.sh
tools/
  render-laptop-tailnet-egress.mjs
  validate-cloudflared-token-secret.mjs
  validate-k3s-s3-secret.mjs
  verify-etcd-snapshot-evidence.mjs
  laptop-connectivity.test.mjs
```

## Why the egress ProxyGroup is outside the application overlay

Tailscale `ProxyGroup` is a cluster-scoped custom resource. The Fiducia laptop
Kustomize overlays are namespaced to `fiducia`; placing an unknown cluster-
scoped CR inside that transformer risks an invalid namespace and also expands
the normal application root's cluster-wide permissions.

The generated `tailscale-egress-proxygroup.yaml` therefore lives with each host
bootstrap and is installed only after the corresponding cluster-local operator
and CRD are ready. Namespaced ingress and egress `Service` resources remain in
the application layer.

## Tailnet policy

`laptop/network/tailnet-policy.hujson` is a reviewed policy fragment/template,
not an instruction to overwrite an existing tailnet policy wholesale.
Semantically merge its `tagOwners`, `grants`, and `tests` into the authoritative
policy. Preserve unrelated existing rules and reject conflicting broad grants.

The contract is:

- `tag:k8s-operator` owns each cluster-specific Fiducia peer tag;
- administrators reach laptop SSH/Kubernetes APIs only on TCP 22/6443;
- each cluster peer tag reaches only the other two peer tags;
- peer traffic is limited to Fiducia node port 9090 and brain port 9095;
- peer proxies cannot reach laptop SSH, Kubernetes APIs, operator APIs, or their
  own source tag through the supplied grants;
- policy tests include both expected accepts and expected denies.

Do not reuse a peer tag for an operator, human device, database, or unrelated
workload. Tailscale applies custom proxy tags when the device is first created;
changing a tag later requires controlled proxy recreation.

## Install one Tailscale operator per cluster

Create a separate, scoped OAuth identity per cluster where practical. The OAuth
client needs the documented Tailscale operator write scopes and
`tag:k8s-operator`. Keep client ID/secret material outside Git and Linear in an
operator values file readable only by its owner.

Retain a specific stable Helm chart archive in the approved artifact store and
record its SHA-256. The bootstrap script never downloads a mutable chart.

```sh
scripts/bootstrap-laptop-tailscale-operator.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --chart /secure/artifacts/tailscale-operator-1.x.y.tgz \
  --chart-sha256 <recorded-sha256> \
  --values /secure/bootstrap/laptop-aws-sim-tailscale.values.yaml
```

The default mode is a plan and validation only. Apply after review:

```sh
scripts/bootstrap-laptop-tailscale-operator.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --chart /secure/artifacts/tailscale-operator-1.x.y.tgz \
  --chart-sha256 <recorded-sha256> \
  --values /secure/bootstrap/laptop-aws-sim-tailscale.values.yaml \
  --apply
```

The script:

1. checks the chart checksum;
2. rejects group/world-readable or placeholder OAuth values;
3. verifies exactly one node with the intended laptop labels exists in the
   context;
4. renders locally and server-side dry-runs before installation;
5. installs the cluster-local operator atomically;
6. enables authenticated API-server proxy mode and the required impersonation
   permissions;
7. waits for the operator and ProxyGroup CRD;
8. applies the generated cluster-scoped two-replica egress ProxyGroup;
9. waits for `ProxyGroupReady=true`.

The operator deployment is independent per laptop. A failure of Laptop A must
not remove the operator or egress reconciliation for B and C.

## Private cross-cluster peer Services

Every laptop overlay exposes two private L3 Services through the operator:

- `fiducia-node-peer-tailnet`: TCP 9090;
- `fiducia-brain-peer-tailnet`: TCP 9095.

They use `type: LoadBalancer` with `loadBalancerClass: tailscale`. This does not
create a public cloud load balancer. The operator assigns private tailnet
identities using deterministic hostnames and the cluster-specific peer tag.

Once all six ingress endpoints are ready, capture fresh MagicDNS evidence:

```sh
scripts/capture-laptop-tailnet-observations.sh \
  --contexts /secure/config/laptop-contexts.json \
  --output /secure/evidence/tailnet-observations.json
```

The context mapping file contains only cluster-to-kube-context names. The
capture script verifies each context's node identity and writes a mode-0600 live
evidence file.

Apply local egress Services in each cluster:

```sh
scripts/apply-laptop-tailnet-egress.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --observations /secure/evidence/tailnet-observations.json \
  --apply
```

Live observations older than ten minutes fail closed. Example observations are
accepted only with `--allow-example` and must never be cited as production
evidence.

Each egress resource is an `ExternalName` `Service` backed by the local HA
`fiducia-egress-proxies` ProxyGroup. Applications continue to use deterministic
in-cluster names such as:

```text
fiducia-node-peer-laptop-gcp-sim.fiducia.svc.cluster.local:9090
fiducia-brain-peer-laptop-azure-sim.fiducia.svc.cluster.local:9095
```

This indirection lets the current Tailscale control plane later be replaced by a
plain WireGuard/DNS implementation without changing Fiducia's application
configuration. The WireGuard fallback still needs a DEN-942 host-level
implementation and live switchover test.

## Kubernetes NetworkPolicy boundary

The base namespace remains default-deny. The laptop connectivity component adds
only these changes:

- Fiducia node/brain peer ingress is allowed from the `tailscale` namespace;
- Fiducia node/brain peer egress is allowed to the `tailscale` namespace;
- Cloudflare edge egress is allowed only to the twenty currently documented
  global tunnel endpoint IPv4 addresses on TCP/UDP 7844;
- cloudflared metrics are reachable only from the Fiducia namespace;
- DNS and same-namespace origin connectivity continue through the existing base
  rules.

No policy adds `0.0.0.0/0`, public NodePorts, host ports, public Kubernetes APIs,
or public Raft ports. If the deployment enables IPv6 for cloudflared, add the
published IPv6 endpoint list through a separate reviewed change; the current
connector explicitly selects IPv4 so the IPv4-only policy is internally
consistent.

## Outbound-only Cloudflare Tunnel

The laptop connectivity component deploys one `cloudflared` connector per
cluster. It uses:

- the official image pinned by multi-architecture digest;
- `--no-autoupdate` and a remotely managed tunnel;
- `TUNNEL_TOKEN` sourced only from `cloudflared-tunnel-token`;
- `/ready` liveness/readiness probes and a private metrics Service;
- non-root execution, read-only root filesystem, no privilege escalation, all
  Linux capabilities dropped, RuntimeDefault seccomp, bounded resources, and no
  Kubernetes API token;
- no public Service, host network, host port, NodePort, or inbound router rule.

Create one named tunnel and configure the cluster's published hostname to route
to the local service URL, for example:

```text
http://fiducia-load-balance-internal.fiducia.svc.cluster.local:8088
```

Use a distinct token/connector identity per cluster when operational simplicity
allows it. A shared named tunnel with three connectors is acceptable for the
pre-funding phase, but Cloudflare replicas alone do not provide intelligent
origin health steering; add Cloudflare Load Balancing or an equivalent explicit
origin-health layer before making stronger availability claims.

Create an external mode-0600 Secret file using the structural example in
`laptop/connectivity/`. Apply it without printing the token:

```sh
scripts/apply-cloudflared-tunnel-secret.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --secret-file /secure/bootstrap/laptop-aws-sim-cloudflared.secret.yaml \
  --apply
```

Anyone holding a remotely managed tunnel token can run that connector. Treat
rotation and lost-device revocation as incident-critical operations. Never put a
tunnel token into Git, Linear, shell history, screenshots, or process arguments.

## K3s embedded-etcd S3 snapshots

Each generated K3s host config enables:

```yaml
etcd-snapshot-compress: true
etcd-s3: true
etcd-s3-config-secret: k3s-etcd-snapshot-s3-config
```

No other `etcd-s3-*` setting appears in the host config. K3s ignores the Secret
when additional S3 flags are supplied, so CI explicitly rejects endpoint,
credential, bucket, folder, and TLS flags in the generated host files.

Create a per-cluster S3 configuration Secret outside Git. Its folder must include
the exact cluster identity, TLS verification must remain enabled, and plaintext
transport is prohibited. The object store should have separate credentials,
server-side encryption, access logging, bucket versioning/retention controls,
and a lifecycle policy consistent with the tested restore objectives.

```sh
scripts/apply-k3s-etcd-s3-secret.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --secret-file /secure/bootstrap/laptop-aws-sim-k3s-s3.secret.yaml \
  --apply
```

The script validates only a reviewed `stringData` Secret shape, requires a mode-
0600 file, verifies the intended cluster context, performs a server-side dry run,
and never displays credential values.

## Snapshot evidence

K3s represents local and S3 snapshots as cluster-scoped `ETCDSnapshotFile`
resources. Capture and verify a recent matched pair:

```sh
scripts/capture-laptop-etcd-snapshot-evidence.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --output /secure/evidence/laptop-aws-sim-etcdsnapshots.json \
  --max-age-hours 8
```

The verifier requires:

- a ready local record owned by the expected laptop node;
- a ready S3 record with `nodeName: s3` and an `s3://` location;
- identical snapshot name and size;
- creation timestamps no more than five minutes apart;
- matching K3s snapshot token-hash annotations;
- S3 TLS verification enabled;
- a matched pair inside the requested age window.

The redacted summary records resource names, snapshot name, time, size, and the
fact that token hashes matched. It does not output the hash or credentials.
Upload success is not restore evidence.

## Restore requirements that remain outside the Kubernetes Secret

During a K3s restore, the Kubernetes API is unavailable, so the S3 configuration
Secret cannot supply object-store credentials. The clean-room restore runbook
must therefore maintain a separate offline/recovery copy of the S3 CLI settings.

The original K3s server token must also be backed up independently. K3s derives
the key used to protect confidential bootstrap data from that token. A snapshot
without the correct original token may be unusable, and possession of both the
snapshot and token is highly sensitive.

Store the S3 restore material and original server token under separate,
explicitly assigned custody. DEN-946 must prove a new-host restore using those
materials; do not close DEN-943 based only on matching `ETCDSnapshotFile`
records.

## Required live verification

Before DEN-943 can be completed, attach evidence for all three clusters:

- operator chart version/digest and successful cluster-local installation;
- tailnet policy validation with all supplied accepts and denies;
- private ingress and egress Service readiness;
- pairwise TCP connectivity on 9090/9095 and explicit denials on 22/443/6443 from
  peer proxy identities;
- Cloudflare connector readiness and four active edge connections;
- external HTTP probes from at least two independent locations;
- absence of public SSH, Kubernetes API, NodePort, NATS, Raft, and database
  exposure;
- a recent matched local/S3 K3s snapshot pair per laptop;
- independent S3 restore settings and original K3s token custody;
- one clean replacement-cluster restore;
- a documented and tested plain WireGuard fallback.

Until those results exist, this repository work is a tested configuration and
bootstrap contract, not production acceptance evidence.

## Primary references

- https://tailscale.com/docs/kubernetes-operator/
- https://tailscale.com/docs/kubernetes-operator/egress/access-tailnet-service
- https://tailscale.com/docs/kubernetes-operator/reference/tags
- https://github.com/tailscale/tailscale/blob/main/k8s-operator/api.md
- https://developers.cloudflare.com/tunnel/deployment-guides/kubernetes/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/
- https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/
- https://docs.k3s.io/cli/etcd-snapshot
- https://docs.k3s.io/datastore/backup-restore
