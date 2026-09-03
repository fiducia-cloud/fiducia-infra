#!/usr/bin/env bash
set -euo pipefail

# Fiducia consumes the reviewed fleet publisher by immutable commit and Git
# blob. Configuration and credentials remain environment-only.
readonly upstream_commit='e0454f5d0d8c970dfa206595a48eda5ead382544'
readonly upstream_blob='8490ce53434410192c750b10d17fe122e9df30be'
readonly upstream_url="https://raw.githubusercontent.com/zed-pkg/zed-infra/${upstream_commit}/scripts/oci/build-and-push.sh"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 70
}

[[ $# -eq 0 ]] || {
  printf 'error: configuration is environment-only; command arguments are not accepted\n' >&2
  exit 64
}
command -v git >/dev/null 2>&1 || fail 'git is required to verify the pinned publisher blob'

tmp="$(mktemp -d)"
cleanup() {
  find "$tmp" -depth -delete
}
trap cleanup EXIT
publisher="$tmp/build-and-push.sh"

if [[ -n "${OCI_PUBLISHER_FILE:-}" ]]; then
  [[ -f "$OCI_PUBLISHER_FILE" ]] || fail "OCI_PUBLISHER_FILE is not a regular file: ${OCI_PUBLISHER_FILE}"
  cp "$OCI_PUBLISHER_FILE" "$publisher"
else
  command -v curl >/dev/null 2>&1 || fail 'curl is required to retrieve the pinned publisher'
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    "$upstream_url" --output "$publisher"
fi

actual_blob="$(git hash-object "$publisher")"
[[ "$actual_blob" == "$upstream_blob" ]] ||
  fail "publisher integrity mismatch: expected ${upstream_blob}, got ${actual_blob}"

case "${OCI_TOOLKIT_VERIFY_ONLY:-false}" in
  true)
    printf 'verified OCI publisher: zed-pkg/zed-infra@%s blob=%s\n' "$upstream_commit" "$upstream_blob"
    ;;
  false)
    bash "$publisher"
    ;;
  *)
    printf 'error: OCI_TOOLKIT_VERIFY_ONLY must be true or false\n' >&2
    exit 64
    ;;
esac
