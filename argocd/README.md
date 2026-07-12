# argocd — GitOps fan-out

Holds the ArgoCD `ApplicationSet` (`applicationset.yaml`) that a single "hub" ArgoCD
uses to deploy each cluster's overlay to that cluster. The cluster generator is
label-driven, so registering and labeling a new cluster secret (plus adding its
`clusters/<name>/` overlay) is enough for it to be picked up — no per-cluster
Application to hand-write.

This is the GitOps alternative to running `kubectl apply -k clusters/<name>` by hand.
