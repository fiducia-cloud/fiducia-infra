# Fiducia bootstrap secrets and ESO/store readiness

Governing issue: `DEN-434`.

Fiducia cannot recover its own reader credential, encryption keyring, trusted-hop secrets, JWT material, database credentials, or CSRF material from the Fiducia KV that depends on those values. The six objects in this runbook therefore live in an independent protected cloud recovery store and are materialized through External Secrets Operator.

This repository defines object/property/key contracts and value-free evidence. It does not create, read, print, or store the actual secret values.

## Required cloud objects

| Cloud object | Required properties | Kubernetes target |
|---|---|---|
| `dd/remote-dev/fiducia-eso-reader` | `FIDUCIA_API_KEY` | `external-secrets/fiducia-eso-reader` key `token` |
| `dd/remote-dev/fiducia-kv-protection` | `FIDUCIA_KV_ENCRYPTION_KEYS`, `FIDUCIA_KV_ENCRYPTION_ACTIVE_KEY_ID` | `fiducia/fiducia-kv-protection` |
| `dd/remote-dev/fiducia-cluster-secrets` | `FIDUCIA_INTERNAL_SECRET`, `FIDUCIA_BRAIN_RAFT_SECRET` | `fiducia/fiducia-cluster-secrets` |
| `dd/remote-dev/fiducia-auth-secrets` | JWT, introspection, idempotency, API-key pepper, and Supabase properties | `fiducia/fiducia-auth-secrets` |
| `dd/remote-dev/fiducia-backend-secrets` | database, Supabase, and customer CSRF properties | `fiducia/fiducia-backend-secrets` |
| `dd/remote-dev/fiducia-admin-secrets` | admin CSRF, database, and Supabase properties | `fiducia/fiducia-admin-secrets` |

The exact mapping is versioned in:

```text
bootstrap/fiducia-secret-contract.json
contracts/external-secrets/fiducia-bootstrap.externalsecret.yaml
```

The ExternalSecret manifest is a reference contract and is not included by `base/kustomization.yaml`; the platform repository owns ESO, the independent cloud store, Argo ordering, and admission policy.

## Secret-generation rules

Create values only through the protected cloud-secret UI/CLI or another approved process that prevents them from entering shell history, process lists, screenshots, tickets, Git, Actions logs, or terminal transcripts.

- Use independent random values for unrelated trust domains.
- The ESO API key belongs to a dedicated Fiducia cluster organization and has exactly `kv:read`; it must not have write, admin, user-management, billing, or organization-management scope.
- `CUSTOMER_API_KEY_PEPPER` and `FIDUCIA_KEY_IDEMPOTENCY_SECRET` each contain at least 32 bytes and no whitespace.
- The KV encryption keyring retains every historical key ID needed to decrypt existing ciphertext or retained backups; the active key ID must be present in that keyring.
- Database, Supabase, JWT, CSRF, trusted-hop, Raft, idempotency, pepper, and KV-encryption trust domains are not reused merely for convenience.
- Record rotation owner and emergency recovery owner for every cloud object.
- Record only property names, lengths/shape results, scope names, key IDs, and opaque proof identifiers. Never record a value or a reversible value-derived artifact.

`independenceProofId` is an opaque restricted audit reference proving that unrelated trust domains were generated independently. It is not a hash of a low-entropy or guessable secret.

## Rollout order

1. Create all six cloud objects and required properties.
2. Verify the ESO reader's dedicated organization and exact `kv:read` scope.
3. Verify pepper/idempotency byte length and whitespace checks without exporting values.
4. Verify the encryption keyring contains the active and full historical key-ID set.
5. Sync External Secrets Operator and `ClusterSecretStore/dd-cluster-secrets`.
6. Materialize `external-secrets/fiducia-eso-reader`.
7. Sync and verify `ClusterSecretStore/dd-fiducia-kv` over verified HTTPS/CA trust from DEN-438.
8. Materialize the five Fiducia namespace secrets.
9. Confirm all six ExternalSecrets are Ready and refreshing in every laptop cluster.
10. Confirm both stores are Ready in every cluster.
11. Confirm target Secrets contain exactly the expected key **names**.
12. Obtain independent review before starting dependent hardened workloads.

Do not sync hardened workloads first and attempt to repair missing bootstrap secrets afterward. Missing material is intentionally fail-closed.

## ExternalSecret lifecycle contract

Every bootstrap ExternalSecret:

- uses `apiVersion: external-secrets.io/v1`;
- references `ClusterSecretStore/dd-cluster-secrets`;
- refreshes every 15 minutes;
- enumerates each property through `spec.data`;
- never uses `dataFrom` bulk extraction;
- uses `creationPolicy: Owner`;
- uses `deletionPolicy: Retain`;
- targets the exact workload-bound Secret name.

The dynamic Fiducia store `dd-fiducia-kv` is separate. Its reader credential is materialized by the cloud store; it must not bootstrap itself.

## Value-free cluster capture

Run once per laptop cluster:

```sh
scripts/capture-fiducia-bootstrap-readiness.sh \
  --cluster laptop-aws-sim \
  --context fiducia-laptop-aws-sim \
  --output /secure/evidence/laptop-aws-sim-bootstrap-readiness.json
```

The script captures:

- ClusterSecretStore metadata and conditions for `dd-cluster-secrets` and `dd-fiducia-kv`;
- ExternalSecret namespace/name, generation, refresh interval, store reference, target lifecycle, remote key/property **names**, conditions, refresh time, and synced resource version;
- materialized Kubernetes Secret **key names only**;
- SHA-256 fingerprints of those redacted metadata packets.

It deliberately does not read:

- Secret values;
- entire Secret JSON/YAML objects;
- cloud object values;
- bearer material;
- workload environment;
- private keys;
- database or customer data.

It performs no apply, patch, delete, replace, scale, rollout, cordon, drain, or cloud mutation. The output is `captureOnly: true` and `productionApproval: false`; it still needs protected cloud-object checks and independent approval.

## Full evidence validator

Example-only rehearsal:

```sh
node tools/validate-fiducia-bootstrap-secret-readiness.mjs \
  --evidence bootstrap/fiducia-secret-readiness.example.json \
  --allow-example \
  --now 2026-08-03T20:30:00Z
```

Live evidence:

```sh
node tools/validate-fiducia-bootstrap-secret-readiness.mjs \
  --evidence /secure/evidence/fiducia-bootstrap-readiness-live.json
```

The validator requires:

- exactly six cloud objects and twenty required properties;
- property-name equality, existence proof, rotation/recovery owners, rotation freshness, and independent trust-domain proofs;
- dedicated ESO organization and exact `kv:read` scope;
- 32-byte/no-whitespace pepper and idempotency checks;
- complete KV historical keyring and active key ID;
- both stores Ready in all three clusters;
- all six ExternalSecrets Ready in all three clusters;
- refresh times no older than 30 minutes;
- exact Kubernetes Secret key names;
- live observation no older than 60 minutes;
- no unresolved critical finding;
- distinct operator and reviewer approvals after observation.

It rejects example proof IDs in live mode, unknown/missing/extra properties, broad API scopes, stale refreshes, wrong key names, reused independence proof, self-approval, and any credential/private-key or explicit secret-value field.

## Rotation

Rotate one cloud object/trust domain at a time.

1. Verify both stores and all ExternalSecrets are Ready.
2. Create the new value in the protected store without printing it.
3. Preserve overlap where the consuming protocol supports it—for example KV decryption keyrings and JWT verification keys.
4. Wait for every cluster's ExternalSecret refresh.
5. Verify target Secret key names and resource versions without reading values.
6. Restart or roll one dependent replica at a time where processes load values only at startup.
7. Exercise the relevant auth, KV, database, CSRF, introspection, or trusted-hop behavior.
8. Revoke the old value only after all consumers prove the new one.
9. Record rotation, rollback, and emergency owner proof IDs.

For encryption keys, never delete a historical key while live ciphertext or retained backups require it.

## Break-glass recovery

The emergency path must be independent of the live Fiducia KV and documented per object. It includes:

- identity allowed to access the protected cloud store;
- second-person approval where required;
- recovery from a clean operator workstation;
- audit logging;
- ESO reader recreation with exactly `kv:read`;
- store and ExternalSecret readiness verification;
- target key-name verification;
- immediate revocation/rotation of temporary recovery credentials;
- incident and post-recovery evidence references.

Do not copy values into a ticket or use a broadly privileged personal key as a shortcut.

## Completion gate

DEN-434 remains In Progress until live evidence proves:

- all six cloud objects exist with every required property;
- ESO reader organization/scope is correct;
- pepper/idempotency and keyring checks pass;
- both stores and all six ExternalSecrets are Ready and refreshing in all three clusters;
- target Secrets have exact key names;
- rotation and break-glass ownership is reviewed;
- no value or bearer material appears in Git, Linear, Actions, Argo output, screenshots, or transcripts.
