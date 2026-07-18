# docs — operator & design docs

Longer-form documentation that doesn't belong in a manifest comment.

- `provisioning-status.md` — **live provisioning state + what needs shoring up**:
  the actual account/apply state of the three-cloud fleet, the current blockers
  (Hetzner server limit, Vultr billing, Civo signup), the single-VM tradeoff, the
  Vultr/Cilium mesh gap, remote-state and firewall-CIDR must-fixes, and the
  ordered next steps to first light. Read this before the next `terraform apply`.
- `hardening-report.md` — the multi-cloud audit sweep (terraform/manifests/CI):
  every item Fixed or Accepted, validated against the local kind emulation.
- `multi-cluster-architecture.md` — **the architecture reference**: how fiducia runs
  as one system across the three clouds (hetzner/vultr/civo), the two Raft layers,
  pod/machine placement, cross-cluster transport, and the provider-swap model.
  Diagrams in Mermaid.
- `architecture.puml` — the same architecture as UML (component + deployment +
  write-path sequence). Render with `plantuml docs/architecture.puml`.
- `ROLLOUT.md` — production rollout / upgrade runbook (shipping code without dropping
  client requests or losing quorum).
- `e2e.md` — the two-tier test infrastructure (local kind vs real managed clusters) and
  how the `fiducia-e2e` suite runs against it.
- `observability.md` — the collector-first observability MVP.
- `observability-events.sql` — the CockroachDB TTL-table contract for compact,
  high-value recent ops/security events (not a raw log sink).
