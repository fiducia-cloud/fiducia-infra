# DEN-945 stateful change control

Only one quorum-bearing member may be changed at a time.

Before a change:

1. verify all three members are healthy and fully caught up;
2. capture current Fiducia and JetStream leaders;
3. confirm current off-host backups and recovery keys;
4. acquire the membership/change lease with fencing;
5. remove the selected cluster from public traffic;
6. choose a follower unless leadership has been deliberately transferred.

After a change:

1. prove route mTLS and exact peer membership;
2. wait for zero known Raft and critical-stream lag over the stable interval;
3. verify consumer acknowledgement floors and outbox/inbox replay;
4. exercise a fenced, idempotent protected mutation;
5. restore traffic gradually and inspect external probes;
6. release the change lease only after the stable checkpoint is recorded.

Never overlap a member change with another member change, key rotation, restore,
network migration, or destructive storage operation.
