# argocd — non-production GitOps fan-out

This directory is deliberately **non-production only**. Production is reconciled
by Argo CD from rendered, digest-pinned state in `fiducia-monorepo`. Its manual
promotion workflow records the exact infrastructure and component commits in a
release bill of materials. A production Application following
`fiducia-infra/main` directly would bypass that approval boundary.

The manifest defines a restricted `fiducia-nonproduction` AppProject plus an
`ApplicationSet` that fans `clusters/<name>` overlays out to registered test
clusters. Selection is fail closed: the ArgoCD cluster secret must carry both
labels below. Missing either label means no Application is generated.

```yaml
fiducia.cloud/cluster: "true"
fiducia.cloud/environment: nonproduction
```

The generated Applications may auto-sync `fiducia-infra/main` because they are
confined to explicitly non-production clusters and the `fiducia` namespace.
Do not add the nonproduction label to a production cluster. For production,
dispatch the monorepo workflow from protected `main`; its Argo ApplicationSet
selects only clusters labeled `fiducia.cloud/environment=production` and
`fiducia.cloud/plane=data`.
