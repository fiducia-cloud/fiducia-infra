# Immutable coordination checkpoint preflight (#227)

The verifier in `tools/verify-coordination-checkpoint.mjs` is deliberately
**read-only and offline**. It authenticates a canonical payload using an
independently trusted Ed25519 public key and key ID, validates its SHA-256 manifest digest,
cluster/shard/epoch/replay boundary and every digest-addressed local object
before any restore can be attempted. It does not access credentials, mutable
URLs, consensus state, object-store APIs or the live cluster.

```sh
node --test tools/verify-coordination-checkpoint.test.mjs
node tools/verify-coordination-checkpoint.mjs \
  checkpoint.json /trusted/downloaded-objects trusted-pubkey.pem \
  key-2026-10 cluster-1 shard-4 9 43
```

Expected object files: `OBJECTS_DIR/sha256/<lowercase-sha256>`. Obtain them
from your provider through a separate authenticated fetcher with immutable
retention and upload completion receipts; never trust a manifest-supplied URL.
A valid cryptographic signature is not authorization to activate a checkpoint.

**Not implemented:** creating signed manifests, upload/retention to S3/R2/GCS,
provider-independent download, protected key custody, streaming resume,
durable replay and gap proof after checkpoint, cluster activation or restore
drills in multiple providers. The operator must verify key revocation, term
authority, log continuity and quorum state independently before bringing
any restored state online. No safety/RTO/RPO claim is made.

Manifest shape:
```json
{
  "payload": {
    "schema": "fiducia.coordination-checkpoint.v1",
    "cluster": "cluster-1",
    "shard": "shard-4",
    "epoch": 9,
    "term": 11,
    "state_schema": "kv-v3",
    "included_log_index": 42,
    "replay_from_log_index": 43,
    "creation_tool": "fiducia-checkpoint-v1",
    "objects": [{ "role": "state", "sha256": "<64 lowercase hex>", "bytes": 1024 }]
  },
  "payload_sha256": "<sha256 of canonical payload>",
  "auth": {
    "algorithm": "ed25519-sha256-v1",
    "key_id": "key-2026-10",
    "signature_base64": "<Ed25519 signature of the 32 raw SHA-256 digest bytes>"
  }
}
```
