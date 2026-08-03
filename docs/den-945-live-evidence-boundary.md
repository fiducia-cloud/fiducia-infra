# DEN-945 live evidence boundary

The merged software profile may prove rendering, immutable image selection,
route-peer topology, policy, certificate-validation behavior, and deterministic
evidence schemas. It cannot prove the behavior of the three physical laptops.

DEN-945 remains open until independently captured live evidence proves:

1. all three NATS/JetStream members are healthy over the private mesh;
2. route mTLS rejects missing, expired, wrong-CA, wrong-SAN, and wrong-EKU peers;
3. critical RF=3 streams retain acknowledged messages after any one member loss;
4. consumer acknowledgement floors, deduplication, redelivery, DLQ, and replay
   remain consistent through leader changes;
5. protected external mutations remain fenced and idempotent;
6. one member can be upgraded or replaced while the other two remain stable;
7. encrypted snapshots and the database outbox/inbox path restore service;
8. latency, storage, thermal, and WAN behavior stays inside the documented
   pre-funding operating envelope.

No CI workflow, example evidence file, or rendered manifest may be cited as a
substitute for those observations.
