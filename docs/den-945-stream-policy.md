# DEN-945 stream durability classes

Critical workflow and protected-mutation streams use replication factor 3,
bounded retention sized from measured disk headroom, explicit durable consumers,
deduplication, DLQ, and database outbox/inbox replay. They must survive loss of
one member without losing acknowledged messages.

Disposable progress, sampled telemetry, and rebuildable notifications may use a
lower durability class only when their loss has no authoritative effect. Their
subjects, storage budgets, retention, and consumers must be separate from
critical streams so they cannot exhaust recovery headroom.

JetStream is never the sole system of record for protected workflow state.
