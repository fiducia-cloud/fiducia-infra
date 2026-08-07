# DEN-945 JetStream HA test matrix

This matrix separates repository contracts from live acceptance evidence.

| Area | Repository/CI proof | Live proof still required |
|---|---|---|
| Membership | Exactly three configured members and two non-self peers per member | All three members visible in `/routez` and JetStream metadata |
| Route security | Route TLS paths, verification, SAN/EKU/key checks, private port 6222 policy | Successful mutual authentication and rejected invalid/expired/wrong-SAN certificates |
| Persistence | Local PVC and JetStream storage directory are rendered | Snapshot/restore and member replacement on encrypted laptop disks |
| Delivery | RF=3 policy, outbox/inbox, fencing, replay, and idempotency contracts | Acknowledged delivery through leader loss, redelivery, replay, and DLQ operations |
| Rollout | One-member-at-a-time, follower-first, leader-last scripts and documentation | Real rolling upgrade with catch-up evidence between each member |
| Failure | Deterministic validators reject missing/stale/example evidence | Power pull, ISP loss, asymmetric partition, disk pressure, and route interruption |
| Secrets | No private keys or provider credentials in Git | External secret materialization, rotation, and stolen-device revocation |

Green CI is necessary but never sufficient to mark DEN-945 or DEN-946 complete.
