# clusters/civo — Civo overlay

The Kustomize overlay applied to the Civo cluster. It layers this cluster's identity
onto `base/`: `FIDUCIA_CLUSTER=civo`, its cross-cluster peer lists, storage class, and
node replica count.

`topology.env` and `patches.yaml` are **generated** from `../../topology.toml` by
`tools/render.mjs` — do not hand-edit them. Only `kustomization.yaml` is authored.
Civo is a brain-member cluster, so it includes the `base/components/brain` component.
