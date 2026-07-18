# Provisioning status & what needs shoring up

Live state of the three-cloud prod fleet (`terraform/envs/prod`, `topology.toml`)
and the concrete gaps between "declared" and "running". Each item is **Done**,
**Blocked** (needs an operator action outside terraform), or **Open** (a fix or
decision we still owe). Ordered by what blocks first light.

> TL;DR: Hetzner's network/firewall/k3s tokens are applied but the VM is blocked
> on an account **server-limit increase**; Vultr is blocked on **billing** (API
> stays disabled until the account is funded); Civo is blocked on **signup**
> (reCAPTCHA rejects the CGNAT/mobile exit). Nothing is deployed yet, so the
> cross-cloud mesh, DNS, and the customer-portal smoke all wait on these three.

## 1. Per-cloud account/provision state

| Cloud | Declared | Applied so far | Blocker | Unblock |
| --- | --- | --- | --- | --- |
| Hetzner | `modules/hetzner`, k3s on 1 VM (`cx42`) | network `fiducia-prod-hetzner-net`, firewall `fiducia-prod-hetzner-fw` (SSH/6443/NodePorts from operator CIDR), k3s server+agent tokens — **in terraform state** | `hcloud_server` create → `resource_limit_exceeded` (server limit 5/5) | Request a server-limit increase at console.hetzner.cloud/limits (ask 10), then `terraform apply` — the VM is the only missing resource |
| Vultr | `modules/vultr` (managed VKE, `vc2-6c-16gb`) | none | "Account must be funded" → **API access disabled**, so no `VULTR_API_KEY` | Add a payment method (my.vultr.com billing), enable API, allow-list the operator IP, export `VULTR_API_KEY` |
| Civo | `modules/civo` (managed k3s + Cilium, `g4s.kube.xlarge`) | none | signup rejected by reCAPTCHA (mobile/CGNAT exit, AS12252 Lima) | Sign up from a clean-reputation network/VPN or email support to whitelist; then export `CIVO_TOKEN` |

**Partial-state caution (Hetzner):** a `terraform apply` already created real
Hetzner resources, so the local state file is authoritative and non-empty. Do
**not** wipe it; the next apply must reuse it or those resources orphan. See §5
(remote state) — this local state should be migrated before more applies.

## 2. Single-VM bootstrap — the tradeoff we took

`topology.toml` `node_replicas = 1` and `envs/prod` `node_count = 1`: each cluster
is **one machine** running node + brain + load-balance + otel together.

- **Kept:** the quorum guarantee. RF=3 with one replica per cloud → losing any
  one whole cluster still leaves a 2/3 majority.
- **Gave up:** intra-cluster redundancy and capacity. A single machine loss =
  that entire failure domain down until the VM heals. There is no spare node to
  absorb the node-pod, and the brain member dies with it.
- **Machine sizes** were raised for this (`hetzner_server_type=cx42`,
  `vultr_plan=vc2-6c-16gb`, `civo_node_size=g4s.kube.xlarge`, ~16 GB each)
  because one box now carries the whole stack. **Verify these ids against the
  live catalogs before apply** (`hcloud server-type list`, `vultr-cli plans
  list`, `civo size list`) — `cx32` was already retired once mid-session.

**Open — scale-up path back to the design (RF-3, 5 nodes/cluster):** raise
`node_replicas` in `topology.toml` and `node_count` in `envs/prod` **together**
(the one-node-pod-per-machine anti-affinity requires `node_count >=
node_replicas`), re-render, re-apply. Track this as the real production target;
single-VM is a starter tier, not the end state.

## 3. Cluster Mesh — the Vultr Cilium gap (highest technical risk)

`connectivity = "clustermesh"` needs **Cilium in every cluster** for pod-to-pod
routable, low-latency cross-cloud Raft (`tools/clustermesh.sh`).

- **Hetzner:** the module now starts k3s with `--flannel-backend=none
  --disable-network-policy` when `cni = "cilium"` (wired this session); you must
  run `cilium install` after apply — the node stays `NotReady` until then.
- **Civo:** provisions with Cilium natively (`cni = "cilium"`). OK.
- **Vultr VKE — the gap:** ships **Calico**, and does not officially support
  swapping the CNI. So the Vultr leg cannot join a Cilium mesh out of the box.

**Open — decide the Vultr mesh strategy** (pick one, document in `topology.toml`):
1. Install Cilium onto VKE manually (unsupported by Vultr; test carefully), or
2. Set `connectivity = "wireguard"` or `"public-mtls"` for the fleet (both are
   supported modes; higher latency — re-check the `[raft]` timings, they are
   tuned for ~10–30 ms EU mesh RTT), or
3. Swap Vultr for a Cilium-friendly provider (the module interface is a drop-in
   `source =` change — DigitalOcean/Scaleway/Akamai LKE).

Until this is decided, treat the three-cloud mesh as **not wired**.

## 4. Operator firewall CIDR is pinned to a rotating IP

`envs/prod/terraform.tfvars` pins `hetzner_firewall_allowed_cidrs` and
`civo_allowed_cidrs` to a single operator IP (`/32`). That IP was a **CGNAT/mobile
address that rotates**, and a VPN changes it entirely.

**Open:** before each apply, re-confirm the operator IP (`curl ipinfo.io/ip`) and
update `terraform.tfvars`; or move to a stable egress (bastion / office range /
a fixed VPN exit) and pin that. A stale CIDR locks you out of `:6443`/SSH.

## 5. Remote state is mandatory before more applies

Prod state holds the Hetzner k3s **join tokens** (`random_password`) and will hold
the Vultr/Civo kubeconfigs + CA material. It must not sit in unencrypted, unlocked
local state, and concurrent applies with no lock can corrupt it.

**Open:** copy `envs/prod/backend.tf.example` → `backend.tf`, fill in an S3 +
DynamoDB (`encrypt = true`) or GCS backend, `terraform init -migrate-state`
(migrates the existing Hetzner state), then continue. Do this **before** the next
apply, while the state is still small.

## 6. SSH key reuse (done, note the constraint)

`modules/hetzner` now accepts `ssh_key_name` to authorize an **already-registered**
hcloud key instead of uploading one (Hetzner rejects duplicate fingerprints).
`envs/prod` uses the operator's existing `alexander.d.mills@gmail.com` key. Keep
exactly one of `hetzner_ssh_public_key` / `hetzner_ssh_key_name` set.

## 7. Ordered next steps (how to shore up, first light → steady state)

1. **Unblock the three accounts** (§1): Hetzner limit increase, Vultr billing+API,
   Civo signup. Export `HCLOUD_TOKEN` / `VULTR_API_KEY` / `CIVO_TOKEN`.
2. **Migrate state to a remote backend** (§5) before the next apply.
3. **Re-pin the operator CIDR** to a stable egress (§4).
4. `terraform apply` the full fleet; `cilium install` on Hetzner.
5. **Decide + apply the Vultr mesh strategy** (§3), then `tools/clustermesh.sh`.
6. Point the `*.fiducia.cloud` `*_endpoint` DNS at the mesh global-service DNS,
   `node tools/render.mjs`, let ArgoCD sync (`docs/ROLLOUT.md`).
7. Set `FIDUCIA_CUSTOMER_TEST_URL` so the deployed browser smoke
   (`fiducia-customer-ui.web`, and the k8s-cluster runner) becomes a live gate.
8. **Plan the move off single-VM** to RF-3 / 5-node clusters (§2).
