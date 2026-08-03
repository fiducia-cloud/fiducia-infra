# DEN-945 rollback boundary

Before a membership commit, remove the uncaught-up target replica/learner and
restore the existing source member and traffic. After a membership commit, never
simply restart an old disk as a voter. Reintroduce the source as a non-voting,
non-routing member, catch it up from the current authoritative configuration,
verify streams/consumers/fencing/replay, and replace the failed target through
the supported membership API one member at a time.

Rollback must preserve PostgreSQL outbox/inbox authority, immutable Git/image
revisions, encrypted snapshots, and the current majority. Stop the rollout if
persisted-state compatibility is uncertain.
