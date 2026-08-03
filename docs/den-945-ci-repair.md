# DEN-945 exact-head CI repair note

The first exact-head rerun for PR #22 did not produce acceptable merge evidence.
The laptop-fleet contract referenced the dedicated JetStream test path while
direct branch retrieval of that path was inconsistent.

The response was to restore a substantive test suite, not to remove the workflow
step or weaken the safety boundary. The suite now independently verifies:

- three members and two non-self route peers per member;
- private mTLS route traffic on port 6222;
- no cross-cluster client-port exposure on 4222;
- immutable images, persistence, route-TLS mounts, readiness, and drain behavior;
- fail-closed certificate, SAN, EKU, key, and context checks;
- RF=3 delivery, replay, outbox/inbox, fencing, and idempotency contracts;
- absence of committed private keys or provider credentials;
- explicit separation between CI contracts and live production evidence.

PR #22 may merge only after fresh exact-head laptop-fleet and repository CI runs
both succeed, review threads are resolved, and the branch remains mergeable.
