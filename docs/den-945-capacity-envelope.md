# DEN-945 pre-funding messaging capacity envelope

The laptop fleet starts with deliberately conservative limits. Record actual
values during DEN-946 and lower them if thermal, storage, WAN, or catch-up tests
show instability.

- Keep sustained CPU, memory, disk, I/O, and upload bandwidth below 60% of the
  measured safe capacity.
- Alert before 70% disk use and page before 85%.
- Critical JetStream streams use replication factor 3 only after measured WAN
  behavior satisfies the recovery target.
- Disposable telemetry/progress traffic must use separate lower-cost retention
  and must not consume critical-stream recovery headroom.
- Pause producers or apply bounded backpressure before disk exhaustion.
- Trigger cloud migration when safe capacity, customer SLOs, or operator burden
  exceed the laptop substrate.

These are operating constraints, not contractual customer SLAs.
