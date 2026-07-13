# argocd — non-production GitOps fan-out

This directory is deliberately **non-production only**. Production is deployed
from a reviewed, exact pin set in `fiducia-monorepo` by its manual `deploy`
workflow. An ArgoCD application following `fiducia-infra/main` in production
would bypass that promotion and approval boundary.

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
dispatch the monorepo workflow from protected `main`; it applies the pinned infra
overlay directly.
