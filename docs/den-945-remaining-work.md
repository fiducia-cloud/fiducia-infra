# DEN-945 remaining live work

After PR #22 merges, the following still block completion:

- install the rendered NATS/JetStream profile on all three real laptop clusters;
- materialize unique route certificates and private-mesh identities externally;
- prove valid mTLS routes and invalid-peer rejection;
- create/verify RF=3 critical streams and consumer policies;
- measure real inter-site latency, packet loss, election, lag, and catch-up;
- test non-leader loss, leader loss, asymmetric partition, WAN loss, disk pressure,
  replay, DLQ, fencing, idempotency, member replacement, and rollback;
- restore from encrypted snapshots and database outbox/inbox state;
- complete DEN-946 alerting, device-revocation, RTO/RPO, and seven-day soak gates.

Repository CI cannot close these items.
