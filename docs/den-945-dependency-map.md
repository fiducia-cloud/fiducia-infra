# DEN-945 dependency map

- DEN-82 owns JetStream delivery, outbox/inbox, replay, DLQ, and fencing semantics.
- DEN-433 and DEN-434 own runtime secret delivery and independent bootstrap.
- DEN-437 owns durable Fiducia state, encrypted backup, and clean restore.
- DEN-438 owns TLS and CA trust.
- DEN-630 owns canonical cross-cluster GitOps records.
- DEN-944 owns immutable per-laptop Argo CD promotion.
- DEN-946 owns live physical-fleet failure, restore, alert, and soak acceptance.
- DEN-947 owns rolling laptop-to-cloud replacement.

PR #22 implements only the messaging substrate portion and must reuse these
contracts rather than redefining them.
