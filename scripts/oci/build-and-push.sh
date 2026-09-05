#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[oci-publish] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

deploy_target="${DEPLOY_TARGET:-generic}"
case "$deploy_target" in
  generic|cloud-run|lambda) ;;
  *) die "DEPLOY_TARGET must be generic, cloud-run, or lambda" ;;
esac

repo_basename="$(basename "${GITHUB_REPOSITORY:-$(pwd)}")"
image_name="${IMAGE_NAME:-$repo_basename}"
image_tag="${IMAGE_TAG:-${GITHUB_SHA:-}}"
if [[ -z "$image_tag" ]] && command -v git >/dev/null 2>&1; then
  image_tag="$(git rev-parse --verify HEAD 2>/dev/null || true)"
fi
image_tag="${image_tag:-dev}"

[[ "$image_name" =~ ^[a-z0-9][a-z0-9._/-]*[a-z0-9]$ ]] || \
  die "IMAGE_NAME is not a valid lowercase OCI repository path: $image_name"
[[ "$image_tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || \
  die "IMAGE_TAG is not a valid OCI tag"

registry_refs_raw="${REGISTRY_REFS:-}"
[[ -n "$registry_refs_raw" ]] || \
  die "REGISTRY_REFS must contain one or more space-separated repository references"
read -r -a registry_refs <<<"$registry_refs_raw"
((${#registry_refs[@]} > 0)) || die "REGISTRY_REFS is empty"

for ref in "${registry_refs[@]}"; do
  [[ "$ref" == */* ]] || die "registry reference must include a registry host and repository: $ref"
  [[ "$ref" != *"://"* ]] || die "REGISTRY_REFS entries must not include a URL scheme: $ref"
  [[ "$ref" != *"@"* ]] || die "REGISTRY_REFS entries must not include a digest: $ref"
  final_component="${ref##*/}"
  [[ "$final_component" != *":"* ]] || die "REGISTRY_REFS entries must not include a tag: $ref"
done

find_dockerfile() {
  local candidate
  if [[ -n "${DOCKERFILE:-}" ]]; then
    [[ -f "$DOCKERFILE" ]] || die "DOCKERFILE does not exist: $DOCKERFILE"
    printf '%s\n' "$DOCKERFILE"
    return
  fi

  if [[ "$deploy_target" == "lambda" ]]; then
    for candidate in \
      src/lambda/Dockerfile \
      Dockerfile.lambda \
      oci/templates/Dockerfile.lambda-rust \
      Dockerfile; do
      if [[ -f "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  else
    for candidate in Dockerfile oci/templates/Dockerfile.lambda-rust; do
      if [[ -f "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  fi

  die "no Dockerfile found; set DOCKERFILE explicitly"
}

dockerfile="$(find_dockerfile)"
context="${BUILD_CONTEXT:-.}"
[[ -d "$context" ]] || die "BUILD_CONTEXT is not a directory: $context"

platforms="${PLATFORMS:-}"
if [[ -z "$platforms" ]]; then
  if [[ "$deploy_target" == "lambda" ]]; then
    platforms="linux/amd64"
  else
    platforms="linux/amd64,linux/arm64"
  fi
fi

if [[ "$deploy_target" == "lambda" ]]; then
  [[ "$platforms" != *,* ]] || \
    die "AWS Lambda requires a single-architecture image; publish amd64 and arm64 separately"
  case "$platforms" in
    linux/amd64|linux/arm64) ;;
    *) die "Lambda PLATFORMS must be linux/amd64 or linux/arm64" ;;
  esac
fi

login_registries() {
  if [[ -n "${AWS_ECR_REGISTRY:-}" ]]; then
    require_command aws
    [[ -n "${AWS_REGION:-}" ]] || die "AWS_REGION is required with AWS_ECR_REGISTRY"
    log "authenticating to AWS ECR"
    aws ecr get-login-password --region "$AWS_REGION" |
      docker login --username AWS --password-stdin "$AWS_ECR_REGISTRY" >/dev/null
  fi

  if [[ -n "${GCP_ARTIFACT_REGISTRY_HOST:-}" ]]; then
    require_command gcloud
    log "authenticating to Google Artifact Registry"
    gcloud auth print-access-token |
      docker login --username oauth2accesstoken --password-stdin \
        "$GCP_ARTIFACT_REGISTRY_HOST" >/dev/null
  fi

  if [[ -n "${AZURE_ACR_NAME:-}" ]]; then
    require_command az
    log "authenticating to Azure Container Registry"
    az acr login --name "$AZURE_ACR_NAME" --output none
  fi

  if [[ -n "${DOCKERHUB_USERNAME:-}" || -n "${DOCKERHUB_TOKEN:-}" ]]; then
    [[ -n "${DOCKERHUB_USERNAME:-}" && -n "${DOCKERHUB_TOKEN:-}" ]] || \
      die "DOCKERHUB_USERNAME and DOCKERHUB_TOKEN must be set together"
    log "authenticating to Docker Hub"
    printf '%s' "$DOCKERHUB_TOKEN" |
      docker login --username "$DOCKERHUB_USERNAME" --password-stdin >/dev/null
  fi
}

build_args=(
  docker buildx build
  --file "$dockerfile"
  --platform "$platforms"
  --push
)

for ref in "${registry_refs[@]}"; do
  build_args+=(--tag "${ref}:${image_tag}")
done

if [[ -n "${LAMBDA_BINARY:-}" ]]; then
  build_args+=(--build-arg "BINARY=${LAMBDA_BINARY}")
fi

if [[ -n "${OCI_SOURCE:-}" ]]; then
  build_args+=(--label "org.opencontainers.image.source=${OCI_SOURCE}")
fi
build_args+=(--label "org.opencontainers.image.revision=${image_tag}")

if [[ "$deploy_target" == "lambda" ]]; then
  build_args+=(--provenance=false --sbom=false)
else
  build_args+=(
    "--provenance=${PROVENANCE:-true}"
    "--sbom=${SBOM:-true}"
  )
fi

if [[ "${DRY_RUN:-false}" == "true" ]]; then
  printf '%q ' "${build_args[@]}" "$context"
  printf '\n'
  exit 0
fi

require_command docker
login_registries

builder="${BUILDX_BUILDER:-oci-federated-builder}"
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  log "creating Buildx builder $builder"
  docker buildx create --name "$builder" --driver docker-container --use >/dev/null
else
  docker buildx use "$builder"
fi
docker buildx inspect --bootstrap >/dev/null

log "building $image_name:$image_tag for $platforms and pushing to ${#registry_refs[@]} registries"
"${build_args[@]}" "$context"

if [[ -n "${R2_BUCKET:-}" ]]; then
  require_command aws
  require_command regctl
  : "${R2_ENDPOINT:?R2_ENDPOINT is required with R2_BUCKET}"
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required with R2_BUCKET}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required with R2_BUCKET}"

  first_image="${registry_refs[0]}:${image_tag}"
  archive_key="${R2_PREFIX:-oci}/${image_name}/${image_tag}.oci.tar"
  archive_key="${archive_key#/}"

  log "checking immutable R2 archive target"
  existing_key="$(
    AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION=auto \
    aws s3api list-objects-v2 \
      --bucket "$R2_BUCKET" \
      --prefix "$archive_key" \
      --max-keys 1 \
      --query 'Contents[0].Key' \
      --output text \
      --endpoint-url "$R2_ENDPOINT"
  )" || die "unable to verify the R2 archive destination"
  if [[ -n "$existing_key" && "$existing_key" != "None" ]]; then
    die "R2 archive key or prefix already exists: s3://$R2_BUCKET/$archive_key"
  fi

  log "exporting OCI layout from the first registry reference to R2 archive storage"
  regctl image export "$first_image" |
    AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION=auto \
    aws s3 cp - "s3://$R2_BUCKET/$archive_key" \
      --endpoint-url "$R2_ENDPOINT" \
      --no-progress \
      --content-type application/vnd.oci.image.layout.v1.tar
fi

log "publish complete; promote deployments by immutable digest, not a mutable tag"
