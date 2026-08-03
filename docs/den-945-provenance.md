# DEN-945 provenance requirements

Every rendered messaging bundle must be attributable to the exact source
revision, topology fingerprint, renderer version, immutable image digest, and
cluster identity. The provenance bundle may contain hashes and public metadata,
but never private keys, bearer credentials, or customer payloads.

A live deployment record must additionally capture the applied Kubernetes
resource revisions and external secret/certificate fingerprints without
recording secret values.
