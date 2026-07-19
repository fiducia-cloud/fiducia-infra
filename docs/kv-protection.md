# Fiducia KV protection and key rotation

Fiducia KV can store ordinary configuration and secrets through the same API. When a protection
backend is configured, writes are encrypted before they enter Raft, snapshots, or persistent
volumes. Callers receive plaintext only after a successful read authorization and decryption.
Unencrypted storage remains available only through an explicit `plaintext: true` write.

The deployment contract is cloud-neutral. `fiducia-node` consumes a dedicated Kubernetes Secret
named `fiducia-kv-protection`; an External Secrets controller, Secrets Store CSI driver, Vault
Agent, platform KMS bridge, or an operator can populate it. The manifests never contain key
material or bind the workload to AWS, Azure, GCP, Hetzner, or another infrastructure vendor.

## Protection backends

Choose exactly one backend. A partial backend configuration makes the node fail during startup.
An absent configuration preserves compatibility for existing non-secret KV workloads, but the node
reports that no default at-rest protection is active.

### External Vault Transit-compatible backend

Populate these keys in `fiducia-kv-protection`:

| Environment key | Required | Meaning |
| --- | --- | --- |
| `FIDUCIA_KV_VAULT_ADDR` | yes | HTTPS Vault base URL; HTTP is accepted only for loopback or private internal hosts |
| `FIDUCIA_KV_VAULT_TOKEN` | yes | short-lived token permitted to encrypt and decrypt only the selected Transit key |
| `FIDUCIA_KV_VAULT_KEY` | yes | Transit key name |
| `FIDUCIA_KV_VAULT_MOUNT` | no | Transit mount name; defaults to `transit` |
| `FIDUCIA_KV_VAULT_NAMESPACE` | no | Vault Enterprise namespace header |

The token should come from workload identity or an external injector and should be renewable or
replaced by a rollout before expiry. Do not grant the data-plane token permission to create,
delete, configure, or rotate Transit keys. Rotation belongs to a separate operator identity.
Fiducia records the Vault ciphertext version and continues to decrypt older versions supported by
the provider.

The Vault address must not contain credentials, a query, or a fragment. Redirects are disabled so
the token cannot be forwarded to an unexpected host. Encryption context binds every ciphertext to
its organization-scoped Fiducia storage key, preventing a ciphertext copied to another key from
being accepted there.

#### Network access

The shared namespace is default-deny for egress. A Transit service in the `fiducia` namespace is
reachable through the existing east-west policy; an out-of-cluster service is intentionally blocked
until that cluster's overlay adds a least-privilege egress rule for the provider's exact CIDR and TCP
port (normally 443 or 8200). Do not add unrestricted HTTPS or Vault egress to the shared base.

Standard Kubernetes `NetworkPolicy` cannot allow a DNS name, so operators must keep the provider
CIDR current or use the cluster's supported FQDN-aware policy mechanism (for example, a scoped
Cilium policy) in that overlay. DNS egress is already allowed to CoreDNS. Verify Transit reachability
from a node pod before enabling the Secret; otherwise protection fails closed and KV reads/writes
return unavailable instead of falling back to plaintext.

### Local keyring

For disconnected environments, populate:

| Environment key | Required | Meaning |
| --- | --- | --- |
| `FIDUCIA_KV_ENCRYPTION_KEYS` | yes | JSON object mapping non-secret key IDs to base64-encoded 32-byte AES-256 keys |
| `FIDUCIA_KV_ENCRYPTION_ACTIVE_KEY_ID` | yes | key ID used for new writes |

Keep the JSON value in an external secret store and inject it; never commit it. The legacy
`FIDUCIA_KV_ENCRYPTION_KEY` single-key setting remains readable for migration, but a versioned
keyring is required for safe rotation. Local ciphertext uses AES-256-GCM with a fresh random nonce
and organization-scoped storage-key associated data.

## API behavior

- `PUT /v1/kv` encrypts by default when a backend is active.
- `PUT /v1/kv` with `"plaintext": true` stores an intentionally unencrypted value.
- `GET /v1/kv?key=...` and `GET /v1/kv?prefix=...` include `protection.at_rest`, plus provider/key-version
  metadata when available.
- A missing key, unavailable Vault, malformed envelope, retired key, or authentication failure
  returns a protection-unavailable error. Fiducia never falls back to plaintext and never returns
  opaque ciphertext as if it were the caller's value.
- Authorization, compare-and-swap, TTL, and organization scoping apply identically to encrypted and
  plaintext entries.

Applications should allowlist the Fiducia keys they read, let process environment variables take
precedence, and avoid logging values or provider error bodies. Secret consumers should reject
legacy responses whose protection state is unknown unless they are performing an explicit migration.

## Rotation runbooks

### Vault Transit

1. Use a separate operator identity to rotate the configured Transit key in the external provider.
2. Verify that the provider retains older decryptable key versions and that its minimum decryption
   version has not advanced past live Fiducia ciphertext.
3. Write and read a canary Fiducia key. Its response metadata should show the new provider key
   version.
4. Re-write long-lived secret entries so their ciphertext moves to the new version.
5. After inventory confirms that no required entry uses an old version, advance the provider's
   minimum decryption version according to the provider's retention policy.

Fiducia deliberately does not grant its runtime token rotation privileges. It handles rotation by
accepting the provider's new ciphertext version for writes while retaining read compatibility with
older versions. This separation prevents a compromised data-plane node from rotating or destroying
the root of trust.

### Local keyring

1. Generate a new 32-byte key in the external secret store and add it under a new key ID. Keep all
   currently required old IDs in `FIDUCIA_KV_ENCRYPTION_KEYS`.
2. Set `FIDUCIA_KV_ENCRYPTION_ACTIVE_KEY_ID` to the new ID and roll the node StatefulSet.
3. Write and read a canary. Response metadata should show the new key ID.
4. Re-write existing secret entries; reads use their recorded old ID, while each write uses the new
   active ID.
5. Remove an old key only after inventory and restore testing prove that no live Raft entry,
   snapshot, backup, or rollback target depends on it.

Key removal is intentionally fail-closed. Losing an old key before all dependent data and backups
expire makes those values unrecoverable.

## Migration and rollback

Enabling a backend protects new writes; it does not silently rewrite existing plaintext entries.
Use response protection metadata to inventory them, then read and write each approved secret through
an authenticated client. Plain configuration may remain explicitly plaintext if policy allows it.

Before a rollout, retain the previous key versions and test backup restore with the same external
provider. A rollback must keep both the old and new key versions available because newly written
ciphertext may already depend on the new version.
