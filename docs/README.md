# docs — operator & design docs

Longer-form documentation that doesn't belong in a manifest comment.

- `ROLLOUT.md` — production rollout / upgrade runbook (shipping code without dropping
  client requests or losing quorum).
- `e2e.md` — the two-tier test infrastructure (local kind vs real managed clusters) and
  how the `fiducia-e2e` suite runs against it.
- `observability.md` — the collector-first observability MVP.
- `observability-events.sql` — the CockroachDB TTL-table contract for compact,
  high-value recent ops/security events (not a raw log sink).
