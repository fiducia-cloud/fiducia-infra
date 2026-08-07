#!/usr/bin/env bash
# Mint short-lived, single-bucket R2 credentials instead of handing out the
# account-wide R2 access key.
#
# WHY THIS EXISTS
#
# R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in env/enc/prod.env.enc are
# ACCOUNT-WIDE. They can read, write, and delete every bucket in the Cloudflare
# account -- not just fiducia's. That includes sonus-auris private audio
# segments and the zed package artifacts. One leaked fiducia credential is a
# total compromise of three products' object storage.
#
# Cloudflare's temp-access-credentials API issues credentials scoped to ONE
# bucket, ONE permission, and a TTL. Verified 2026-08-07: creds minted for
# fiducia-logs-prod could read/write that bucket and were denied on
# fiducia-kv-backups-prod, sonus-auris-segments-prod, and zed-pkg-artifacts.
#
# Anything that touches R2 -- CI, backup jobs, log shippers -- should call this
# rather than reading the parent key. The parent key should only ever be used to
# mint these.
set -euo pipefail

bucket=""
permission="object-read-only"
ttl="900"

usage() {
  cat <<'USAGE'
usage:
  scripts/r2-scoped-creds.sh --bucket fiducia-logs-prod \
    [--permission object-read-only|object-read-write] \
    [--ttl 900]

Prints shell `export` lines for AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
AWS_SESSION_TOKEN and the R2 endpoint. Evaluate them in a subshell:

  eval "$(scripts/r2-scoped-creds.sh --bucket fiducia-logs-prod)"
  aws s3 ls "s3://$R2_SCOPED_BUCKET/" --endpoint-url "$AWS_ENDPOINT_URL" --region auto

Requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (R2-capable) and
R2_ACCESS_KEY_ID in the environment -- e.g. `just env-decrypt` then source
env/dec/prod.env.

The credentials expire after --ttl seconds. Do not write them to disk and do not
bake them into an image; mint fresh ones per job.
USAGE
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --bucket) bucket="${2:-}"; shift 2 ;;
    --permission) permission="${2:-}"; shift 2 ;;
    --ttl) ttl="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[[ -n "$bucket" ]] || { usage >&2; fail "--bucket is required"; }

case "$permission" in
  object-read-only|object-read-write) ;;
  *) fail "--permission must be object-read-only or object-read-write" ;;
esac

[[ "$ttl" =~ ^[0-9]+$ ]] || fail "--ttl must be an integer number of seconds"
# Cloudflare rejects TTLs outside this range; fail early with a clear message.
(( ttl >= 900 && ttl <= 604800 )) || fail "--ttl must be between 900 and 604800 seconds"

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (see env/dec/prod.env)}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (needs R2 permission)}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID (the parent key these are derived from)}"

command -v curl >/dev/null || fail "curl not found"
command -v python3 >/dev/null || fail "python3 not found"

# Cloudflare will happily mint credentials for a bucket that does not exist; the
# failure only surfaces later as an opaque S3 error inside whatever job used
# them. Check up front so a typo fails here, loudly, instead of mid-pipeline.
if ! curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}" \
      | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' 2>/dev/null; then
  fail "bucket not found in account ${CLOUDFLARE_ACCOUNT_ID}: ${bucket}"
fi

response="$(
  curl -sS -X POST \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/temp-access-credentials" \
    --data @- <<JSON
{
  "bucket": "${bucket}",
  "parentAccessKeyId": "${R2_ACCESS_KEY_ID}",
  "permission": "${permission}",
  "ttlSeconds": ${ttl}
}
JSON
)"

# Parse and emit in python so no secret is ever echoed on a failure path.
#
# Note: no f-strings below. The system python on macOS is 3.9, which rejects a
# backslash inside an f-string expression -- and every dict lookup here would
# need one. str.format keeps this working on the stock interpreter.
ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" BUCKET="$bucket" TTL="$ttl" \
python3 -c '
import json, os, sys

raw = sys.stdin.read()
try:
    body = json.loads(raw)
except ValueError:
    sys.exit("error: Cloudflare returned a non-JSON response")

if not body.get("success"):
    errs = body.get("errors") or []
    detail = "; ".join(
        "{0}: {1}".format(e.get("code"), e.get("message")) for e in errs
    ) or "unknown error"
    sys.exit("error: Cloudflare refused to mint credentials -- " + detail)

r = body["result"]
account = os.environ["ACCOUNT_ID"]
bucket = os.environ["BUCKET"]

for line in (
    "export AWS_ACCESS_KEY_ID={0}".format(r["accessKeyId"]),
    "export AWS_SECRET_ACCESS_KEY={0}".format(r["secretAccessKey"]),
    "export AWS_SESSION_TOKEN={0}".format(r["sessionToken"]),
    "export AWS_ENDPOINT_URL=https://{0}.r2.cloudflarestorage.com".format(account),
    "export AWS_REGION=auto",
    "export R2_SCOPED_BUCKET={0}".format(bucket),
):
    print(line)

# Diagnostics go to stderr so `eval "$(...)"` stays clean.
sys.stderr.write(
    "scoped to {0}, expires in {1}s\n".format(bucket, os.environ["TTL"])
)
' <<<"$response"
