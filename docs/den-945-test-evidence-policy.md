# DEN-945 evidence policy

Evidence must identify its mode as `example` or `live`. Example evidence may be
used only for schema, planner, and CI tests. It must be rejected by production
approval commands unless an explicit non-production flag is present.

Live evidence must be fresh, attributable, redacted, tied to exact Git and image
revisions, and cover every required member, stream, consumer, route, backup,
alert, and failure scenario. Placeholder proof identifiers cannot satisfy a live
gate.
