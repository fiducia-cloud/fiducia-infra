// Offline, read-only checkpoint verifier. It does NOT publish or restore state.
// No external dependencies, provider URLs, mutable locators or credentials.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const HEX = /^[0-9a-f]{64}$/;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_OBJECTS = 1024;
const MAX_BYTES_PER_OBJECT = 1024 * 1024 * 1024;

function assert(condition, reason) {
  if (!condition) throw new Error('checkpoint refused: ' + reason);
}
function exactKeys(value, keys, kind) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value),
    kind + ' must be an object');
  assert(Object.keys(value).sort().join(',') === [...keys].sort().join(','),
    kind + ' has missing or unknown fields');
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k =>
      JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  assert(value !== undefined && typeof value !== 'number' || Number.isFinite(value),
    'nonfinite value');
  return JSON.stringify(value);
}
function unsignedInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function positiveInt(value) {
  return unsignedInt(value) && value > 0;
}
function ident(value) {
  return typeof value === 'string' && IDENT.test(value);
}
function validatePayload(payload, expected) {
  exactKeys(payload, ['schema','cluster','shard','epoch','term','state_schema',
    'included_log_index','replay_from_log_index','creation_tool','objects'], 'payload');
  assert(payload.schema === 'fiducia.coordination-checkpoint.v1', 'unknown schema version');
  for (const name of ['cluster','shard','state_schema','creation_tool'])
    assert(ident(payload[name]), 'invalid ' + name);
  assert(positiveInt(payload.epoch) && positiveInt(payload.term), 'invalid epoch/term');
  assert(unsignedInt(payload.included_log_index)
    && unsignedInt(payload.replay_from_log_index)
    && payload.replay_from_log_index === payload.included_log_index + 1,
    'noncontiguous replay boundary');
  assert(payload.included_log_index < Number.MAX_SAFE_INTEGER,
    'log index overflow');
  assert(Array.isArray(payload.objects) && payload.objects.length > 0
    && payload.objects.length <= MAX_OBJECTS, 'invalid object count');
  const seen = new Set();
  for (const obj of payload.objects) {
    exactKeys(obj, ['role','sha256','bytes'], 'object descriptor');
    assert(ident(obj.role) && HEX.test(obj.sha256)
      && positiveInt(obj.bytes) && obj.bytes <= MAX_BYTES_PER_OBJECT,
      'invalid object descriptor');
    assert(!seen.has(obj.role), 'duplicate object role');
    seen.add(obj.role);
  }
  assert(expected && ident(expected.cluster) && ident(expected.shard)
    && positiveInt(expected.epoch) && unsignedInt(expected.replay_from_log_index),
    'trusted target cluster/shard/epoch/replay boundary required');
  assert(payload.cluster === expected.cluster && payload.shard === expected.shard,
    'cluster/shard mismatch');
  assert(payload.epoch === expected.epoch, 'stale or foreign epoch');
  assert(payload.replay_from_log_index === expected.replay_from_log_index,
    'replay boundary mismatch');
}
async function hashFile(path, expectedBytes) {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink() && st.size === expectedBytes,
    'object missing, nonregular or wrong size');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { flags: 'r' })) {
    bytes += chunk.length;
    assert(bytes <= expectedBytes, 'object size changed while reading');
    hash.update(chunk);
  }
  assert(bytes === expectedBytes, 'object truncated while reading');
  return hash.digest('hex');
}

/** Must be called before restore; neither this function nor its result authorizes activation. */
export async function verifyCheckpoint(manifest, {
  publicKey, trustedKeyId, objectsDir, expected
}) {
  exactKeys(manifest, ['payload','payload_sha256','auth'], 'manifest');
  exactKeys(manifest.auth, ['algorithm','key_id','signature_base64'], 'authentication');
  assert(manifest.auth.algorithm === 'ed25519-sha256-v1'
    && ident(manifest.auth.key_id), 'unsupported authentication');
  validatePayload(manifest.payload, expected);
  const digest = createHash('sha256').update(canonical(manifest.payload)).digest();
  assert(typeof manifest.payload_sha256 === 'string'
    && HEX.test(manifest.payload_sha256)
    && digest.toString('hex') === manifest.payload_sha256,
    'payload digest mismatch');
  assert(typeof manifest.auth.signature_base64 === 'string'
    && /^[A-Za-z0-9+/]+={0,2}$/.test(manifest.auth.signature_base64),
    'invalid signature encoding');
  const signature = Buffer.from(manifest.auth.signature_base64, 'base64');
  assert(signature.length === 64, 'invalid Ed25519 signature length');
  assert(publicKey && ident(trustedKeyId) && manifest.auth.key_id === trustedKeyId,
    'no matching independently trusted key ID/public key');
  const key = createPublicKey(publicKey);
  assert(key.asymmetricKeyType === 'ed25519'
    && verifySignature(null, digest, key, signature),
    'invalid manifest signature');
  assert(typeof objectsDir === 'string' && objectsDir.length > 0,
    'missing object storage directory');
  for (const obj of manifest.payload.objects) {
    // Digest-derived paths only: untrusted manifest strings never become paths.
    const path = join(objectsDir, 'sha256', obj.sha256);
    const actual = await hashFile(path, obj.bytes);
    assert(actual === obj.sha256, 'object digest mismatch: ' + obj.role);
  }
  return Object.freeze({
    verified: true, cluster: manifest.payload.cluster, shard: manifest.payload.shard,
    epoch: manifest.payload.epoch, replay_from_log_index: manifest.payload.replay_from_log_index,
    objects: manifest.payload.objects.length,
    authorization: 'offline-integrity-only-not-restore-activation'
  });
}
export function canonicalPayload(value) {
  return canonical(value);
}
export function digestPayload(value) {
  return createHash('sha256').update(canonical(value)).digest();
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const [manifestPath, objectsDir, publicKeyPath, trustedKeyId, cluster, shard, epoch, replay] = process.argv.slice(2);
  if (!manifestPath || !objectsDir || !publicKeyPath || !trustedKeyId || !cluster || !shard
      || epoch === undefined || replay === undefined) {
    console.error('usage: node tools/verify-coordination-checkpoint.mjs MANIFEST OBJECTS_DIR TRUSTED_PUBKEY_PEM TRUSTED_KEY_ID CLUSTER SHARD EPOCH REPLAY_FROM_INDEX');
    process.exitCode = 2;
  } else {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const publicKey = await readFile(publicKeyPath, 'utf8');
      console.log(JSON.stringify(await verifyCheckpoint(manifest, {
        objectsDir, publicKey, trustedKeyId, expected: {
          cluster, shard, epoch: Number(epoch), replay_from_log_index: Number(replay)
        }
      })));
    } catch (error) {
      console.error(String(error.message));
      process.exitCode = 1;
    }
  }
}
