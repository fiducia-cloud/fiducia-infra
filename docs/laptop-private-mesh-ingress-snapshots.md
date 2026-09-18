# Laptop private mesh, verified outbound ingress, and K3s recovery

Governing issues: `DEN-943` and `DEN-438`.

This runbook defines the software contract for connecting the three independent laptop K3s clusters, publishing HTTPS traffic without router port forwarding, storing K3s snapshots off-host, and restoring one clean replacement laptop.

It does not claim that a physical laptop, tailnet, Cloudflare tunnel, object bucket, certificate, or restore drill already exists. Live evidence remains required in `DEN-942`, `DEN-943`, `DEN-438`, and `DEN-946`.

## Layered security boundary

The deployment relies on independent controls:

- namespace default-deny ingress and egress;
- cluster-specific Tailscale grants for cross-cluster node, brain, and NATS route identities;
- Fiducia application authentication and fencing;
- verified HTTPS from Cloudflare Tunnel to the local load balancer;
- file-backed or external secret delivery with no values in Git;
- K3s S3 credentials in a Kubernetes Secret rather than host config;
- checksum-verified local restore using independently recovered K3s token material.

VPN identity, NetworkPolicy, TLS, and application authorization are complementary. None should be removed because another layer exists.

## Verified outbound Cloudflare ingress

Every laptop overlay includes `laptop/components/runtime`, which runs one hardened `fiducia-cloudflared` connector. It receives no public inbound connection.

The remotely managed route must use:

```text
service: https://fiducia-load-balance-tls.fiducia.svc.cluster.local:8443
originRequest.caPool: /etc/fiducia/origin-ca/ca.crt
```

The Deployment mounts only public `ca.crt` from `Secret/fiducia-load-balance-tls` and starts `cloudflared` with `--origin-ca-pool`. The load-balancer private key is not exposed to the connector.

Do not configure:

- `http://fiducia-load-balance-internal...:8088` as an origin;
- `noTLSVerify` or `--no-tls-verify`;
- a router port forward, NodePort, host port, or K3s ServiceLB;
- an origin pointing at the Kubernetes API, Fiducia node/brain planes, NATS, Argo CD, metrics, SSH, or a home-LAN address.

The connector is digest-pinned, has no service-account token, runs non-root with a read-only root filesystem and dropped capabilities, exposes only its local readiness/metrics port, and is protected by a `maxUnavailable: 0` PDB.

Its NetworkPolicy permits only:

- the local `fiducia-load-balance` pods on TCP `8443`;
- published Cloudflare Tunnel edge endpoints on TCP/UDP `7844`;
- bounded readiness/metrics access.

Port `8088` is a temporary health/upgrade-required listener only and is not an application origin. See `docs/fiducia-internal-tls.md` for the CA, rotation, downgrade, and client-migration contract.

Use a distinct, separately revocable connector identity per laptop where supported. Never put tunnel tokens in Argo CD Applications, ConfigMaps, shell arguments, CI output, Git, or Linear.

External acceptance requires HTTPS probes from at least two independent regions, unhealthy-origin withdrawal, one-laptop/one-ISP failover, and trusted-proxy validation.

## Tailscale private mesh

The initial mesh uses the Tailscale Kubernetes Operator and a deny-by-default policy. Production operator identity, tailnet domain, OAuth material, and device credentials remain deployment inputs outside Git.

Identity classes are cluster-specific:

| Identity | Access |
|---|---|
| Named operator | Laptop SSH `22`, private K3s API `6443`, operator API `443` |
| Cluster peer egress | Only the other two node `9090`, brain `9095`, and NATS route `6222` identities |
| Node peer identity | Raft `9090` only |
| Brain peer identity | Raft `9095` only |
| NATS route identity | mTLS route `6222` only |

Peer identities are denied access to SSH, Kubernetes API, Fiducia client/control ports `8090/8095`, NATS client `4222`, NATS monitoring `8222`, and their own local route identity.

Render a reviewed policy:

```sh
node tools/render-laptop-tailnet.mjs \
  --operator operator@example.com \
  --tailnet-domain example.ts.net \
  --policy-only > /secure/review/fiducia-tailnet-policy.json
```

Render one cluster adapter:

```sh
node tools/render-laptop-tailnet.mjs \
  --operator operator@example.com \
  --tailnet-domain example.ts.net \
  --cluster laptop-aws-sim > /secure/review/laptop-aws-sim-tailnet.json
```

The renderer rejects placeholders, malformed identities, unresolved tokens, and unknown clusters. Its output is non-secret.

### Mesh rollout

1. Approve tag ownership, grants, and positive/negative policy tests.
2. Install a pinned Operator release through the approved bootstrap path.
3. Apply one follower cluster's local ingress and remote egress resources.
4. Wait for proxies and Services to become healthy.
5. Change only that cluster's peer environment.
6. Verify authentication, role, lag, elections, latency, and packet loss.
7. Repeat for the second follower.
8. Transfer/reobserve leadership and move leaders last.
9. Retain the old path through the rollback window.

Never change all three peer paths simultaneously.

## Plain WireGuard fallback

The application protocols remain standard TCP, so a separately protected WireGuard fallback can preserve the same logical peer planes. Keep one unique key per laptop, narrow overlay routes, private DNS for existing peer names, host firewall rules, endpoint/keepalive data, and revocation instructions in an encrypted recovery bundle.

The fallback must not expose home LANs or management/data-plane ports beyond the reviewed peer set. Test one follower at a time and prove that `8090`, `8095`, `4222`, `8222`, `6443`, and SSH remain unavailable to ordinary peer identities.

Private keys and real ISP endpoints do not belong in this repository.

## Runtime secret materialization

`scripts/apply-laptop-runtime-secrets.sh` accepts private non-symlink files and creates:

- `fiducia/cloudflare-tunnel-token`;
- `kube-system/k3s-etcd-snapshot-s3-config` with type `etcd.k3s.cattle.io/s3-config-secret`.

It verifies file permissions and kube-context identity, uses `--from-file`, never uses `--from-literal`, does not enable shell tracing, and never prints values.

Review first, then apply:

```sh
scripts/apply-laptop-runtime-secrets.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --cloudflare-token-file /secure/cloudflare-token \
  --s3-config-dir /secure/k3s-s3

scripts/apply-laptop-runtime-secrets.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --cloudflare-token-file /secure/cloudflare-token \
  --s3-config-dir /secure/k3s-s3 \
  --apply
```

Long-term delivery converges on DEN-433/DEN-434 SOPS/age and External Secrets controls without changing the runtime object names.

## Scheduled off-host K3s snapshots

Generated K3s host configuration contains only:

```yaml
etcd-s3: true
etcd-s3-config-secret: k3s-etcd-snapshot-s3-config
etcd-snapshot-schedule-cron: "0 */6 * * *"
etcd-snapshot-retention: 14
```

Endpoint, bucket, access key, secret key, session token, region, folder, and proxy are absent from host config so K3s uses the rotatable Secret.

Before declaring backups healthy, prove:

- scheduled local and S3 snapshot records match;
- the object exists in an independent encrypted location;
- upload failure and age are monitored;
- the object is retrievable without the original laptop;
- checksum and recovery-token custody are recorded independently;
- a clean replacement-host restore succeeds.

A successful upload is not a successful backup.

## Replacement-host restore

K3s cannot read the Kubernetes S3 Secret while its API is down. Retrieve the approved object through an independently audited path and restore locally:

```sh
sudo scripts/restore-laptop-k3s-snapshot.sh \
  --cluster laptop-aws-sim \
  --snapshot /secure/restore/etcd-snapshot \
  --snapshot-sha256 <expected-sha256> \
  --token-file /secure/restore/k3s-server-token
```

The destructive form additionally requires:

```text
--ack-stop-k3s
--ack-cluster-reset
--ack-replace-cluster-state
--apply
```

The script verifies SHA-256, private token-file handling, requested node identity, unresolved reset state, and K3s service recovery. It puts no S3 credentials on the restore command line.

After K3s starts, recovery still requires exact GitOps bootstrap, Fiducia and JetStream restore/catch-up, credential rotation, stale-identity rejection, external health, replay, fencing, and DEN-946 acceptance.

## CI contract

Repository tests verify:

- Cloudflare uses verified HTTPS plus the mounted CA pool;
- its policy allows `8443`, not `8088`;
- application Services remain ClusterIP on laptop overlays;
- K3s uses a Secret-backed S3 configuration with no embedded credentials;
- Tailscale grants are cluster-specific and deny self/management/client access;
- renderer inputs fail closed;
- secret materialization is file-backed and redacted;
- snapshot evidence pairs local and S3 records;
- restore is checksum/token/acknowledgement gated;
- tracked inputs contain no recognizable private-key or provider credential patterns;
- all laptop and canonical cloud overlays build.

These are software contracts. They do not replace live Tailscale policy acceptance, verified Cloudflare origin health, certificate rotation, S3 upload, clean restore, power/ISP failure, or the seven-day physical soak.
