# DEN-943 post-merge hardening addendum

This addendum is authoritative where it conflicts with
`docs/laptop-private-mesh-ingress-snapshots.md`. It records the semantic
hardening applied after the original DEN-943 implementation merged.

The foundational design remains unchanged:

- one independent single-node K3s cluster per laptop;
- outbound-only Cloudflare Tunnel for customer HTTP;
- Tailscale initially, with a plain WireGuard fallback;
- file-backed runtime Secret materialization;
- K3s embedded-etcd snapshots copied to external S3-compatible storage;
- checksum-gated replacement-host restore using the original K3s server token.

## Corrected Tailscale resource scope

`ProxyGroup` is a cluster-scoped Tailscale CRD. The rendered
`fiducia-peer-egress` object therefore has **no** `metadata.namespace`.

Do not place this object under a namespaced application transform, and do not
silence schema errors by adding a namespace. Apply it through the reviewed
cluster bootstrap/operator path with a server-side dry run. The namespaced
Service resources remain in `fiducia`.

## Per-cluster peer identities

Fleet-wide peer tags are too broad because a compromised or misconfigured proxy
could reach its own cluster or unrelated peer endpoints. Every laptop now has a
distinct identity triplet:

```text
tag:fiducia-peer-egress-aws-sim
tag:fiducia-node-peer-aws-sim
tag:fiducia-brain-peer-aws-sim

# equivalent gcp-sim and azure-sim tags
```

Each egress identity may reach only the **other two** clusters:

- node peer TCP 9090;
- brain peer TCP 9095.

It may not reach:

- its own node or brain tag;
- SSH or Kubernetes API ports;
- the Kubernetes operator API;
- Fiducia client/control ports 8090 or 8095;
- arbitrary tailnet devices or home-LAN networks.

The rendered policy contains positive and negative tests for the operator and
all three egress identities. Merge it semantically into the authoritative
Tailnet policy; preserve unrelated rules and reject wildcard or generic
fleet-wide peer grants.

## Cloudflare connector hardening

The connector now uses the official multi-architecture image pinned by digest,
not a mutable tag. It remains non-root, read-only, capability-free,
Secret-backed, probeable, and outbound-only.

The NetworkPolicy permits:

- local origin TCP 8088;
- exactly twenty reviewed Cloudflare Tunnel IPv4 `/32` endpoints;
- TCP and UDP 7844 to those endpoints only.

The connector is forced to IPv4 so runtime behavior matches the allowlist. The
policy does not contain `0.0.0.0/0`, public management ports, or general HTTPS
egress.

The edge list is operational configuration and must be reviewed against
Cloudflare's current documentation whenever cloudflared is upgraded. Enabling
IPv6 requires a separate reviewed IPv6 endpoint policy.

## Runtime Secret semantic validation

`scripts/apply-laptop-runtime-secrets.sh` retains the original secure
file-backed materialization design and adds fail-closed validation:

- every input is a nonempty, non-symlink, owner-only file;
- placeholder values are rejected;
- the Cloudflare token must match the remotely managed tunnel-token shape;
- the S3 endpoint cannot use plaintext `http://`;
- the bucket must use a conservative DNS-style name;
- `etcd-s3-folder` is required and must end with the exact cluster identity;
- `etcd-s3-skip-ssl-verify` and `etcd-s3-insecure`, when present, must be
  `false`;
- Secret values remain absent from command output and Git.

The exact cluster folder requirement prevents one laptop from silently writing
snapshots into another laptop's prefix.

## Matched local/S3 snapshot evidence

A successful S3 request is not enough. The evidence tool consumes K3s
`ETCDSnapshotFile` resources and requires a recent local/S3 pair with:

- expected local node identity and `file://` location;
- S3 storage identity and `s3://` location;
- ready state and nonzero size;
- identical snapshot name and size;
- creation timestamps within five minutes;
- matching K3s snapshot token-hash annotations;
- S3 TLS verification enabled;
- age inside the configured evidence window.

Capture evidence with:

```sh
scripts/capture-laptop-etcd-snapshot-evidence.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --output /secure/evidence/laptop-aws-sim-etcdsnapshots.json \
  --max-age-hours 8
```

The script verifies the selected kube context contains exactly one correctly
labeled laptop node, writes raw and redacted summary evidence as mode-0600 files,
and never prints the snapshot token hash.

This proves that K3s reported matching local and S3 records. It does **not** prove
that the object can be retrieved independently or restored.

## Restore contract retained

`scripts/restore-laptop-k3s-snapshot.sh` remains the restore source of truth. It:

- checksum-verifies a locally retrieved snapshot;
- requires the independently recovered original K3s token file;
- restores with `--etcd-s3=false`, avoiding credentials on the restore command;
- validates node identity and unresolved reset state;
- requires three explicit destructive acknowledgements;
- stops, resets, restores, restarts, and checks K3s service activity.

DEN-946 still requires a clean replacement-host restore plus GitOps
reconciliation, member catch-up, credential rotation, and failover evidence.

## CI additions

The laptop workflow now verifies:

- digest-pinned cloudflared and twenty unique `/32` edge destinations;
- no wildcard tunnel egress or management/data-plane ports;
- cluster-scoped `ProxyGroup` output with no namespace;
- distinct peer tags and explicit self/admin/control-plane denials for all three
  clusters;
- exact two-peer mirroring per cluster;
- strict runtime Secret semantics;
- fresh matched local/S3 snapshot evidence;
- rejection of missing, stale, size-mismatched, token-mismatched, or
  TLS-insecure snapshot records;
- context-bound mode-0600 evidence capture;
- unchanged checksum/token/acknowledgement restore protections;
- absence of GitHub, Tailscale, private-key, and provider credential patterns.

These checks are software evidence only. Live tailnet validation, connector
health, object retrieval, clean restore, WireGuard fallback, ISP/power failure,
and the seven-day soak remain open gates.
