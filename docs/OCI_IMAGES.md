# Fiducia OCI registry and Lambda image contract

Policy authorities: <https://github.com/ORESoftware/my-ai/blob/main/AGENTS.md> and this repository's `AGENTS.md`.

## Immutable shared authorities

This repository consumes two merged Zed Infra authorities:

- provider-isolated ECR, Google Artifact Registry, Azure Container Registry, and R2 modules at `zed-pkg/zed-infra@698c675f57fd70ebe24a8a08f963599c4c84fa5a`;
- the BuildKit/Lambda publisher at `zed-pkg/zed-infra@e0454f5d0d8c970dfa206595a48eda5ead382544`, verified before execution by Git blob `8490ce53434410192c750b10d17fe122e9df30be`.

`infra/oci/terraform` is the sole Terraform registry adapter introduced by this change. Each provider is disabled by default and requires only its own reviewed account/project, region, IAM, retention, and rollback inputs. `infra/oci/crossplane/registries.yaml` is the provider-native Crossplane alternative with orphan-on-delete protection. The removed remote Terraform Workspace no longer requires a controller credential to clone this private repository.

Nothing here applies itself. Terraform apply, Crossplane synchronization, image promotion, cluster changes, and workload deployment remain separately reviewed platform operations.

## Image construction and publication

Use `bash scripts/publish-multi-registry-oci.sh` with environment-only configuration. The wrapper rejects command arguments, downloads or reads the exact central publisher, verifies its Git blob, and only then executes it.

Portable Fiducia services may publish a `linux/amd64,linux/arm64` image index with `docker/service-rust.Dockerfile`. AWS Lambda image references must contain exactly one architecture. Set `IMAGE_KIND=lambda` and one of `PLATFORMS=linux/amd64` or `PLATFORMS=linux/arm64` with `docker/lambda-rust.Dockerfile` or `docker/lambda-node.Dockerfile`. Invalid Lambda indexes fail before registry authentication or Docker side effects.

Repository roots, `src/lambda` entrypoints, and sibling `*-lambda` repositories can supply `CONTEXT`, `DOCKERFILE`, and allowlisted build argument names. `PUSH=false` is a one-platform local-load mode and performs no registry login. Runtime deployments select immutable image digests; tags are discovery and rollback metadata only.

## Consensus and durable-state boundary

Fiducia's three-cluster topology, Raft membership, shard replication factor, failure-domain placement, peer endpoints, StatefulSet identity, PVC ownership, `OnDelete` update strategy, and quorum-checked replacement protocol remain unchanged. Container publication must never become a Raft lifecycle manager.

Images and registry metadata may contain executable artifacts, SBOMs, and bounded non-sensitive build provenance only. Never place Raft logs, snapshots, WAL files, PVC contents, topology secrets, TLS private keys, brain/node authentication secrets, cluster credentials, provider credentials, customer coordination data, database dumps, decrypted configuration, or observability payloads in image layers, labels, build arguments, Terraform state, registry annotations, SBOM metadata, or provenance fields.

A new image digest is not authorization to roll a StatefulSet. `fiducia-node` and `fiducia-brain` replacement remains an explicit, quorum-aware operation that verifies leadership, follower lag, protocol compatibility, durable snapshots, and rollback before deleting any pod.

R2 is an OCI archive and disaster-recovery destination after a successful push to an actual Distribution endpoint. It is not a direct pull registry for Lambda, Cloud Run, Kubernetes, Docker, or containerd.

## Validation and activation

The OCI workflow verifies publisher integrity, shell syntax, absence of duplicate authority paths, Terraform formatting plus real remote-module download and validation, provider-native Crossplane structure, multi-stage/native Dockerfile boundaries, non-root service runtime, and conflict-marker absence. Existing Fiducia workflows remain authoritative for topology rendering, three-cluster placement, Raft durability, internal TLS, CLI contracts, secret bootstrap, commercial intake, and laptop/managed-beta evidence policies.

This change does not alter `topology.toml`, generated cluster inputs, Raft membership, peer endpoints, replication factor, StatefulSets, PVCs, NetworkPolicies, TLS, secrets, Cloudflare routing, or deployment pins. It does not create a registry, publish an image, apply Terraform/Crossplane, deploy a Lambda, restart a pod, or change a leader. Live operations require workload identity or an approved secret-delivery path and a separately reviewed promotion change.
