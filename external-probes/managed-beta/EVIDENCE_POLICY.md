# Managed-beta evidence policy derived from the fleet schedule

The external-probe host kit uses systemd timers with an active interval and a
randomized delay. The exact-candidate exporter must not assume a faster cadence
than the slowest possible timer, or a correctly deployed fleet can fail the
historical coverage gate by construction.

Generate the non-secret exporter policy from the reviewed fleet JSON:

```bash
node tools/render-managed-beta-evidence-policy.mjs \
  --fleet external-probes/managed-beta/fleet.example.json \
  --output-dir /tmp/fiducia-managed-beta-evidence-policy
```

The renderer writes:

- `availability-policy.json` — source fleet digest, immutable probe image,
  bounded cells/operations/locations, each location's interval and randomized
  delay, the conservative coverage calculation, and explicit limitations;
- `availability-policy.env` — only the bounded environment values consumed by
  the exact-candidate exporter.

## Cadence calculation

For each location:

```text
maximum_schedule_interval_seconds = interval_seconds + randomized_delay_seconds
```

The exporter-wide expected interval is the maximum across all declared
locations. This is conservative and deterministic: it does not use the average
random delay and does not let a faster location hide a slower schedule.

The renderer then derives:

```text
expected_observations_per_source_28d = floor(28 days / expected interval)
minimum_samples_per_source_28d = floor(expected observations × 0.95)
```

Source freshness is at least four conservative intervals and never below five
minutes. The maximum age of last success is at least twelve intervals and never
below fifteen minutes.

For the reviewed two-location example, the timer maxima are 75 and 80 seconds, so
exporter evidence must use an 80-second expected interval rather than the raw
60-second active interval.

## Security and privacy boundary

The generated artifacts intentionally exclude:

- probe endpoint URLs;
- credential or certificate paths;
- hostnames and public IP addresses;
- state directories and service-account identities;
- failure-domain fingerprints or free-form site descriptions;
- customer, request, trace, or secret material.

Those details remain in the access-controlled deployment inventory. The policy
artifacts are safe to attach to the bounded exact-candidate evidence bundle, but
they do not prove that any host is deployed or physically independent.

## Required additional exporter inputs

This renderer does not invent or infer:

- exact source, configuration, and SLO-rules commits;
- runtime image digests beyond the probe image declared in the fleet;
- completed observation-window timestamps;
- Prometheus target identity;
- dashboard revision;
- independence reviewer or attestation.

Those values must be supplied explicitly at evidence-export time and reviewed
under DEN-1619 and DEN-1654.
