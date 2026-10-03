# Multi-cloud hardening report

Scope: the three-audit sweep (terraform / manifests / scripts+CI) plus the
`tools/render.mjs` generator, and the cross-cluster control-plane fix the local
emulation surfaced. Every item is either **Fixed** (change landed + verified) or
**Accepted** (deliberately not changed, with the reason). Validation commands and
their results are in the last section.

The work was validated end-to-end against the Tier-2 local emulation (three Kind
clusters standing in for hetzner/vultr/civo, running the real
node+brain+sidecar+LB images): **48 assertions pass, 0 fail** — cross-cluster
Raft, the real client→LB→shard-leader routing path, and WAN-latency /
partition-heal / whole-provider-outage scenarios.

---

## 0. Control-plane fix (found via the emulation, not the audit)

The emulation's real LB routing path 502'd every cross-cluster request. Root
cause was in `fiducia-brain`, not infra: a brain member's id doubles as the
address peers dial it at (the `leader_id` gossiped in Raft, and the target a
follower forwards `/v1` writes to), but deployments set a **name-style id**
(`fiducia-brain-0.<cloud>`) that no member can dial, and the `/v1` control plane
was served only in-namespace (`:8095`), unreachable cross-cluster. Forwarded
heartbeats silently blackholed (the forwarder wrapped every outcome in HTTP 200),
so only the leader's own cluster ever registered a node and remote LBs had empty
routing tables.

**Fixed** (`fiducia-brain.rs`, committed + pushed; 71 crate tests green):
- Treat `FIDUCIA_BRAIN_ID` as the member's dialable **peer-plane URL**; normalize
  schemeless authorities so reqwest can dial them and the self-filter is stable.
- Mount the internal-auth-guarded `/v1` router at `/forward/v1` on the peer
  listener (the only cross-cluster-reachable plane) and forward all follower
  writes (heartbeat/drain/scale/policies) **and** `/v1/nodes` reads there.
- Cap forwards at one hop (`x-fiducia-brain-forwarded`) so stale leader views
  can't ping-pong a request.
- The forwarder relays the real upstream status (502 on transport failure)
  instead of masking failures as 200.

**Infra side (this repo):** the emulation overlay now advertises each brain's
cross-cluster-routable id (`http://$(HOST_IP):30095`, the brain-peer NodePort),
mirroring the node sidecar's existing `hostIP:30080` trick. A `build-local.sh` +
`Dockerfile.local` pair builds the four service images from the local working
tree (the repos' own Dockerfiles git-fetch sibling crates at pinned SHAs that
trail local checkouts).

> **Open (prod):** the base brain StatefulSet still defaults the id to
> `$(POD_NAME).$(FIDUCIA_CLUSTER)` and prod `topology.env` has no per-cluster
> dialable brain URL. Wire an advertised brain URL before replicated brains ship
> to prod. Tracked with the shared-secret-identity follow-up.

---

## 1. Terraform

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | HIGH | civo firewall world-open on 6443/NodePorts (`create_default_rules=true`), no CIDR knob | **Fixed** — `create_default_rules=false`, inline ingress rules sourced from a required `allowed_cidrs`; a `precondition` rejects empty / `0.0.0.0/0` / `::/0` (mirrors the hetzner firewall contract) |
| 2 | HIGH | hetzner k3s default flannel can't join the Cilium ClusterMesh prod needs | **Fixed** — `var.cni == "cilium"` starts k3s with `--flannel-backend=none --disable-network-policy`; Cilium is installed post-provision (documented; nodes NotReady until then) |
| 3 | HIGH | hetzner k3s installed via unpinned `curl \| sh` (latest), no version/checksum | **Fixed** — `INSTALL_K3S_VERSION="${var.k8s_version}"` on server + agents; reproducible re-provision |
| 4 | MED-HIGH | civo `kubernetes_version` unpinned | **Fixed** — `k8s_version` variable (default pinned), matches the vultr interface |
| 5 | MED-HIGH | envs/prod has no remote-backend example → state (k3s token, kubeconfigs, CA) plaintext + unlocked | **Fixed** — `envs/prod/backend.tf.example` + README note, mirroring envs/e2e |
| 6 | MED | hetzner: one token for server+agent; token in cloud-init user_data | **Fixed** — separate `random_password.k3s_agent_token` + `--agent-token`; metadata-exposure constraint noted (full fix = secret store, out of scope) |
| 7 | MED | hetzner `--tls-san $(curl -s ifconfig.me)` external dependency | **Fixed** — public IP read from the Hetzner metadata service (`169.254.169.254`), no third-party dependency |
| 8 | MED | vultr `ca_certificate` output wired to the **client** cert (kubeconfig TLS fails) | **Fixed** — now `cluster_ca_certificate`, marked `sensitive` |
| 9 | LOW-MED | envs/prod `hetzner_ssh_public_key` default `""` while `enable_hetzner` default true → empty-key apply | **Fixed** — module `precondition` requires `ssh_public_key` **or** `ssh_key_name` when a key is needed |
| 10 | LOW | civo `labels` var accepted but never applied | **Fixed** — applied as pool labels + space-joined `k:v` cluster tags |
| 11 | LOW | envs/prod civo provider region hardcoded `LON1` while module region is a var | **Accepted** — prod pins both to `LON1`; internally consistent. Revisit if civo spans regions |

All 8 terraform dirs (`modules/{civo,vultr,hetzner,aks,eks,gke}`, `envs/{prod,e2e}`)
pass `terraform validate`; `terraform fmt -check -recursive` is clean.

## 2. Kubernetes manifests (`base/`, `argocd/`)

| Item | Finding | Status |
|------|---------|--------|
| Brain API access | Brain ran on the default SA with no RBAC + default-deny egress → `KubeOracle` 403s into an empty cache, silently degrading failure detection to timeouts-only | **Fixed** — dedicated `fiducia-brain` SA + namespace Role (`pods: [list]`, the oracle's exact call) + RoleBinding in a new `base/components/brain/rbac.yaml`; `serviceAccountName` set and `automountServiceAccountToken: true` pinned so a blanket automount-off sweep can't disable the oracle; oracle-egress NetworkPolicy (443/6443). Ships only with the brain Component |
| Sidecar probes | Node sidecar had readiness+liveness but no startup probe; 15s liveness could kill a slow boot | **Fixed** — `startupProbe /healthz:8091` (period 2s, 30 failures) gating liveness; route confirmed in `fiducia-node-sidecar.rs` |
| LB availability | 2-replica LB had no PDB / anti-affinity | **Fixed** — `base/load-balance/pdb.yaml` (minAvailable 1) + preferred hostname anti-affinity |
| ArgoCD RBAC | `namespaceResourceWhitelist` was `group:* / kind:*` — a compromised repo could sync arbitrary resources incl. Secrets | **Fixed** — pinned to the 10 kinds the overlays render, **excluding Secret** (secrets provisioned out-of-band) |
| Digest pinning | Service images tag-pinned (`v0.1.0`), no prod-digest statement | **Fixed (doc)** — `base/README.md` "Image pinning": prod deploys digest refs resolved at promotion; base images already digest-pinned + Dependabot-maintained |
| PSA `enforce: restricted` | Requested on the namespace | **Accepted** — namespace carries `enforce: privileged`, `audit/warn: restricted`. `restricted` (even `baseline`) would reject the otel-agent DaemonSet, which must run as root with hostPath mounts to tail pod logs. Audit/warn surface drift without breaking the collector |
| otel-agent SA token | `automountServiceAccountToken: false` requested broadly | **Accepted** — the `k8sattributes` processor authenticates with `auth_type: serviceAccount`; disabling the token breaks pod-metadata enrichment. Node + LB carry no API access |
| ArgoCD `destinations` | Keeps `server: "*"` | **Accepted** — nonproduction clusters register dynamically; the gate is the fail-closed cluster-generator label selector (`fiducia.cloud/cluster=true` + `environment=nonproduction`) plus the namespace whitelist |

## 3. `tools/render.mjs` generator

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | MED | Path traversal via cluster `name` → arbitrary write/read outside the tree | **Fixed** — module-level `safeName()` (string, ≤63, DNS-1123) re-checked inside `render()` so exported-API callers can't bypass it; fails loudly with the offending name |
| 2 | MED | `shard_count`/`replication_factor`/`node_replicas` no int/bounds validation | **Fixed** — `Number.isInteger` + bounds (shard 1..65536, RF 1..7, replicas 1..1000); string RF / string replicas rejected |
| 3 | LOW | `parseToml` prototype pollution via `[__proto__]`/`[constructor]` | **Accepted (already fixed)** — null-prototype receivers + a `FORBIDDEN_KEYS` reject-list; tests assert `Object.prototype` unpolluted |
| 4 | LOW | endpoints/ports existence-checked, not format-validated | **Fixed** — port digits parsed + required in 1..65535 (`:0`/`:99999` previously passed); hostnames already DNS-charset-checked |

`node --test tools/render.test.mjs` → 18/18. `node tools/render.mjs` re-renders
`clusters/*` + `generated/edge-regions.json` **byte-identical** (no drift).

## 4. Scripts / CI

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | MED | `tools/kind-up.sh` no `--context` pin on the reuse path → can deploy to the ambient (prod!) context | **Fixed** — `CTX="kind-${CLUSTER}"` pinned on every kubectl call, matching `lib.sh`'s `kc()` |
| 2 | MED | `package-lock.json` stale `../fiducia-interfaces` entry breaks `npm ci` | **Fixed** — pruned; lockfile is root-only (zero-dep); `npm ci --dry-run` clean |
| 3 | LOW | Node major drift: Dockerfile `node:26` vs `.nvmrc`/CI `22` | **Fixed** — aligned to Node 22 (CI's major), digest-pinned form kept |
| 4 | LOW-MED | `cli-flags.yml` builds+runs submodule code on PRs (fork risk) | **Fixed** — job gated to non-fork PRs + push; forks no longer execute submodule code |
| 5 | LOW | `ci.yml` kind-e2e `workflow_dispatch` no `environment:` gate | **Accepted (documented)** — the repo defines no deployment environments; referencing a missing one auto-creates an **unprotected** environment that reads as a gate. Comment explains the deliberate omission |
| 6 | LOW | `with-flags2env.sh` `eval` on tool output | **Accepted** — the eval'd string is `shell-env` output from the pinned `flags-2-env` submodule fed only by repo-owned inputs; local-tooling only |

CI baseline was already strong (actions SHA-pinned, `contents: read`, no
`pull_request_target`, no `github.*` in `run:`, Dockerfile digest-pinned + `USER
node` + `npm ci --ignore-scripts`) — these were the residual gaps.

---

## Validation (all green)

```
terraform validate     modules/{civo,vultr,hetzner,aks,eks,gke}, envs/{prod,e2e}   8/8 OK
terraform fmt -check -recursive                                                     clean
kubectl kustomize      base, kind/overlay, kind/multicluster/{hetzner,vultr,civo},
                       clusters/{hetzner,vultr,civo}                                8/8 OK
node --test            render 18/18 · rollout 7/7 · networkpolicy 3/3 ·
                       workload-hardening 2/2                                       30/30
render idempotence     clusters/* + generated/edge-regions.json byte-identical     no drift
bash -n                all tools/ + kind/multicluster/*.sh scripts                  clean
YAML parse             .github/workflows/*.yml                                      OK
npm ci --dry-run                                                                    up to date
Live emulation         ./kind/multicluster/test/run.sh --scenarios                 48 pass / 0 fail
```
