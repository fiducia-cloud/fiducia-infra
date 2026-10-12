import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestPayload, verifyCheckpoint } from './verify-coordination-checkpoint.mjs';

test('signed immutable checkpoint is accepted only with complete scoped objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fiducia-checkpoint-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  try {
    const bytes = Buffer.from('immutable-state-v1');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await mkdir(join(root, 'sha256'));
    const objectPath = join(root, 'sha256', digest);
    await writeFile(objectPath, bytes);
    const payload = {
      schema: 'fiducia.coordination-checkpoint.v1',
      cluster: 'cluster-1', shard: 'shard-4', epoch: 9, term: 11,
      state_schema: 'kv-v3', included_log_index: 42,
      replay_from_log_index: 43, creation_tool: 'fiducia-checkpoint-v1',
      objects: [{ role: 'state', sha256: digest, bytes: bytes.length }]
    };
    const signed = p => {
      const sha = digestPayload(p);
      return {
        payload: p,
        payload_sha256: sha.toString('hex'),
        auth: { algorithm: 'ed25519-sha256-v1', key_id: 'offline-test',
          signature_base64: sign(null, sha, privateKey).toString('base64') }
      };
    };
    const expected = { cluster: 'cluster-1', shard: 'shard-4',
      epoch: 9, replay_from_log_index: 43 };
    const verify = (manifest, overrides = {}) => verifyCheckpoint(manifest, {
      publicKey: pem, trustedKeyId: 'offline-test', objectsDir: root, expected, ...overrides
    });
    assert.equal((await verify(signed(payload))).verified, true);
    // A path-to-object symlink with matching bytes and digest must still be
    // rejected. The file descriptor, not a previously checked pathname,
    // determines what can be read.
    const copyOutside = join(root, 'matching-outside-object');
    await writeFile(copyOutside, bytes);
    await rm(objectPath);
    await symlink(copyOutside, objectPath);
    await assert.rejects(verify(signed(payload)));
    await rm(objectPath);
    await writeFile(objectPath, bytes);
    assert.equal((await verify(signed(payload))).verified, true);
    // Also reject a symlinked digest directory; even if its files are valid,
    // this would weaken the digest-only lookup contract.
    const realDir = join(root, 'digest-directory-backup');
    await rename(join(root, 'sha256'), realDir);
    await symlink(realDir, join(root, 'sha256'));
    await assert.rejects(verify(signed(payload)), /real directory/);
    await rm(join(root, 'sha256'));
    await rename(realDir, join(root, 'sha256'));
    // Valid signatures on wrong identities/log boundaries still fail closed.
    for (const override of [
      { shard: 'shard-5' }, { epoch: 8 }, { replay_from_log_index: 44 },
      { cluster: 'cluster-other' }
    ]) {
      await assert.rejects(verify(signed(payload), { expected: { ...expected, ...override } }));
    }
    await assert.rejects(verify(signed({ ...payload, replay_from_log_index: 44 })));
    await assert.rejects(verify(signed({ ...payload, objects: [] })));
    await assert.rejects(verify(signed({ ...payload, objects:
      [{ ...payload.objects[0], role: '../unsafe' }] })));
    await assert.rejects(verify(signed({ ...payload, objects:
      [...payload.objects, payload.objects[0]] })));
    const forged = signed(payload);
    forged.payload = { ...payload, epoch: 10 };
    await assert.rejects(verify(forged));
    await assert.rejects(verify(signed(payload), { trustedKeyId: 'wrong-key' }));
    await assert.rejects(verify(signed(payload), { publicKey:
      generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) }));
    await writeFile(objectPath, Buffer.from('immutable-state-v2'));
    await assert.rejects(verify(signed(payload)), /digest mismatch/);
    await rm(objectPath);
    await assert.rejects(verify(signed(payload)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects unsigned, unsupported, invalid and missing key metadata', async () => {
  const p = {
    schema: 'fiducia.coordination-checkpoint.v1',
    cluster: 'a', shard: 'b', epoch: 1, term: 1,
    state_schema: 's', included_log_index: 0, replay_from_log_index: 1,
    creation_tool: 't',
    objects: [{ role: 'state', sha256: '0'.repeat(64), bytes: 1 }]
  };
  const manifest = { payload: p, payload_sha256: digestPayload(p).toString('hex'),
    auth: { algorithm: 'none', key_id: 'k', signature_base64: '' } };
  await assert.rejects(verifyCheckpoint(manifest, {}), /unsupported authentication/);
  manifest.auth.algorithm = 'ed25519-sha256-v1';
  await assert.rejects(verifyCheckpoint(manifest, {
    expected: { cluster: 'a', shard: 'b', epoch: 1, replay_from_log_index: 1 }
  }), /invalid signature encoding/);
});
