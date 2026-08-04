# Fiducia verified internal TLS and CA trust

Governing issue: `DEN-438`.

This runbook defines the staged migration from plaintext Fiducia load-balancer
application traffic to hostname-verified HTTPS. It covers the serving PKI,
canonical in-cluster service, External Secrets Operator trust contract,
Cloudflare Tunnel origin verification, direct-client migration, certificate
rotation, downgrade rejection, alerts, evidence capture, and rollback.

It does not claim that cert-manager, ESO, Cloudflare routes, direct clients, or
physical laptop clusters have completed the live migration. Those require
cluster-specific evidence.

## Canonical endpoints

Application clients use one of these verified TLS endpoints:

```text
https://fiducia-load-balance-tls.fiducia.svc.cluster.local:8443
https://fiducia-load-balance.fiducia.svc.cluster.local:443
```

The first is the canonical in-cluster endpoint. The second is the public/service
entrypoint and may also be resolved from inside the cluster.

Port `8088` is not an application endpoint. During the final migration stage it
exists only for kubelet `/healthz` and `/readyz` probes and the load-balancer's
explicit `426 Upgrade Required` guard. The Service is labelled
`plaintext-health-only` and must be removed once probes move to a dedicated
health-only listener.

This runbook supersedes the older plaintext Cloudflare origin example in
`docs/laptop-private-mesh-ingress-snapshots.md`.

## Private PKI

`base/tls/fiducia-internal-pki.yaml` creates a separate PKI in every Kubernetes
cluster:

1. `ClusterIssuer/fiducia-selfsigned-bootstrap` creates the initial root.
2. `Certificate/fiducia-internal-ca` stores the ECDSA root in
   `Secret/fiducia-internal-ca`.
3. `Issuer/fiducia-internal-ca` signs namespaced leaves.
4. `Certificate/fiducia-load-balance-tls` creates a 30-day ECDSA serving leaf in
   `Secret/fiducia-load-balance-tls` and renews ten days before expiry.

No certificate or private-key bytes are stored in Git. The serving Secret is
required by the Deployment and mounted read-only with mode `0440`; a missing
Secret prevents the load balancer from starting instead of silently disabling
TLS.

The serving certificate covers both service families:

```text
fiducia-load-balance[.fiducia[.svc[.cluster.local]]]
fiducia-load-balance-tls[.fiducia[.svc[.cluster.local]]]
```

Each cluster has an independent root. A client that intentionally connects to
more than one cluster must trust an explicit reviewed bundle of those roots; it
must not trust an arbitrary system or organization-wide CA as a shortcut.

## CA lifecycle warning

The root CA uses a long lifetime and `rotationPolicy: Never` because root
rotation is an explicit trust-distribution operation. cert-manager leaf rotation
is automatic, but replacing the CA Secret does not by itself guarantee that
existing leaves are reissued or that every client trusts both roots.

Begin CA rotation at least six months before expiry:

1. create a new root and issuer under new names;
2. distribute an overlap bundle containing the old and new public roots to every
   client;
3. verify every client accepts both roots and still rejects unknown roots;
4. issue a new serving leaf from the new issuer;
5. restart load-balancer replicas one at a time after the new Secret exists;
6. verify ESO, Cloudflare, and every direct client through the new leaf;
7. remove the old root from clients one workload/cluster at a time;
8. revoke/archive the old signing key according to the key-custody policy.

Never replace all trust and serving identities in one unobserved operation.

## Leaf rotation

The serving leaf rotates automatically through cert-manager, but the current
load-balancer loads certificate files at process startup. After a renewed Secret
is Ready:

1. capture the old and new public fingerprints without reading `tls.key`;
2. verify the new chain, SANs, EKU, and remaining lifetime;
3. restart one load-balancer replica;
4. wait for HTTPS readiness and external probes;
5. verify ESO and direct clients against that replica;
6. restart the second replica;
7. record the Secret revision and deployment rollout revision.

The PDB and rolling strategy preserve one available replica. Stop if any client
reports unknown CA, hostname mismatch, expiry, or downgrade behavior.

## External Secrets Operator contract

`contracts/external-secrets/dd-fiducia-kv.clustersecretstore.yaml` is a
non-applied contract for the platform repository that owns ESO. It requires:

```yaml
url: https://fiducia-load-balance-tls.fiducia.svc.cluster.local:8443/v1/kv
caProvider:
  type: Secret
  name: fiducia-load-balance-tls
  namespace: fiducia
  key: ca.crt
```

ESO reads only the public `ca.crt`; it never receives `tls.key`. The consuming
repository must preserve its existing namespace selector, authorization token,
admission policy, key-shape, ownership, and bootstrap controls.

Live acceptance requires a representative `ExternalSecret` to reconcile only
through verified HTTPS. These negative paths must fail before an application
secret is returned:

- unknown CA;
- hostname mismatch;
- expired/not-yet-valid certificate;
- revoked/replaced certificate without overlap trust;
- plaintext URL;
- omitted CA provider;
- CA provider pointing at `tls.crt` or `tls.key` instead of `ca.crt`.

## Cloudflare Tunnel origin

Every remotely managed tunnel route must use:

```text
service: https://fiducia-load-balance-tls.fiducia.svc.cluster.local:8443
originRequest.caPool: /etc/fiducia/origin-ca/ca.crt
```

The Kubernetes Deployment mounts only `ca.crt` from the serving Secret and starts
`cloudflared` with `--origin-ca-pool`. NetworkPolicy permits the connector to
reach the load balancer only on port `8443`; port `8088` is not an allowed origin
path.

Do not set `noTLSVerify`, `--no-tls-verify`, insecure hostname handling, or an
HTTP origin. The service hostname already matches a certificate SAN, so custom
SNI/Host overrides are unnecessary unless a future routing design explicitly
requires and tests them.

## Direct-client migration

Audit every workload and repository for Fiducia endpoint configuration. For each
direct client:

1. change the endpoint to the canonical HTTPS hostname;
2. mount/reference the approved public CA only;
3. enable normal hostname verification;
4. reject system-root fallback where it would broaden trust;
5. test valid chain/hostname success;
6. test unknown CA, hostname mismatch, expiry, and plaintext failure;
7. deploy one client at a time and record its exact revision;
8. remove its permission and configuration for port `8088`.

Known follow-up clients include ESO, `fiducia-auth`, platform gateways, contract,
billing, build, and any fabrication/worker service that calls the load balancer
directly. The repository contract test rejects tracked runtime URLs beginning
with `http://fiducia-load-balance`.

The load balancer's own node, brain, NATS, and OTLP downstream connections remain
separate TLS work. Do not describe the entire in-cluster mesh as encrypted until
those direct connections also have verified TLS or another documented encrypted
transport.

## Plaintext downgrade

During migration, the process may keep `8088` for probes and a guard response.
The server must:

- serve only the approved health paths;
- return `426 Upgrade Required` or a stricter failure for application paths;
- never redirect a secret-bearing request to HTTPS;
- never proxy or process plaintext application data;
- increment a bounded `fiducia_plaintext_downgrade_rejections_total` metric;
- log only bounded service/failure metadata, without bearer values or payloads.

Final cutover removes the plaintext Service and any NetworkPolicy/client
permission after probes move to a health-only listener.

## Alerts

`base/observability/tls-prometheus-rules.yaml` defines contracts for:

- serving Certificate not Ready;
- serving certificate expiry under seven days;
- TLS handshake failures;
- plaintext downgrade attempts.

Handshake metrics may use a bounded failure class such as `unknown_ca`,
`hostname_mismatch`, `expired`, `revoked`, or `protocol`. Never label metrics by
certificate bytes, serial number, tenant, trace ID, bearer value, or
client-supplied hostname.

### Certificate not Ready

Stop promotion and inspect Certificate, CertificateRequest, Issuer, Secret, and
cert-manager events. Do not print Secret data or private keys.

### Handshake failures

Compare the client hostname, CA fingerprint, leaf fingerprint, validity window,
and bounded failure class. Confirm the client did not fall back to HTTP or
system-root trust.

### Plaintext downgrade

Identify the client workload/revision from bounded logs, migrate or block it, and
remove its `8088` access. A downgrade alert is a security/deployment regression,
not a reason to re-enable plaintext processing.

## Redacted evidence capture

Run:

```sh
scripts/capture-fiducia-internal-tls-evidence.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --output /secure/evidence/fiducia-tls-laptop-aws-sim.json
```

The script reads only `tls.crt` and `ca.crt`, verifies the chain, serverAuth EKU,
required SANs, and seven-day remaining lifetime, then emits mode-`0600` JSON with
public fingerprints, serial, validity dates, and cert-manager revision. It never
requests `tls.key` and never emits certificate bytes.

A passing capture does not prove network reachability or client behavior. Attach
separate live proof for ESO reconciliation, Cloudflare origin health, each direct
client, negative TLS cases, rotation, alerts, and plaintext rejection.

## Live test matrix

Before removing plaintext application reachability, prove:

| Test | Expected result |
|---|---|
| Valid CA and exact service hostname | HTTPS request succeeds |
| Unknown root | TLS handshake fails |
| Correct CA, wrong hostname | TLS handshake fails |
| Expired or not-yet-valid leaf | TLS handshake fails |
| Missing serving Secret | LB pod fails closed; old healthy replica remains |
| Plain HTTP application request | Rejected without redirect or processing |
| ESO without CA provider | Reconciliation fails |
| ESO with `ca.crt` | Representative secret reconciles |
| Cloudflared with CA pool | Origin is healthy |
| Cloudflared with wrong CA | Origin becomes unhealthy; no HTTP fallback |
| Leaf rotation | One-replica-at-a-time restart with no full outage |
| CA overlap rotation | Old/new roots coexist, then old root is removed safely |

Run disruptive tests on one cluster/workload at a time. Preserve healthy replicas
and exact rollback revisions.

## Rollback

Rollback is revision-pinned and must not weaken verification.

- If the new leaf is invalid, restore the prior serving Secret/revision or reissue
  from the current trusted issuer, then restart one replica at a time.
- If a client migration fails, restore its prior HTTPS revision/trust bundle.
  Do not restore plaintext application processing as a normal rollback.
- During CA rotation, retain the overlap bundle and old serving identity until
  every client has proved the new root. Roll back the leaf/issuer before removing
  either root.
- If Cloudflare origin TLS fails, restore the prior verified HTTPS origin and CA
  configuration. `noTLSVerify` and HTTP are prohibited rollback mechanisms.

## Completion gate

DEN-438 remains In Progress until:

- cert-manager creates Ready CA and serving resources in every target cluster;
- ESO reconciles a representative secret through verified HTTPS;
- Cloudflare routes use HTTPS plus the mounted CA pool;
- every audited direct client verifies the intended hostname and CA;
- unknown CA, hostname mismatch, expiry, missing Secret, and downgrade tests fail
  closed;
- leaf and CA overlap rotations are demonstrated without full outage;
- alerts route to an operator;
- plaintext application reachability is removed;
- no certificate private key or bearer value appears in Git, Linear, CI logs,
  Argo output, screenshots, or terminal transcripts.
