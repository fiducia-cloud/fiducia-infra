# DEN-945 operator evidence checklist

Before requesting completion review, attach redacted evidence for every item.
Do not attach credentials, private keys, customer payloads, private addresses, or
raw security-sensitive topology data.

- [ ] Exact Git commit and immutable NATS image digest deployed to each laptop.
- [ ] Three unique server identities and exactly two authenticated route peers per member.
- [ ] `/routez`, `/jsz`, stream, consumer, replica, and leader observations captured.
- [ ] RF=3 critical streams and explicitly disposable lower-durability streams enumerated.
- [ ] Current leader loss and non-leader loss tested independently.
- [ ] Wrong-CA, wrong-SAN, wrong-EKU, expired, and absent route certificates rejected.
- [ ] Database outbox/inbox replay and Fiducia fencing/idempotency exercised.
- [ ] Redelivery, deduplication, acknowledgement floor, DLQ, and replay verified.
- [ ] One-member replacement and follower-first, leader-last upgrade completed.
- [ ] Encrypted snapshot and clean replacement restore completed.
- [ ] WAN latency/loss, disk use/I/O, CPU, memory, temperature, and catch-up measured.
- [ ] Alert delivery proved for quorum, route, lag, disk, backup, and restore-test age.
- [ ] Evidence validator accepts live evidence without `--allow-example`.
- [ ] DEN-946 physical-fleet campaign and seven-day soak reference attached.
