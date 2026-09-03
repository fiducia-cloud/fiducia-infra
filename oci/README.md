# Multi-cloud OCI publishing contract

This directory provides a reviewable registry and image-publishing baseline for
normal services, Cloud Run, Kubernetes, and AWS Lambda workloads. It does not
contain credentials and it never applies infrastructure automatically.

## Registry roles

- **AWS ECR** is the required source for AWS Lambda container-image functions.
  The Terraform resource uses immutable tags, scan-on-push, encryption, and
  bounded lifecycle retention.
- **Google Artifact Registry** is the native Docker/OCI source for Cloud Run and
  other GCP workloads. Immutable tags are enabled.
- **Azure Container Registry** uses the Basic tier with the registry admin
  account and anonymous pulls disabled.
- **Docker Hub** is a publishing destination, but repository creation and access
  policy are intentionally managed outside Terraform here. The publish script
  accepts a short-lived token only through the environment and sends it to
  `docker login` over stdin.
- **Cloudflare R2** is optional S3-compatible object storage for immutable
  OCI-layout tar archives, promotion evidence, or cache seeding. R2 is not an
  OCI Distribution registry, so Lambda, Cloud Run, and Kubernetes must not use
  an R2 object URL as an image reference.

Pricing and free-tier limits change. Treat provider billing alarms, retention,
and repository visibility as environment-specific policy rather than hardcoded
claims in this repository.

## Terraform

The root module at `terraform/main.tf` can create any subset of ECR, Artifact
Registry, ACR, and an optional R2 archive bucket. Provider authentication comes
from the standard environment/workload-identity chain. Do not add cloud keys,
Docker tokens, `.tfvars` containing secrets, plan files, or state to Git.

Example validation-only workflow:

```sh
terraform -chdir=oci/terraform fmt -check
terraform -chdir=oci/terraform init -backend=false
terraform -chdir=oci/terraform validate
```

An operator must review a plan before any apply. Production workloads should be
promoted by immutable digest. Pin the builder and runtime base-image digests in
each concrete workload once its compatibility matrix is verified.

## Crossplane

`crossplane/registries.yaml` defines a claim/XR and Pipeline-mode Composition
for ECR, Artifact Registry, and ACR. The platform cluster must first install and
pin compatible versions of:

- Crossplane;
- `function-patch-and-transform`;
- Upbound AWS ECR, GCP Artifact Registry, and Azure Container Registry provider
  packages; and
- platform-owned `ProviderConfig` objects.

The managed registries use `deletionPolicy: Orphan` to prevent an accidental
claim deletion from destroying image history. R2 remains in Terraform until the
platform owns and pins an approved Cloudflare Crossplane provider/API. Validate
all generated managed resources against the provider CRDs installed in the
actual cluster before apply.

## Build and publish

`../scripts/oci/build-and-push.sh` builds once with Buildx and attaches the same
image tag/index to every destination in `REGISTRY_REFS`.

General service or Cloud Run, multi-architecture by default:

```sh
REGISTRY_REFS='123456789012.dkr.ecr.us-east-1.amazonaws.com/example us-central1-docker.pkg.dev/project/example/example example.azurecr.io/example docker.io/example/example' \
AWS_ECR_REGISTRY='123456789012.dkr.ecr.us-east-1.amazonaws.com' \
AWS_REGION='us-east-1' \
GCP_ARTIFACT_REGISTRY_HOST='us-central1-docker.pkg.dev' \
AZURE_ACR_NAME='example' \
DOCKERHUB_USERNAME='example' \
DOCKERHUB_TOKEN="${DOCKERHUB_TOKEN:?inject through a secret store}" \
DEPLOY_TARGET='cloud-run' \
scripts/oci/build-and-push.sh
```

Lambda images are single-architecture. Publish separate immutable tags/digests
for arm64 and amd64 rather than a multi-platform manifest:

```sh
REGISTRY_REFS='123456789012.dkr.ecr.us-east-1.amazonaws.com/example-lambda' \
AWS_ECR_REGISTRY='123456789012.dkr.ecr.us-east-1.amazonaws.com' \
AWS_REGION='us-east-1' \
DEPLOY_TARGET='lambda' \
PLATFORMS='linux/arm64' \
LAMBDA_BINARY='example_lambda' \
scripts/oci/build-and-push.sh
```

The script discovers `src/lambda/Dockerfile`, `Dockerfile.lambda`, the provided
Rust template, or `Dockerfile` in that order for Lambda builds. Set
`DOCKERFILE` explicitly for `*-lambda` repositories or nonstandard entrypoints.
Use `DRY_RUN=true` to print the Buildx command without logging in or pushing.

Optional R2 archive export runs only after a successful registry push and uses
`regctl image export` plus the S3-compatible API. It refuses to overwrite an
existing archive key. R2 credentials remain environment-only.

## Required pre-merge checks

```sh
bash -n scripts/oci/build-and-push.sh
DRY_RUN=true REGISTRY_REFS='example.invalid/org/image' \
  scripts/oci/build-and-push.sh
DRY_RUN=true DEPLOY_TARGET=lambda PLATFORMS=linux/arm64 \
  REGISTRY_REFS='example.invalid/org/lambda' \
  scripts/oci/build-and-push.sh
```

Also run repository-specific infrastructure checks, provider-schema validation,
secret scanning, and representative Buildx builds before marking a PR ready.
