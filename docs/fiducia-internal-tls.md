# Fiducia verified internal TLS and CA trust

Governing issue: `DEN-438`.

This runbook defines the staged migration from plaintext Fiducia load-balancer application traffic to hostname-verified HTTPS. It covers the serving PKI, canonical in-cluster service, External Secrets Operator trust contract, Cloudflare Tunnel origin verification, direct-client migration, rotation, downgrade rejection, alerts, evidence capture, and rollback.

It does not claim that cert-manager, ESO, Cloudflare routes, direct clients, or physical laptop clusters have completed the live migration.

## Canonical endpoints

Application clients use verified TLS:

```text
https://fiducia-load-balance-tls.fiducia.svc.cluster.local:8443
https://fiducia-load-balance.fiducia.svc.cluster.local:443
```

The first endpoint is canonical for in-cluster clients. Port `8088` is not an application endpoint: during migration it exists only for `/healthz`, `/readyz`, and the load-balancer's explicit `426 Upgrade Required` guard. Remove the plaintext Service after probes move to a dedicated health-only listener.

This runbook supersedes the older plaintext Cloudflare origin example in `docs/laptop-private-mesh-ingress-snapshots.md`.

## Namespaced private PKI

`base/tls/fiducia-internal-pki.yaml` creates a separate PKI inside each `fiducia` namespace:

1. `Issuer/fiducia-selfsigned-bootstrap` creates the initial root Certificate.
2. `Certificate/fiducia-internal-ca` stores the ECDSA root in `Secret/fiducia-internal-ca`.
3. `Issuer/fiducia-internal-ca` signs namespaced leaves.
4. `Certificate/fiducia-load-balance-tls` creates a 30-day ECDSA serving leaf in `Secret/fiducia-load-balance-tls` and renews ten days before expiry.

Using a namespaced bootstrap Issuer keeps the shared Kustomize base overlay-safe and avoids creating a cluster-scoped issuer as a side effect of every application overlay.

No certificate or private-key bytes are stored in Git. The serving Secret is required and mounted read-only with mode `0440`; a missing Secret prevents the load balancer from starting instead of silently disabling TLS.

The serving certificate covers both service families:

```text
fiducia-load-balance[.fiducia[.svc[.cluster.local]]]
fiducia-load-balance-tls[.fiducia[.svc[.cluster.local]]]
```

Each cluster has an independent root. A multi-cluster client must trust an explicit reviewed bundle of those roots, not an arbitrary system or organization-wide CA.

## CA lifecycle

The root CA uses a long lifetime and `rotationPolicy: Never` because root rotation is an explicit trust-distribution operation. Begin overlap rotation at least six months before expiry:

1. Create a new root and issuer under new names.
2. Distribute an old-plus-new public trust bundle to every client.
3. Prove both roots work and unknown roots still fail.
4. Issue a new serving leaf from the new issuer.
5. Restart load-balancer replicas one at a time.
6. Verify ESO, Cloudflare, and each direct client.
7. Remove the old root one client and cluster at a time.
8. Revoke or archive the old signing key according to custody policy.

Never replace all trust and serving identities in one unobserved operation.

## Leaf rotation

The leaf rotates automatically, but the current load balancer loads files at process start. After renewal:

1. Capture old and new public fingerprints without reading `tls.key`.
2. Verify chain, SANs, EKU, and remaining lifetime.
3. Restart one replica.
4. Wait for HTTPS readiness and external probes.
5. Verify ESO and direct clients.
6. Restart the second replica.
7. Record Certificate revision and rollout revision.

Stop on unknown CA, hostname mismatch, expiry, or downgrade behavior.

## External Secrets Operator contract

`contracts/external-secrets/dd-fiducia-kv.clustersecretstore.yaml` is a non-applied contract for the platform repository that owns ESO. It requires:

```yaml
url: https://fiducia-load-balance-tls.fiducia.svc.cluster.local:8443/v1/kv
caProvider:
  type: Secret
  name: fiducia-load-balance-tls
  namespace: fiducia
  key: ca.crt
```

ESO reads only public `ca.crt`; it never receives `tls.key`. The consuming repository retains its existing namespace selector, authorization token, admission policy, key-shape, ownership, and bootstrap controls.

A representative `ExternalSecret` must reconcile only through verified HTTPS. Unknown CA, hostname mismatch, expired leaf, missing CA provider, plaintext URL, and a provider pointing at `tls.key` must fail before an application secret is returned.

## Cloudflare Tunnel origin

Every remotely managed route uses:

```text
service: https://fiducia-load-balance-tls.fiducia.svc.cluster.local:8443
originRequest.caPool: /etc/fiducia/origin-ca/ca.crt
```

The Deployment mounts only `ca.crt`, starts `cloudflared` with `--origin-ca-pool`, and NetworkPolicy permits the load-balancer origin only on `8443`. Do not configure `noTLSVerify`, `--no-tls-verify`, an HTTP origin, or an unnecessary hostname override.

## Direct-client migration

For each direct client:

1. Change the endpoint to the canonical HTTPS hostname.
2. Mount or reference only the approved public CA.
3. Keep hostname verification enabled.
4. Avoid broad system-root fallback.
5. Test valid chain and hostname success.
6. Test unknown CA, wrong hostname, expiry, and plaintext failure.
7. Deploy one client at a time and record its exact revision.
8. Remove its permission and configuration for `8088`.

Known follow-ups include ESO, `fiducia-auth`, gateways, contract, billing, build, and worker/fabrication services. The repository test rejects tracked runtime URLs beginning with `http://fiducia-load-balance`.

The load balancer's own node, brain, NATS, and OTLP downstream connections remain separate TLS work. Do not describe the entire service mesh as encrypted until those paths also use verified TLS or another documented encrypted transport.

## Plaintext downgrade

During migration, `8088` may serve only health probes and a guard response. The server must never redirect, proxy, or process plaintext application requests. It must reject them, increment a bounded downgrade metric, and avoid logging bearer values or payloads.

Final cutover removes the plaintext Service and NetworkPolicy/client permissions after probes move to a health-only listener.

## Alerts

`base/observability/tls-prometheus-rules.yaml` defines contracts for:

- Certificate not Ready;
- serving certificate expiry under seven days;
- TLS handshake failures;
- plaintext downgrade attempts.

Handshake metrics may use bounded failure classes such as `unknown_ca`, `hostname_mismatch`, `expired`, `revoked`, or `protocol`. Never label metrics by certificate bytes, serial, tenant, trace ID, bearer value, or client-supplied hostname.

## Redacted evidence capture

```sh
scripts/capture-fiducia-internal-tls-evidence.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --output /secure/evidence/fiducia-tls-laptop-aws-sim.json
```

The script reads only `tls.crt` and `ca.crt`, verifies the chain, serverAuth EKU, required SANs, and seven-day remaining lifetime, then emits mode-`0600` JSON with public fingerprints, serial, validity dates, and cert-manager revision. It never requests `tls.key` and never emits certificate bytes.

A passing capture does not prove network reachability or client behavior. Attach separate live proof for ESO, Cloudflare origin health, each direct client, negative TLS cases, rotation, alerts, and plaintext rejection.

## Live test matrix

| Test | Expected result |
|---|---|
| Valid CA and exact service hostname | HTTPS succeeds |
| Unknown root | TLS handshake fails |
| Correct CA, wrong hostname | TLS handshake fails |
| Expired or not-yet-valid leaf | TLS handshake fails |
| Missing serving Secret | New LB pod fails closed; old healthy replica remains |
| Plain HTTP application request | Rejected without redirect or processing |
| ESO without CA provider | Reconciliation fails |
| ESO with `ca.crt` | Representative secret reconciles |
| Cloudflared with CA pool | Origin is healthy |
| Cloudflared with wrong CA | Origin is unhealthy; no HTTP fallback |
| Leaf rotation | One-replica-at-a-time restart, no full outage |
| CA overlap rotation | Old/new roots coexist, then old root is removed safely |

Run disruptive tests one cluster or workload at a time and preserve exact rollback revisions.

## Rollback

Rollback must remain verified HTTPS:

- Restore the prior valid serving identity or reissue from the current trusted issuer, then restart one replica at a time.
- Restore a client's prior HTTPS revision or overlap trust bundle; do not restore plaintext application processing.
- During CA rotation, retain old and new roots until every client proves the new root.
- For Cloudflare, restore the prior verified HTTPS origin and CA configuration. HTTP and `noTLSVerify` are prohibited rollback mechanisms.

## Completion gate

DEN-438 remains In Progress until:

- CA and serving resources are Ready in each target cluster;
- ESO reconciles a representative secret through verified HTTPS;
- Cloudflare uses HTTPS and the mounted CA pool;
- every audited direct client verifies the intended hostname and CA;
- unknown CA, mismatch, expiry, missing Secret, and downgrade tests fail closed;
- leaf and CA overlap rotations work without a full outage;
- alerts reach an operator;
- plaintext application reachability is removed;
- no certificate private key or bearer value appears in Git, Linear, Actions logs, Argo output, screenshots, or terminal transcripts.
