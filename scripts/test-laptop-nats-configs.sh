#!/usr/bin/env bash
# Parse every generated laptop NATS configuration with the exact production
# server image. Synthetic credentials and a short-lived test CA exist only in a
# private temporary directory and are never applied to Kubernetes.
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATS_IMAGE='nats:2.11.17-alpine@sha256:e4bf19f15fd3218814a4e3c9e0064e1334bd8aa20d5984b9f1a0afd084f8cc00'

for command in docker openssl; do
  command -v "$command" >/dev/null || {
    echo "error: $command is required" >&2
    exit 1
  }
done

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/auth" "$tmpdir/route-tls" "$tmpdir/jetstream"

cat >"$tmpdir/auth/auth.conf" <<'EOF'
system_account: SYS
accounts {
  SYS {
    users: [ { user: "ci-system", password: "ci-system-password" } ]
  }
  FIDUCIA {
    jetstream: enabled
    users: [
      {
        user: "ci-relay"
        password: "ci-relay-password"
        permissions: {
          publish: { allow: [ "fiducia.>", "$JS.API.>", "$JS.ACK.>" ] }
          subscribe: { allow: [ "fiducia.>", "_INBOX.>" ] }
        }
      }
    ]
  }
}
EOF

cat >"$tmpdir/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
req_extensions = req_ext

[dn]
CN = fiducia-laptop-nats-route-ci

[req_ext]
subjectAltName = @alt_names
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth

[alt_names]
DNS.1 = fiducia-nats-route-laptop-aws-sim-tailnet.fiducia.svc.cluster.local
DNS.2 = fiducia-nats-route-laptop-gcp-sim-tailnet.fiducia.svc.cluster.local
DNS.3 = fiducia-nats-route-laptop-azure-sim-tailnet.fiducia.svc.cluster.local
DNS.4 = fiducia-nats-route-laptop-aws-sim.example.ts.net
DNS.5 = fiducia-nats-route-laptop-gcp-sim.example.ts.net
DNS.6 = fiducia-nats-route-laptop-azure-sim.example.ts.net
EOF

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$tmpdir/ca.key" \
  -out "$tmpdir/route-tls/ca.crt" \
  -days 1 \
  -subj '/CN=fiducia-laptop-nats-route-ci-ca' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  >/dev/null 2>&1

openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$tmpdir/route-tls/tls.key" \
  -out "$tmpdir/leaf.csr" \
  -config "$tmpdir/openssl.cnf" \
  >/dev/null 2>&1

openssl x509 -req \
  -in "$tmpdir/leaf.csr" \
  -CA "$tmpdir/route-tls/ca.crt" \
  -CAkey "$tmpdir/ca.key" \
  -CAcreateserial \
  -out "$tmpdir/route-tls/tls.crt" \
  -days 1 \
  -extensions req_ext \
  -extfile "$tmpdir/openssl.cnf" \
  >/dev/null 2>&1

for config in "$repo_root"/laptop/clusters/laptop-*-sim/nats.conf; do
  cluster="$(basename "$(dirname "$config")")"
  install -m 600 "$config" "$tmpdir/nats.conf"
  echo "validating $cluster with $NATS_IMAGE"
  docker run --rm --network none \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    -v "$tmpdir/nats.conf:/etc/nats/nats.conf:ro" \
    -v "$tmpdir/auth:/etc/nats/auth:ro" \
    -v "$tmpdir/route-tls:/etc/nats/route-tls:ro" \
    -v "$tmpdir/jetstream:/data/jetstream" \
    "$NATS_IMAGE" \
    -t -c /etc/nats/nats.conf
  rm -f "$tmpdir/nats.conf"
done

echo "all laptop NATS configurations passed pinned-server syntax validation"
