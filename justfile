# fiducia-infra — task runner. Run `just` to see everything.
#
# Environment secrets live in env/enc/*.env.enc, encrypted with sops + age and
# committed to this repo. See env/README.md for the workflow.

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
