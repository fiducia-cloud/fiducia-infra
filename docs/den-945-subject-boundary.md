# DEN-945 subject and tenant boundary

NATS subjects must not encode unbounded customer-controlled values as metric
labels or grant broad wildcard access across tenants. Subject naming, publish/
subscribe permissions, stream filters, and consumer identities must preserve the
application tenancy model and the cross-cluster identity isolation introduced by
PR #21.

Exact run, tenant, trace, and message identifiers belong in redacted logs/traces
and durable application records, not in unbounded Prometheus label sets.
