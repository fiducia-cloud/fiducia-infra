import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const cwd = new URL('../', import.meta.url);
test('probe without explicit authorization refuses before network access', () => {
  const result = spawnSync(process.execPath, ['probe.mjs'], {cwd, encoding: 'utf8', env: {PATH: process.env.PATH}});
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).code, 'PROBE_CONFIGURATION_OR_AUTHORIZATION_MISSING');
  assert.equal(result.stderr, '');
});
test('configuration acceptance without evidence fails closed', () => {
  const result = spawnSync(process.execPath, ['acceptance.mjs'], {cwd, encoding: 'utf8', env: {PATH: process.env.PATH}});
  assert.notEqual(result.status, 0);
  assert.ok(['blocked', 'fail'].includes(JSON.parse(result.stdout).status));
  assert.equal(result.stderr, '');
});
