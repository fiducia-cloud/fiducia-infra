#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: r2-scoped-creds.sh --bucket NAME --permission PERMISSION [--ttl SECONDS] [--prefix PATH]...

Mint short-lived R2 S3 credentials scoped to one Fiducia-owned bucket. The
parent Cloudflare API token and R2 access key stay in the trusted caller
environment; only the temporary credential is emitted.

Bucket naming:
  - Cloudflare R2 names are 3-63 characters using lowercase a-z, 0-9, and '-'.
  - Names must begin and end with an alphanumeric character.
  - Fiducia-owned buckets must begin with the reserved 'fiducia-' prefix.
  - Multiple buckets are supported, including per-customer names such as
    fiducia-customer-<stable-id>-<purpose>-<environment>.

Required environment:
  CLOUDFLARE_ACCOUNT_ID    Cloudflare account ID
  CLOUDFLARE_API_TOKEN     API token authorized for R2 temporary credentials
  R2_ACCESS_KEY_ID         parent R2 access key ID used for delegation

Permissions:
  object-read-only | object-read-write | admin-read-only | admin-read-write

The output is shell-safe export statements suitable for:
  eval "$(scripts/r2-scoped-creds.sh --bucket BUCKET --permission object-read-only)"
EOF
}

bucket=""
permission=""
ttl=900
prefixes=()

while (($#)); do
  case "$1" in
    --bucket) bucket=${2:?missing value for --bucket}; shift 2 ;;
    --permission) permission=${2:?missing value for --permission}; shift 2 ;;
    --ttl) ttl=${2:?missing value for --ttl}; shift 2 ;;
    --prefix) prefixes+=("${2:?missing value for --prefix}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}"
[[ -n "$bucket" ]] || { echo "--bucket is required" >&2; exit 2; }

validate_bucket_name() {
  local candidate=$1
  local length=${#candidate}

  if (( length < 3 || length > 63 )); then
    echo "invalid --bucket: R2 bucket names must be 3-63 characters" >&2
    return 2
  fi

  if [[ ! "$candidate" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
    echo "invalid --bucket: use lowercase letters, numbers, and hyphens; begin/end with alphanumeric" >&2
    return 2
  fi

  if [[ "$candidate" != fiducia-* ]]; then
    echo "invalid --bucket: Fiducia R2 buckets must begin with the reserved fiducia- prefix" >&2
    return 2
  fi

  if [[ "$candidate" == "fiducia-" ]]; then
    echo "invalid --bucket: Fiducia R2 bucket name is missing its purpose/customer suffix" >&2
    return 2
  fi
}

validate_bucket_name "$bucket"

case "$permission" in
  object-read-only|object-read-write|admin-read-only|admin-read-write) ;;
  *) echo "invalid --permission: $permission" >&2; exit 2 ;;
esac

[[ "$ttl" =~ ^[0-9]+$ ]] || { echo "--ttl must be an integer" >&2; exit 2; }
(( ttl >= 60 && ttl <= 604800 )) || {
  echo "--ttl must be between 60 and 604800 seconds" >&2
  exit 2
}

request_file=$(mktemp)
response_file=$(mktemp)
trap 'rm -f "$request_file" "$response_file"' EXIT

BUCKET="$bucket" PERMISSION="$permission" TTL="$ttl" \
PARENT_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
PREFIXES_JSON="$(printf '%s\n' "${prefixes[@]-}" | python3 -c 'import json,sys; print(json.dumps([line.rstrip("\n") for line in sys.stdin if line.rstrip("\n")]))')" \
python3 - "$request_file" <<'PY'
import json
import os
import sys

payload = {
    "bucket": os.environ["BUCKET"],
    "parentAccessKeyId": os.environ["PARENT_ACCESS_KEY_ID"],
    "permission": os.environ["PERMISSION"],
    "ttlSeconds": int(os.environ["TTL"]),
}
prefixes = json.loads(os.environ["PREFIXES_JSON"])
if prefixes:
    payload["prefixes"] = prefixes
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(payload, fh, separators=(",", ":"))
PY

curl_bin=${CURL_BIN:-curl}
http_code=$(
  "$curl_bin" --silent --show-error \
    --output "$response_file" \
    --write-out '%{http_code}' \
    --request POST \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/temp-access-credentials"
)

if [[ "$http_code" != 2?? ]]; then
  echo "Cloudflare temporary-credential request failed (HTTP $http_code)" >&2
  python3 - "$response_file" <<'PY' >&2
import json,sys
try:
    data=json.load(open(sys.argv[1], encoding="utf-8"))
    for err in data.get("errors", []):
        print(err.get("message", "Cloudflare API error"))
except Exception:
    print("Cloudflare returned an unreadable error response")
PY
  exit 1
fi

python3 - "$response_file" "$CLOUDFLARE_ACCOUNT_ID" <<'PY'
import json
import shlex
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    response = json.load(fh)
if response.get("success") is not True:
    raise SystemExit("Cloudflare temporary-credential response was not successful")
result = response.get("result") or {}
required = ("accessKeyId", "secretAccessKey", "sessionToken")
missing = [key for key in required if not result.get(key)]
if missing:
    raise SystemExit("Cloudflare response missing temporary credential fields")

values = {
    "AWS_ACCESS_KEY_ID": result["accessKeyId"],
    "AWS_SECRET_ACCESS_KEY": result["secretAccessKey"],
    "AWS_SESSION_TOKEN": result["sessionToken"],
    "AWS_ENDPOINT_URL": f"https://{sys.argv[2]}.r2.cloudflarestorage.com",
}
for key, value in values.items():
    print(f"export {key}={shlex.quote(value)}")
PY