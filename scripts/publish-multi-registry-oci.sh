#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "required environment variable is unset: $name"
}

has_target() {
  local needle="$1"
  local target
  IFS=',' read -r -a _targets <<< "$TARGET_REGISTRIES"
  for target in "${_targets[@]}"; do
    target="${target//[[:space:]]/}"
    [[ "$target" == "$needle" ]] && return 0
  done
  return 1
}

IMAGE_NAME="${IMAGE_NAME:-}"
require_env IMAGE_NAME
[[ "$IMAGE_NAME" =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]] ||
  fail "IMAGE_NAME must be a lowercase OCI repository component"

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'dev')}"
[[ "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] ||
  fail "IMAGE_TAG is not a valid OCI tag"

BUILD_CONTEXT="${BUILD_CONTEXT:-.}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
PLATFORMS="${PLATFORMS:-linux/amd64}"
TARGET_REGISTRIES="${TARGET_REGISTRIES:-}"
require_env TARGET_REGISTRIES
BUILDER_NAME="${BUILDER_NAME:-ores-oci-publisher}"

[[ -d "$BUILD_CONTEXT" ]] || fail "BUILD_CONTEXT is not a directory: $BUILD_CONTEXT"
[[ -f "$DOCKERFILE" ]] || fail "DOCKERFILE does not exist: $DOCKERFILE"

need docker

if [[ -n "${LAMBDA_BINARY:-}" && "$PLATFORMS" == *,* ]]; then
  fail "AWS Lambda images must be built one architecture at a time; publish separate amd64 and arm64 tags"
fi

declare -a tags=()
declare -a build_args=()

if [[ -n "${LAMBDA_BINARY:-}" ]]; then
  build_args+=(--build-arg "LAMBDA_BINARY=$LAMBDA_BINARY")
fi
if [[ -n "${RUST_VERSION:-}" ]]; then
  build_args+=(--build-arg "RUST_VERSION=$RUST_VERSION")
fi

if has_target ecr; then
  need aws
  require_env AWS_REGION
  require_env ECR_REGISTRY
  ECR_REPOSITORY="${ECR_REPOSITORY:-$IMAGE_NAME}"
  aws ecr get-login-password --region "$AWS_REGION" |
    docker login --username AWS --password-stdin "$ECR_REGISTRY"
  tags+=("${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}")
fi

if has_target gar; then
  need gcloud
  require_env GAR_REPOSITORY
  GAR_HOST="${GAR_REPOSITORY%%/*}"
  [[ "$GAR_HOST" != "$GAR_REPOSITORY" ]] ||
    fail "GAR_REPOSITORY must include host/project/repository"
  gcloud auth print-access-token |
    docker login --username oauth2accesstoken --password-stdin "$GAR_HOST"
  tags+=("${GAR_REPOSITORY}/${IMAGE_NAME}:${IMAGE_TAG}")
fi

if has_target acr; then
  need az
  require_env ACR_NAME
  require_env ACR_REGISTRY
  az acr login --name "$ACR_NAME" >/dev/null
  tags+=("${ACR_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}")
fi

if has_target dockerhub; then
  require_env DOCKERHUB_USERNAME
  require_env DOCKERHUB_TOKEN
  printf '%s' "$DOCKERHUB_TOKEN" |
    docker login --username "$DOCKERHUB_USERNAME" --password-stdin
  tags+=("${DOCKERHUB_USERNAME}/${IMAGE_NAME}:${IMAGE_TAG}")
fi

IFS=',' read -r -a requested_targets <<< "$TARGET_REGISTRIES"
for target in "${requested_targets[@]}"; do
  target="${target//[[:space:]]/}"
  case "$target" in
    ecr|gar|acr|dockerhub|r2) ;;
    *) fail "unsupported TARGET_REGISTRIES entry: $target" ;;
  esac
done

if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx use "$BUILDER_NAME"
else
  docker buildx create --name "$BUILDER_NAME" --use >/dev/null
fi
docker buildx inspect --bootstrap >/dev/null

if ((${#tags[@]} > 0)); then
  declare -a tag_args=()
  for tag in "${tags[@]}"; do
    tag_args+=(--tag "$tag")
  done

  docker buildx build \
    --builder "$BUILDER_NAME" \
    --platform "$PLATFORMS" \
    --file "$DOCKERFILE" \
    --provenance=true \
    --sbom=true \
    "${build_args[@]}" \
    "${tag_args[@]}" \
    --push \
    "$BUILD_CONTEXT"
fi

if has_target r2; then
  need aws
  require_env R2_ENDPOINT
  require_env R2_BUCKET

  archive="$(mktemp "${TMPDIR:-/tmp}/oci-image.XXXXXX.tar")"
  trap 'rm -f "$archive"' EXIT
  object_key="${R2_OBJECT_KEY:-oci/${IMAGE_NAME}/${IMAGE_TAG}/image.oci.tar}"

  docker buildx build \
    --builder "$BUILDER_NAME" \
    --platform "$PLATFORMS" \
    --file "$DOCKERFILE" \
    "${build_args[@]}" \
    --output "type=oci,dest=${archive}" \
    "$BUILD_CONTEXT"

  aws --endpoint-url "$R2_ENDPOINT" \
    s3 cp "$archive" "s3://${R2_BUCKET}/${object_key}" \
    --only-show-errors
fi

((${#tags[@]} > 0)) || has_target r2 ||
  fail "TARGET_REGISTRIES selected no push or archive destination"

printf 'published %s:%s for %s\n' "$IMAGE_NAME" "$IMAGE_TAG" "$PLATFORMS"
