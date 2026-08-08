#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=""
data=""
while (($#)); do
  case "$1" in
    --output) out=$2; shift 2 ;;
    --data-binary) data=$2; shift 2 ;;
    --write-out|--request|--header) shift 2 ;;
    --silent|--show-error) shift ;;
    http*) url=$1; shift ;;
    *) echo "unexpected curl arg: $1" >&2; exit 90 ;;
  esac
done
[[ "$url" == "https://api.cloudflare.com/client/v4/accounts/acct-test/r2/temp-access-credentials" ]]
[[ "$data" == @* ]]
cp "${data#@}" "$REQUEST_CAPTURE"
cat >"$out" <<'JSON'
{"success":true,"result":{"accessKeyId":"TMP_ACCESS","secretAccessKey":"TMP_SECRET","sessionToken":"TMP_SESSION"}}
JSON
printf '200'
EOF
chmod +x "$tmp/curl"

export CLOUDFLARE_ACCOUNT_ID=acct-test
export CLOUDFLARE_API_TOKEN=api-token-placeholder
export R2_ACCESS_KEY_ID=parent-access-placeholder
export CURL_BIN="$tmp/curl"
export REQUEST_CAPTURE="$tmp/request.json"

output=$(bash "$repo_root/scripts/r2-scoped-creds.sh" \
  --bucket fiducia-logs-prod \
  --permission object-read-only \
  --ttl 900 \
  --prefix logs/ \
  --prefix audit/)

python3 - "$REQUEST_CAPTURE" <<'PY'
import json,sys
with open(sys.argv[1], encoding="utf-8") as fh:
    request=json.load(fh)
assert request == {
    "bucket": "fiducia-logs-prod",
    "parentAccessKeyId": "parent-access-placeholder",
    "permission": "object-read-only",
    "ttlSeconds": 900,
    "prefixes": ["logs/", "audit/"],
}, request
PY

grep -Fq "export AWS_ACCESS_KEY_ID=TMP_ACCESS" <<<"$output"
grep -Fq "export AWS_SECRET_ACCESS_KEY=TMP_SECRET" <<<"$output"
grep -Fq "export AWS_SESSION_TOKEN=TMP_SESSION" <<<"$output"
grep -Fq "export AWS_ENDPOINT_URL=https://acct-test.r2.cloudflarestorage.com" <<<"$output"

if bash "$repo_root/scripts/r2-scoped-creds.sh" --bucket test --permission root >/dev/null 2>&1; then
  echo "invalid permission unexpectedly succeeded" >&2
  exit 1
fi

if bash "$repo_root/scripts/r2-scoped-creds.sh" --bucket test --permission object-read-only --ttl 604801 >/dev/null 2>&1; then
  echo "oversized TTL unexpectedly succeeded" >&2
  exit 1
fi

printf 'r2-scoped-creds contract: ok\n'
