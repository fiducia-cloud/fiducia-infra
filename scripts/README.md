# scripts — helper scripts

- `with-flags2env.sh` — turns `.cli-flags.toml` flags into environment variables (via
  the flags-2-env submodule) and execs a command with them applied:
  `scripts/with-flags2env.sh [flags...] -- command [args...]`.
- `hetzner-e2e-vclusters.sh` — guarded plan/install/status/teardown lifecycle for
  three logical vClusters on the existing Hetzner kubeadm cluster; it creates no
  cloud resources, never selects the current kubectl context implicitly, and
  binds three distinct Node `hcloud://` IDs to reviewed Hetzner region/location
  inventory before any install.
- `hetzner-e2e-fetch-vcluster-kubeconfigs.sh` and
  `hetzner-e2e-vcluster-tunnels.sh` — keep tenant credentials outside Git and
  expose all APIs only through foreground loopback port forwards.
- `hetzner-e2e-secrets.sh` and `hetzner-e2e-vcluster-deploy.sh` — bootstrap
  runtime-only secrets, render digest-pinned releases, verify placement, capture
  evidence, and invoke the strict locks/leases proof.

The similarly named Terraform, SSH-fetch, tunnel, and deploy scripts without
`vcluster` are an explicitly disabled future path that would create three new
Hetzner servers. The default runbook is
[`../vcluster/hetzner-e2e`](../vcluster/hetzner-e2e).
