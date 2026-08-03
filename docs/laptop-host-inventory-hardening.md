# Laptop host inventory and production-appliance hardening

Governing issue: `DEN-942`.

This runbook turns the three proposed laptops into reviewed production-appliance
candidates. It separates four things that must not be conflated:

1. **redacted local host capture** — what the machine reports without exporting
   serial numbers, MAC addresses, IP addresses, credentials, or raw firewall
   rules;
2. **fleet inventory** — operator-reviewed hardware, site, WAN, power, security,
   monitoring, and recovery facts for all three machines;
3. **declarative host baseline** — a reusable NixOS module for the controls that
   can safely be expressed in code;
4. **live acceptance evidence** — physical inspection, destructive recovery,
   WAN/power tests, and human approval.

The repository contains example data and software gates. It does not claim that
any real laptop has passed them.

## Required fleet identities

The inventory must cover exactly these identities once each:

| Cluster identity | Synthetic provider | Planned site |
|---|---|---|
| `laptop-aws-sim` | `aws` | `site-a` |
| `laptop-gcp-sim` | `gcp` | `site-b` |
| `laptop-azure-sim` | `azure` | `site-c` |

The provider values are simulation labels only. Hardware located in a residence,
office, or other local site must never be represented as actual AWS, GCP, or
Azure infrastructure.

## Production floor

The validator currently requires, per host:

- a dedicated appliance with no dual boot or unrelated workloads;
- at least four logical CPUs;
- at least 16 GiB RAM;
- wired Ethernet as the primary network path;
- at least a 465 GiB SSD, passing SMART, with at least 80% reported health;
- LUKS2-encrypted root storage;
- a battery with at least 70% health and at least 15 minutes of measured runtime;
- thermal sensors and a bounded load test with no observed throttling;
- at least 10 Mbps measured upload capacity;
- at least 15 minutes of router/modem UPS runtime;
- key-only, non-root SSH;
- no public management ports;
- firewall, time synchronization, watchdog, and Nix-managed host policy;
- suspend and hibernation disabled, with lid close ignored;
- one exact K3s release shared across the fleet;
- SMART/NVMe wear, disk, battery, temperature, throttling, clock, WAN, and power
  monitoring;
- reviewed evidence references for hardware, disk, encryption, firmware,
  firewall, SSH, power, network, thermal behavior, monitoring, rebuild, and
  device revocation.

A laptop failing this floor may still be useful for development or chaos tests,
but it is not a limited-production member.

## Failure-domain classifications

The validator supports two launch classifications.

### `limited-production`

This requires all three of the following to be true:

- distinct site identities with independent physical and utility failure-domain
  review;
- three different ISP fingerprints;
- a tested, independently provided backup WAN at every site;
- Secure Boot on every host;
- explicit approval for every host.

A passing software report does not prove those statements. Reviewers must verify
that each evidence identifier points to current, independently captured evidence.

### `beta-only`

Correlated power, router, ISP, site, backup-WAN, or firmware limitations may be
recorded only with an explicit fleet exception explaining the risk. The system
must then be operated as low-SLA beta with constrained tenants, storage, and job
concurrency. Do not change the classification to `limited-production` merely to
make the validator pass.

## Privacy and credential boundary

Do not commit or paste any of the following into GitHub, Linear, CI logs, or the
inventory file:

- raw laptop serial numbers;
- MAC addresses or public IP addresses;
- home addresses or personally identifying site descriptions;
- SSH keys, Tailscale keys, OAuth secrets, Cloudflare tokens, S3 credentials, K3s
  server tokens, recovery keys, or environment dumps;
- Kubernetes Secret values;
- raw firewall rules containing private addresses or temporary incident data.

`serialHash` and `ispFingerprint` exist only to detect duplicates and correlated
failure domains. Derive them locally with an organization-held keyed hash or
other approved privacy-preserving procedure. Do not use an unsalted public hash
when the source value is guessable. The key or source value must remain outside
this repository.

Evidence fields should contain opaque references such as an encrypted evidence
bundle ID, internal audit record, or restricted object reference. They must not
be secret-bearing URLs.

## Redacted local capture

Run the read-only capture on each laptop:

```sh
sudo scripts/capture-laptop-host-evidence.sh \
  --cluster laptop-aws-sim \
  --output /secure/evidence/laptop-aws-sim-host.json
```

The script captures a bounded packet containing:

- OS, kernel, architecture, logical CPU count, and memory;
- root storage type, filesystem, and utilization;
- Secure Boot and TPM presence where detectable;
- battery presence, health, and cycle count where exposed by the kernel;
- block-device type/size/transport/filesystem without serials;
- interface names and state without addresses or MACs;
- listening protocol and port numbers without addresses or process command
  lines;
- a hash and line count for the firewall ruleset rather than its content;
- enabled/active state for SSH, Tailscale, SMART, time synchronization, and K3s;
- K3s configuration mode, hash, node-identity match, secret encryption,
  S3-Secret usage, and disabled ServiceLB/Traefik flags.

The output is mode `0600`. The script performs no network request and does not
read process environments, Kubernetes Secrets, or credential files.

A root capture is required for production evidence. `--allow-unprivileged` is
only for preliminary diagnostics and must not be cited as final evidence.

The packet is not the fleet inventory. A reviewer still needs to add independently
measured site, WAN, UPS, firmware, disk-health, battery-runtime, thermal-load,
rebuild, and revocation evidence.

## Fleet inventory

Start from the schema and example:

```text
laptop/inventory/fleet.schema.json
laptop/inventory/fleet.example.json
```

Never edit the example into a misleading production artifact. Create a separate,
restricted live file outside Git and set:

```json
{
  "evidenceMode": "live"
}
```

Validate an example rehearsal:

```sh
node tools/validate-laptop-inventory.mjs \
  --inventory laptop/inventory/fleet.example.json \
  --allow-example \
  --now 2026-08-03T18:00:00Z
```

Validate current live evidence:

```sh
node tools/validate-laptop-inventory.mjs \
  --inventory /secure/evidence/fiducia-laptop-fleet.json
```

Live validation fails when:

- the hardware capture is older than 30 days;
- the fleet review is older than seven days;
- example evidence references remain;
- any host lacks explicit approval;
- a required control or capacity threshold fails;
- the three cluster/provider identities are incomplete or duplicated;
- site IDs, serial hashes, or limited-production ISP fingerprints collide;
- home-LAN CIDRs overlap a laptop Pod/Service CIDR or another site's home LAN;
- secret-bearing keys or recognizable credential values appear.

The emitted report contains a deterministic fleet fingerprint, bounded capacity
summary, failure-domain result, and control summary. It intentionally excludes
raw evidence and secrets.

## NixOS appliance module

`nix/modules/fiducia-laptop-host.nix` is a reusable NixOS module rather than a
complete machine configuration. A host configuration still needs:

- hardware-specific generated configuration;
- partitioning and LUKS2 layout;
- bootloader and Secure Boot chain;
- the non-root operator user and reviewed SSH public keys;
- pinned K3s installation and `/etc/rancher/k3s/config.yaml`;
- Tailscale enrollment and policy from DEN-943;
- optional plain-WireGuard fallback keys from an external secret path;
- monitoring/alert destination credentials;
- backup and recovery material.

A minimal import shape is in `nix/examples/laptop-host.nix`.

The module applies:

- no globally open TCP management port;
- SSH 22 and K3s API 6443 only on the declared private mesh interface;
- optional WireGuard UDP only when the fallback is explicitly enabled;
- OpenSSH with password, keyboard-interactive, root, X11, agent, TCP forwarding,
  and tunnel forwarding disabled;
- Tailscale, SMART monitoring, filesystem trim, time synchronization, and
  optional x86 thermald;
- lid-close ignore plus suspend/hibernate disablement;
- runtime and reboot watchdog settings;
- redirect and kernel-information hardening sysctls;
- sudo password requirement and disabled unattended system auto-upgrade;
- bounded Nix garbage collection;
- a root-only host audit every 15 minutes.

The audit checks:

- root-private K3s configuration;
- expected K3s node identity;
- Kubernetes secret encryption;
- disabled ServiceLB and bundled Traefik;
- Secret-backed K3s S3 snapshot configuration;
- enabled SSH, Tailscale, SMART, and time synchronization services;
- dm-crypt-backed root storage;
- root disk below the configured critical threshold.

It writes only a small root-owned status file under
`/var/lib/fiducia-host-audit`.

## Rollout procedure

Do not apply host changes to all three machines together.

1. Confirm all three current Fiducia and JetStream members are healthy.
2. Identify current leaders and choose a follower laptop.
3. Remove that laptop from public traffic.
4. Build and evaluate its complete NixOS configuration in CI and on compatible
   test hardware.
5. Review the configuration diff, especially firewall, SSH, sleep, storage,
   boot, network, K3s, and secret paths.
6. Apply only to the follower.
7. Run the host audit, redacted capture, K3s checks, external health, and peer
   catch-up verification.
8. Keep the previous boot generation and recovery media available through the
   rollback window.
9. Repeat for the second follower.
10. Transfer leadership and change the former leader last.

Automatic simultaneous fleet updates are prohibited. Security updates should be
prepared and rolled through this same one-host-at-a-time process.

## Lost-device and rebuild gates

A rebuild is accepted only when a clean replacement host can be created from:

- reviewed NixOS and hardware configuration;
- approved encrypted bootstrap material;
- exact K3s and Git revisions;
- independently stored K3s, Fiducia, database, and messaging backups;
- offline recovery-key custody.

Do not copy mutable state from another live laptop.

A simulated lost-device drill must revoke or rotate:

- Tailscale/WireGuard identity;
- SSH/operator access;
- Git and image-registry identity;
- TLS/mTLS identity;
- SOPS/age recipient;
- Cloudflare connector identity;
- runtime secret-store access;
- Fiducia and JetStream membership.

The replacement receives a new physical identity and new trust material. A
removed Raft or JetStream member identity must not be reused casually.

## Remaining live evidence

DEN-942 remains open after this software lands. Completion requires the actual
three laptops and evidence for:

- manufacturer/model, CPU, RAM, SSD, SMART/NVMe, battery, thermal, firmware, and
  encryption state;
- site, physical-access owner, ISP, upload, CGNAT, home-LAN, backup WAN, utility,
  and UPS measurements;
- complete evaluated host configurations and successful one-host-at-a-time
  rollout;
- public-port scan and private-management verification;
- no-sleep, watchdog, clock, disk, thermal, battery, WAN, and power alerts;
- clean rebuild and lost-device revocation drills.

DEN-946 still owns destructive fleet failures, clean-room recovery, and the
seven-day physical soak.