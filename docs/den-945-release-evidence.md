# DEN-945 release evidence bundle

For each candidate revision, retain a redacted bundle containing:

- exact Git commit and immutable container digests;
- rendered cluster/member/route fingerprints;
- certificate subject/SAN/issuer/serial/fingerprint and validity metadata only;
- `/routez`, `/jsz`, stream, consumer, replica, leader, and lag summaries;
- database outbox/inbox replay and fencing/idempotency results;
- snapshot and restore proof identifiers;
- failure-test start/end timestamps and operator identity;
- alert receipt and resolution references;
- measured RTO/RPO, message loss, duplicate-mutation count, and catch-up time;
- explicit `live` or `example` evidence mode;
- unresolved findings and launch decision.

Never include private keys, bearer tokens, customer payloads, raw secret values,
or unrestricted internal network maps.
