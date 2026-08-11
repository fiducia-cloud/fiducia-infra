# fiducia-infra — task runner. Run `just` to see everything.
#
# Environment secrets live in env/enc/*.env.enc, encrypted with sops + age and
# committed to this repo. See env/README.md for the workflow.

# Exported assignments are always evaluated by Just, even if lazy evaluation is
# enabled later. Empty ignored directories do not survive Git, so prepare the
# owner-only plaintext boundary before parsing or running any recipe.
export FIDUCIA_ENV_DEC := ```
  set -eu
  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  if [ -L "$root/env" ] || [ -L "$root/env/dec" ]; then
    echo "refusing to prepare symlinked env/dec" >&2
    exit 1
  fi
  umask 077
  mkdir -p "$root/env/dec"
  chmod 700 "$root/env/dec"
  printf '%s' "$root/env/dec"
```

import '.just/env.just'

# Show available recipes.
default:
    @just --list

# ─── cloudflare tunnels (localhost testing) ─────────────────────────────────
#
# Expose a locally-running service to the public internet for testing against
# real callers — webhooks, mobile devices, Cloudflare-side behaviour.
#
# Pair with env-docker-run so the container gets its secrets from sops:
#   just env-docker-run prod -d --rm --name api -p 18080:8080 <image>
#   just tunnel 18080

# SECURITY: a tunnel publishes a local port to the entire internet with NO
# authentication. Anyone who learns the hostname reaches the laptop directly —
# Cloudflare proxies it, it does not gate it. Prefer the quick tunnel (random,
# throwaway hostname), keep it running only while actively testing, and tear it
# down with `just tunnel-down`. For anything longer-lived, put Cloudflare Access
# in front of the hostname; neither current API token has the scope to do that,
# so it must be added in the dashboard.

# Quick tunnel: random *.trycloudflare.com URL. No token, no DNS, ephemeral.
[group('cloudflare')]
tunnel port="8080":
    @echo "exposing http://localhost:{{ port }} — the URL is printed below" >&2
    cloudflared tunnel --url http://localhost:{{ port }} --no-autoupdate

# Named tunnel on a fiducia.cloud hostname — stable URL across restarts.
#
# NOTE: the account token stored in env/enc/prod.env.enc has Tunnel:Edit and
# Account:Read but NOT DNS:Edit — verified 2026-08-07, the DNS record POST
# returns "Authentication error" while zone listing succeeds. Until the token
# is regranted with Zone > DNS > Edit on fiducia.cloud, create the CNAME
# (<sub> -> <tunnel-id>.cfargotunnel.com, proxied) in the dashboard, or use
# `just tunnel` above. Cloudflare's tokens/verify reports "valid" either way,
# so scope must be probed, never assumed.
[group('cloudflare')]
[doc("Named tunnel on <sub>.fiducia.cloud (needs DNS:Edit for the CNAME)")]
tunnel-named sub port:
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(sops decrypt --input-type dotenv --output-type dotenv \
            env/enc/prod.env.enc | python3 .just/dotenv.py shell)"
    api=https://api.cloudflare.com/client/v4
    tid=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
          "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?name=fiducia-localhost-test" \
          | jq -r '.result[0].id // empty')
    [ -n "$tid" ] || { echo "tunnel 'fiducia-localhost-test' not found" >&2; exit 1; }
    curl -sf -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H 'content-type: application/json' \
      "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$tid/configurations" \
      --data "{\"config\":{\"ingress\":[{\"hostname\":\"{{ sub }}.fiducia.cloud\",\"service\":\"http://localhost:{{ port }}\"},{\"service\":\"http_status:404\"}]}}" \
      >/dev/null
    echo "ingress: {{ sub }}.fiducia.cloud -> http://localhost:{{ port }}"
    echo "CNAME still required: {{ sub }} -> $tid.cfargotunnel.com (proxied)"
    tok=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
          "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$tid/token" | jq -r '.result')
    exec cloudflared tunnel run --token "$tok"

# Stop tunnels started from this repo and show what is still exposed.
[group('cloudflare')]
tunnel-down host="localhost-test.fiducia.cloud":
    #!/usr/bin/env bash
    set -uo pipefail
    # Match the BINARY, not a subcommand phrase. cloudflared accepts flags
    # before the subcommand, so `cloudflared --no-autoupdate tunnel run` does
    # not contain the substring "cloudflared tunnel" — a pattern like that
    # reports "nothing running" while the origin stays public.
    pat='(^|/)cloudflared( |$)'
    before=$(pgrep -f "$pat" | wc -l | tr -d ' ')
    echo "cloudflared processes: $before"
    ps -eo pid,command | grep -E '[c]loudflared' | cut -c1-100 | sed 's/^/  /'

    # Quick tunnels are always this session's to kill. Named connectors are not:
    # other repos and other agents on this machine run their own, so they are
    # listed for the operator rather than killed blind.
    pkill -f 'cloudflared .*tunnel .*--url|cloudflared tunnel --url' 2>/dev/null || true
    sleep 1
    # Verify, never trust pkill's exit status.
    after=$(pgrep -f "$pat" | wc -l | tr -d ' ')
    echo "remaining after stopping quick tunnels: $after"
    [ "$after" -gt 0 ] && echo "  named connectors still up — kill by pid if they are yours"

    # curl exits 0 for ANY response it received, including Cloudflare's 530
    # "no origin". Judge on the status code, not the exit code.
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "https://{{ host }}/" 2>/dev/null || echo 000)
    case "$code" in
      530|1033|000) echo "{{ host }} -> HTTP $code (closed: no connector)" ;;
      *)            echo "{{ host }} -> HTTP $code — STILL PUBLICLY REACHABLE" ;;
    esac
    echo "to close permanently, delete the CNAME:"
    echo "  record 282f2ee18fdd81362d5e66835048298c (see Linear 'DNS baseline — fiducia.cloud zone')"
