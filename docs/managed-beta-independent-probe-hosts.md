# Managed-beta independent external probe hosts

Governing issue: `DEN-1619`.

This runbook turns the already-published managed-beta probe image into a reviewed
host-deployment bundle for two or more external locations. It deliberately does
not create fake production evidence or place two pods in one cluster and call
them independent.

The published probe is:

```text
ghcr.io/fiducia-cloud/fiducia-managed-beta-probe@sha256:cc251cb82f131616e73c070929f4dd9066228d1a90e86c627933f787e63e0941
```

Its source commit is:

```text
a46f116853875b5a3a1b633ab1591253b1bbd4ed
```

## Files

```text
external-probes/managed-beta/fleet.example.json
tools/render-managed-beta-probe-hosts.mjs
tools/managed-beta-probe-hosts.test.mjs
```

The committed inventory is synthetic. It exists only to exercise the validator,
renderer, tests, and CI. Live inventories and generated host files may contain
private topology paths and therefore stay in a restricted evidence/deployment
location outside Git.

## Independence contract

Every location receives a bounded public identity such as `probe-a`; that label
is injected by central Prometheus with `honor_labels: false`. The probe process
never emits or accepts `probe_location`.

A different label is not proof of independence. The live inventory requires a
distinct opaque SHA-256 fingerprint for every location's:

- physical host;
- scheduler;
- runtime identity;
- cumulative state authority;
- probe bearer credential;
- outbound network/provider;
- DNS resolver path;
- local proxy path;
- operator owner.

The state root, textfile root, bearer path, metrics target, serving identity, and
central scrape client identity must also be unique. The hashes are
correlation detectors, not raw hostnames, IPs, account names, site descriptions,
or credentials. Derive them using an approved keyed procedure and keep the
source values and key outside Git and Linear.

DEN-1619 still requires an independent reviewer to inspect the real inventory.
The renderer cannot prove that opaque hashes truthfully describe separate
failure domains.

## Exact operation matrix

Each location must run all six bounded producers with a separate cumulative
state file and textfile output:

- `health`;
- `linearizable_read`;
- `committed_write`;
- `renewal`;
- `secret_read`;
- `watch_reconcile`.

A fresh health probe cannot satisfy the independence gate for a missing or stale
write, secret-read, renewal, or watch source. The central rules count fresh
locations per `cell` and `operation_class`.

Endpoints must use HTTPS DNS names, contain no userinfo, fragment, query string,
or customer resource key, and use only the approved methods and expected status
sets. Live mode rejects `.invalid` example targets.

## Render an example rehearsal

```sh
output="$(mktemp -d)"
node tools/render-managed-beta-probe-hosts.mjs \
  --inventory external-probes/managed-beta/fleet.example.json \
  --output-dir "$output" \
  --allow-example
```

The output contains, per location:

```text
locations/<id>/env/<operation>.env
locations/<id>/systemd/fiducia-managed-beta-probe-<id>-<operation>.service
locations/<id>/systemd/fiducia-managed-beta-probe-<id>-<operation>.timer
locations/<id>/systemd/fiducia-managed-beta-node-exporter.service
locations/<id>/node-exporter-web.yml
locations/<id>/node-exporter.sha256
```

It also contains:

```text
central-prometheus/managed-beta-external-probes.yml
manifest.json
```

Environment and exporter web-config files are mode `0600`; systemd units,
timers, scrape config, checksums, and the manifest are mode `0644`. Directories
are mode `0700`.

## Live render boundary

Create a separate live inventory outside the checkout and set:

```json
{
  "evidenceMode": "live"
}
```

Render outside Git:

```sh
node tools/render-managed-beta-probe-hosts.mjs \
  --inventory /secure/evidence/den-1619/probe-fleet.json \
  --output-dir /secure/deploy/den-1619/probes
```

The renderer refuses to write live material anywhere inside the repository. It
also rejects an existing nonempty output directory unless `--overwrite` is
explicit.

## Host prerequisites

Each location must be a genuinely separate Linux host or scheduler failure
domain. Prepare independently on each host:

1. a non-root `fiducia-probe` account;
2. rootless Podman at the reviewed version;
3. the published image pre-pulled by digest;
4. a reviewed `node_exporter` binary whose SHA-256 matches the live inventory;
5. one private bearer file for that location only;
6. one server leaf/key and Prometheus client CA for the mTLS metrics listener;
7. one distinct central Prometheus client leaf/key/CA path;
8. private state and textfile directories owned by the runtime user;
9. host firewall rules that expose TCP 9100 only to the central monitoring
   identity/private path;
10. host egress policy that permits only minimum DNS and the reviewed Fiducia
    HTTPS target.

Standard rootless Podman networking cannot enforce an FQDN egress allowlist.
The rendered unit therefore states this as an external host-firewall or egress-
gateway requirement rather than claiming the container flags solve it.

Never reuse one bearer, state directory, metrics certificate, scheduler, or
persistent disk between locations.

## Probe service hardening

Every operation unit uses:

- the immutable image digest with `--pull=never`;
- a non-root systemd user and rootless `--userns=keep-id` container;
- read-only root filesystem;
- all capabilities dropped;
- no-new-privileges;
- bounded PID, memory, CPU, and temporary filesystem limits;
- rootless slirp networking with host-loopback disabled;
- one read-only bearer-file mount;
- one writable location-specific state mount;
- one writable location-specific node-exporter textfile mount;
- an environment file containing endpoint/configuration paths but no bearer
  value and no `probe_location`.

The one-shot producer acquires its own exclusive state lock. A systemd timer does
not start a second copy of the same oneshot while its service remains active.
Timers use persistent scheduling and location-specific jitter.

## Metrics serving and central scrape

The host exporter enables only the textfile collector and verifies its binary
checksum before startup. Its exporter-toolkit web configuration requires TLS 1.3
and `RequireAndVerifyClientCert`.

The generated central Prometheus configuration creates one job per location:

- `honor_labels: false`;
- HTTPS `/metrics`;
- trusted `probe_location` injection;
- exact target and server name;
- location-specific CA/client certificate/private-key file paths;
- TLS 1.3.

Binding the exporter to port 9100 does not establish network trust. The host
firewall must restrict it to the approved central Prometheus identity or private
mesh path.

Merge the generated jobs through the deployment-specific Prometheus
configuration path, then apply the current
`observability/managed-beta-stack` overlay. Do not commit live certificate keys
or monitoring credentials.

## Installation order

For one location at a time:

1. review the live inventory and rendered manifest fingerprints;
2. create the runtime account and private directories;
3. install and checksum the exact node-exporter binary;
4. install bearer and mTLS material through the approved secret path;
5. install environment files under
   `/etc/fiducia-managed-beta-probe/<location>/`;
6. install the exporter web config and checksum file under the same directory;
7. install systemd service/timer files;
8. run `systemd-analyze verify` on the installed units;
9. start the mTLS textfile exporter;
10. manually run each probe service and inspect bounded journal output;
11. verify state and `.prom` files are created and owned by the runtime user;
12. enable timers;
13. add that target to central Prometheus;
14. verify target health, trusted label injection, rules, dashboard, and alerts;
15. repeat on the second independent location only after the first is stable.

## Required live drills

After both locations are queryable:

1. Stop location A while B remains healthy. The exact operation classes for A
   must become stale and fresh-location count must fall to one.
2. Stop both locations. No-data, stale-source, and lost-independence alerts must
   fire; availability must not render as 100%.
3. Restart every operation service and the host. Cumulative counters must not
   reset.
4. Present a duplicate scrape/producer authority. Duplicate-authority detection
   must fire even though bounded aggregation removes ordinary `job`/`instance`
   labels from exported evidence.
5. Corrupt or identity-mismatch a state file. The producer must fail before
   issuing the external operation and must not create a new lineage.
6. Rotate/revoke location A's bearer without affecting B, then repeat for B.
7. Verify a fresh `health` source cannot mask a missing `secret_read`,
   `committed_write`, or `watch_reconcile` source.
8. Exercise mTLS client rejection, server-name mismatch, certificate expiry,
   and unknown-CA failure without falling back to plaintext.

## Evidence and maturity

Attach to DEN-1619:

- restricted live inventory and independent review;
- rendered manifest fingerprint and exact source/image revisions;
- host configuration commits or immutable deployment records;
- node-exporter binary checksums;
- systemd unit/timer status and restart continuity;
- central Prometheus target and rule status;
- Grafana and Alertmanager references;
- stale-source, duplicate-authority, no-data, per-operation independence,
  credential-rotation, state-corruption, and mTLS reports;
- cardinality and canary-secret scan results.

Status progression remains honest:

- `instrumented` only after both real locations emit every operation class;
- `queryable` only after central scrape, rules, alerts, dashboard, freshness, and
  duplicate/no-data behavior are live;
- `measured` only after the complete exact-candidate observation window is
  exported and independently reviewed.

A rendered example or green CI run proves only the deployment contract. It does
not prove that either external location exists or is independent.
