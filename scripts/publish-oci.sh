#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="${0##*/}"

die() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "required environment variable is empty: $name"
}

registry_host() {
  local reference="$1"
  printf '%s\n' "${reference%%/*}"
}

normalize_prefix() {
  local prefix="$1"
  printf '%s\n' "${prefix%/}"
}

IMAGE_NAME="${IMAGE_NAME:-}"
IMAGE_TAG="${IMAGE_TAG:-${GITHUB_SHA:-$(date -u +%Y%m%dT%H%M%SZ)}}"
BUILD_CONTEXT="${BUILD_CONTEXT:-.}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILD_TARGET="${BUILD_TARGET:-}"
LAMBDA_BIN="${LAMBDA_BIN:-}"
DOCKER_BUILDER="${DOCKER_BUILDER:-ores-oci-builder}"
R2_ARCHIVE="${R2_ARCHIVE:-false}"

if [[ -n "$LAMBDA_BIN" ]]; then
  PROVENANCE="${PROVENANCE:-false}"
  SBOM="${SBOM:-false}"
else
  PROVENANCE="${PROVENANCE:-true}"
  SBOM="${SBOM:-true}"
fi

require_env IMAGE_NAME
need docker

docker buildx version >/dev/null 2>&1 || die "docker buildx is required"
[[ -d "$BUILD_CONTEXT" ]] || die "BUILD_CONTEXT is not a directory: $BUILD_CONTEXT"
[[ -f "$DOCKERFILE" ]] || die "DOCKERFILE does not exist: $DOCKERFILE"

if [[ -n "$LAMBDA_BIN" && "$PLATFORMS" == *,* ]]; then
  die "AWS Lambda container images are single-architecture; set PLATFORMS to linux/amd64 or linux/arm64"
fi

if ! docker buildx inspect "$DOCKER_BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$DOCKER_BUILDER" --driver docker-container --use >/dev/null
else
  docker buildx use "$DOCKER_BUILDER"
fi

docker buildx inspect --bootstrap >/dev/null

declare -a tags=()

if [[ -n "${AWS_ECR_REPOSITORY:-}" ]]; then
  need aws
  AWS_ECR_REPOSITORY="$(normalize_prefix "$AWS_ECR_REPOSITORY")"
  [[ "$AWS_ECR_REPOSITORY" == */* ]] || die "AWS_ECR_REPOSITORY must be the full ECR repository URL"
  declare -a aws_login_args=(ecr get-login-password)
  if [[ -n "${AWS_REGION:-}" ]]; then
    aws_login_args+=(--region "$AWS_REGION")
  fi
  aws "${aws_login_args[@]}" \
    | docker login --username AWS --password-stdin "$(registry_host "$AWS_ECR_REPOSITORY")" >/dev/null
  tags+=("${AWS_ECR_REPOSITORY}:${IMAGE_TAG}")
fi

if [[ -n "${GCP_ARTIFACT_REGISTRY:-}" ]]; then
  need gcloud
  GCP_ARTIFACT_REGISTRY="$(normalize_prefix "$GCP_ARTIFACT_REGISTRY")"
  gcloud auth configure-docker "$(registry_host "$GCP_ARTIFACT_REGISTRY")" --quiet >/dev/null
  tags+=("${GCP_ARTIFACT_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}")
fi

if [[ -n "${AZURE_REGISTRY:-}" ]]; then
  need az
  AZURE_REGISTRY="$(normalize_prefix "$AZURE_REGISTRY")"
  azure_host="$(registry_host "$AZURE_REGISTRY")"
  azure_name="${azure_host%%.*}"
  az acr login --name "$azure_name" >/dev/null
  tags+=("${AZURE_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}")
fi

if [[ -n "${DOCKERHUB_NAMESPACE:-}" ]]; then
  require_env DOCKERHUB_USERNAME
  require_env DOCKERHUB_TOKEN
  printf '%s' "$DOCKERHUB_TOKEN" \
    | docker login --username "$DOCKERHUB_USERNAME" --password-stdin >/dev/null
  tags+=("${DOCKERHUB_NAMESPACE%/}/${IMAGE_NAME}:${IMAGE_TAG}")
fi

((${#tags[@]} > 0)) || die "no registry configured; set AWS_ECR_REPOSITORY, GCP_ARTIFACT_REGISTRY, AZURE_REGISTRY, or DOCKERHUB_NAMESPACE"

declare -a build_args=(
  build
  --platform "$PLATFORMS"
  --file "$DOCKERFILE"
  --provenance="$PROVENANCE"
  --sbom="$SBOM"
  --push
)

if [[ -n "$BUILD_TARGET" ]]; then
  build_args+=(--target "$BUILD_TARGET")
fi

if [[ -n "$LAMBDA_BIN" ]]; then
  build_args+=(--build-arg "LAMBDA_BIN=${LAMBDA_BIN}")
fi

for tag in "${tags[@]}"; do
  build_args+=(--tag "$tag")
done

build_args+=("$BUILD_CONTEXT")
docker buildx "${build_args[@]}"

printf 'Published %s to %d registry target(s).\n' "${IMAGE_NAME}:${IMAGE_TAG}" "${#tags[@]}"

if [[ "$R2_ARCHIVE" == "true" ]]; then
  need skopeo
  need aws
  require_env R2_BUCKET
  require_env R2_ENDPOINT_URL

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT
  archive="$tmpdir/${IMAGE_NAME//\//-}-${IMAGE_TAG}.oci.tar"
  digest_file="${archive}.sha256"

  skopeo copy --all "docker://${tags[0]}" "oci-archive:${archive}"
  sha256sum "$archive" > "$digest_file"

  prefix="s3://${R2_BUCKET%/}/oci/${IMAGE_NAME}/${IMAGE_TAG}"
  AWS_DEFAULT_REGION="${R2_REGION:-auto}" aws s3 cp "$archive" "$prefix/$(basename "$archive")" \
    --endpoint-url "$R2_ENDPOINT_URL" --no-progress
  AWS_DEFAULT_REGION="${R2_REGION:-auto}" aws s3 cp "$digest_file" "$prefix/$(basename "$digest_file")" \
    --endpoint-url "$R2_ENDPOINT_URL" --no-progress

  printf 'Archived OCI layout and checksum to %s\n' "$prefix"
fi
