# DEN-945 live failure-test order

Run disruptive tests one at a time and restore a fully caught-up three-member
state before the next test.

1. Baseline stream/consumer/route/leader and backup observations.
2. Reject invalid route credentials without disturbing valid peers.
3. Stop one non-leader NATS member; prove RF=3 critical delivery and catch-up.
4. Stop the current JetStream leader; prove election, delivery, and no duplicate
   protected mutation.
5. Interrupt one private-mesh route in one direction; prove partition behavior.
6. Disconnect one laptop WAN; prove two-member quorum and healthy origins.
7. Apply bounded disk/I/O pressure; prove alerts and fail-safe backpressure.
8. Replay from database outbox/inbox and exercise DLQ recovery.
9. Upgrade one follower, wait for catch-up, repeat, and upgrade the leader last.
10. Replace one member from clean hardware and external encrypted backups.
11. Revoke a simulated stolen laptop identity and prove it cannot rejoin.
12. Restore baseline, verify all alerts closed, and begin the DEN-946 soak.

Abort on any fencing, idempotency, acknowledged-delivery, backup, restore, or
quorum-safety failure. Do not continue merely to complete the matrix.
