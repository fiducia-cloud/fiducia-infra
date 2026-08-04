import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function filesUnder(relativeRoot) {
  const result = [];
  const visit = (relativePath) => {
    const absolute = path.join(root, relativePath);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relativePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result.push(child);
    }
  };
  visit(relativeRoot);
  return result;
}

test("cert-manager PKI is self-contained, short-lived at the leaf, and private-key free in Git", () => {
  const manifest = read("base/tls/fiducia-internal-pki.yaml");
  assert.match(manifest, /kind: ClusterIssuer[\s\S]*name: fiducia-selfsigned-bootstrap[\s\S]*selfSigned: \{\}/);
  assert.match(manifest, /kind: Certificate[\s\S]*name: fiducia-internal-ca[\s\S]*isCA: true/);
  assert.match(manifest, /duration: 43800h/);
  assert.match(manifest, /renewBefore: 4320h/);
  assert.match(manifest, /rotationPolicy: Never/);
  assert.match(manifest, /kind: Issuer[\s\S]*name: fiducia-internal-ca[\s\S]*secretName: fiducia-internal-ca/);
  assert.match(manifest, /name: fiducia-load-balance-tls[\s\S]*duration: 720h[\s\S]*renewBefore: 240h/);
  assert.match(manifest, /rotationPolicy: Always/);
  assert.match(manifest, /algorithm: ECDSA[\s\S]*size: 256/);
  for (const dnsName of [
    "fiducia-load-balance.fiducia.svc.cluster.local",
    "fiducia-load-balance-tls.fiducia.svc.cluster.local",
  ]) {
    assert.ok(manifest.includes(`- ${dnsName}`), `missing DNS SAN ${dnsName}`);
  }
  assert.doesNotMatch(manifest, /kind: Secret/);
  assert.doesNotMatch(manifest, /-----BEGIN (?:CERTIFICATE|PRIVATE KEY)-----/);
  assert.doesNotMatch(manifest, /tls\.key:\s*\|/);
});

test("load balancer fails closed on a required read-only serving Secret", () => {
  const deployment = read("base/load-balance/deployment.yaml");
  assert.match(deployment, /name: TLS_PORT[\s\S]*value: "8443"/);
  assert.match(deployment, /FIDUCIA_TLS_CERT_PATH[\s\S]*\/etc\/fiducia\/tls\/tls\.crt/);
  assert.match(deployment, /FIDUCIA_TLS_KEY_PATH[\s\S]*\/etc\/fiducia\/tls\/tls\.key/);
  assert.match(deployment, /name: tls[\s\S]*mountPath: \/etc\/fiducia\/tls[\s\S]*readOnly: true/);
  assert.match(deployment, /secretName: fiducia-load-balance-tls[\s\S]*optional: false[\s\S]*defaultMode: 0440/);
  assert.match(deployment, /fiducia\.cloud\/tls-rotation: rollout-required-after-secret-renewal/);
  assert.match(deployment, /readinessProbe:[\s\S]*port: 8088/);
  assert.match(deployment, /livenessProbe:[\s\S]*port: 8088/);
  assert.doesNotMatch(deployment, /optional: true/);
});

test("services expose a canonical internal TLS path and mark plaintext as health-only", () => {
  const service = read("base/load-balance/service.yaml");
  assert.match(service, /name: fiducia-load-balance-tls[\s\S]*fiducia\.cloud\/transport: verified-https[\s\S]*type: ClusterIP[\s\S]*port: 8443[\s\S]*targetPort: 8443/);
  assert.match(service, /name: fiducia-load-balance-internal[\s\S]*fiducia\.cloud\/transport: plaintext-health-only[\s\S]*name: health-http[\s\S]*port: 8088/);
  assert.match(service, /name: fiducia-load-balance[\s\S]*name: https[\s\S]*port: 443[\s\S]*targetPort: 8443/);
  assert.doesNotMatch(service, /name: fiducia-load-balance-tls[\s\S]{0,500}port: 8088/);
});

test("cloudflared verifies the private CA and cannot reach the plaintext origin", () => {
  const manifest = read("laptop/components/runtime/cloudflared.yaml");
  assert.match(manifest, /--origin-ca-pool[\s\S]*\/etc\/fiducia\/origin-ca\/ca\.crt/);
  assert.match(manifest, /fiducia\.cloud\/origin-url: https:\/\/fiducia-load-balance-tls\.fiducia\.svc\.cluster\.local:8443/);
  assert.match(manifest, /secretName: fiducia-load-balance-tls[\s\S]*key: ca\.crt[\s\S]*path: ca\.crt/);
  assert.match(manifest, /app: fiducia-load-balance[\s\S]*port: 8443/);
  assert.doesNotMatch(manifest, /app: fiducia-load-balance[\s\S]{0,300}port: 8088/);
  assert.doesNotMatch(manifest, /--no-tls-verify|noTLSVerify:\s*true/);
});

test("ESO contract uses hostname-verified HTTPS and pins only ca.crt", () => {
  const contract = read("contracts/external-secrets/dd-fiducia-kv.clustersecretstore.yaml");
  assert.match(contract, /kind: ClusterSecretStore/);
  assert.match(contract, /url: 'https:\/\/fiducia-load-balance-tls\.fiducia\.svc\.cluster\.local:8443\/v1\/kv\?key=\{\{ \.remoteRef\.key \}\}'/);
  assert.match(contract, /caProvider:[\s\S]*type: Secret[\s\S]*name: fiducia-load-balance-tls[\s\S]*namespace: fiducia[\s\S]*key: ca\.crt/);
  assert.match(contract, /Authorization: 'Bearer \{\{ \.auth\.token \}\}'/);
  assert.doesNotMatch(contract, /http:\/\//);
  assert.doesNotMatch(contract, /noTLSVerify|insecureSkipVerify|curl -k/);
  assert.doesNotMatch(contract, /key: tls\.key/);
});

test("tracked runtime manifests contain no plaintext Fiducia load-balancer client URL", () => {
  const candidates = [
    ...filesUnder("base"),
    ...filesUnder("laptop"),
    ...filesUnder("contracts"),
  ].filter((relativePath) => /\.(?:yaml|yml|json|toml|env|conf)$/.test(relativePath));

  for (const relativePath of candidates) {
    const content = read(relativePath);
    assert.doesNotMatch(
      content,
      /http:\/\/fiducia-load-balance(?:-internal|-tls)?(?:\.|:|\/)/,
      `${relativePath} contains a plaintext Fiducia load-balancer client URL`,
    );
  }
});

test("TLS alert contract covers readiness, expiry, handshakes, and downgrade attempts with bounded labels", () => {
  const rules = read("base/observability/tls-prometheus-rules.yaml");
  for (const alert of [
    "FiduciaInternalTlsCertificateNotReady",
    "FiduciaInternalTlsCertificateExpiresSoon",
    "FiduciaInternalTlsHandshakeFailures",
    "FiduciaPlaintextDowngradeAttempt",
  ]) {
    assert.match(rules, new RegExp(`alert: ${alert}`));
  }
  assert.match(rules, /certmanager_certificate_expiration_timestamp_seconds/);
  assert.match(rules, /certmanager_certificate_ready_status/);
  assert.match(rules, /fiducia_tls_handshake_failures_total/);
  assert.match(rules, /fiducia_plaintext_downgrade_rejections_total/);
  assert.doesNotMatch(rules, /tenant_id|organization_id|trace_id|certificate_pem|serial_number|client_hostname/);
});

test("certificate evidence capture never reads tls.key and emits only fingerprints/metadata", () => {
  const script = read("scripts/capture-fiducia-internal-tls-evidence.sh");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /umask 077/);
  assert.match(script, /Certificate\/fiducia-load-balance-tls is not Ready/);
  assert.match(script, /jsonpath='\{\.data\.tls\\\.crt\}'/);
  assert.match(script, /jsonpath='\{\.data\.ca\\\.crt\}'/);
  assert.match(script, /openssl verify -CAfile/);
  assert.match(script, /-checkend 604800/);
  assert.match(script, /DNS:\$dns_name/);
  assert.match(script, /leafSha256Fingerprint/);
  assert.match(script, /privateKey: "not-read"/);
  assert.match(script, /chmod 600/);
  assert.doesNotMatch(script, /jsonpath='\{\.data\.tls\\\.key\}'/);
  assert.doesNotMatch(script, /base64 -d[^\n]*tls\.key/);
  assert.doesNotMatch(script, /cat .*tls\.crt|cat .*ca\.crt|set -x|set -o xtrace|\bcurl\b|\bwget\b/);
});

test("base kustomization includes PKI and TLS alert resources", () => {
  const kustomization = read("base/kustomization.yaml");
  assert.match(kustomization, /tls\/fiducia-internal-pki\.yaml/);
  assert.match(kustomization, /observability\/tls-prometheus-rules\.yaml/);
});
