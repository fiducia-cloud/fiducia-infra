# clusters/azure — Azure overlay

The Kustomize overlay applied to the Azure cluster. It layers this cluster's identity
onto `base/`: `FIDUCIA_CLUSTER=azure`, its cross-cluster peer lists, storage class, and
node replica count.

Azure is added **node-only** (`brain = false`): the brain Raft group is pinned at 3
odd members (gcp/aws/hetzner), so this overlay omits the `base/components/brain`
component and adds capacity + a spare failure domain only.

`topology.env` and `patches.yaml` are **generated** from `../../topology.toml` by
`tools/render.mjs` — do not hand-edit them. Only `kustomization.yaml` is authored.
