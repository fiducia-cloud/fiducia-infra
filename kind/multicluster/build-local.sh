#!/usr/bin/env bash
# Build the fiducia service images from LOCAL source, tagged to match up.sh's
# defaults. The repos' own Dockerfiles git-fetch sibling deps at pinned SHAs,
# which can trail the working tree — this builds what's actually checked out
# (Dockerfile.local + the workspace-root .dockerignore include-list).
#
#   ./build-local.sh                          # build all 4 service images
#   ./build-local.sh brain                    # build a subset (short names)
#   FIDUCIA_KIND_LOAD=1 ./build-local.sh ...  # then `kind load` into the 3 clusters
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools docker

WORKSPACE="$(cd "$HERE/../../.." && pwd)"   # fiducia.cloud workspace root (build context)
SERVICES=(node brain node-sidecar load-balance)
[[ $# -gt 0 ]] && SERVICES=("$@")

images=()
for s in "${SERVICES[@]}"; do
  crate="fiducia-${s}.rs"
  image="ghcr.io/fiducia-cloud/fiducia-${s}:v0.1.0"
  [[ -d "$WORKSPACE/$crate" ]] || die "no such crate dir: $WORKSPACE/$crate (services: node brain node-sidecar load-balance)"
  log "building $image from LOCAL $crate…"
  docker build -f "$HERE/Dockerfile.local" --build-arg CRATE="$crate" -t "$image" "$WORKSPACE"
  ok "$image"
  images+=("$image")
done

if [[ "${FIDUCIA_KIND_LOAD:-0}" == "1" ]]; then
  require_tools kind
  for c in "${CLUSTERS[@]}"; do
    log "kind load into $(kind_name "$c")…"
    kind load docker-image "${images[@]}" --name "$(kind_name "$c")"
  done
fi
