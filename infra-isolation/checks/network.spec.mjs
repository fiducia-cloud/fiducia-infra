import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connectionOptions, tcpProbe, sqlProbe } from '../network.mjs';
const target = {host: 'db.example.test', port: 5432};
const url = 'postgresql://reader:synthetic-password@db.example.test/db';
test('SQL probe verifies TLS and sets bounded read-only query timeouts', () => {
  const options = connectionOptions(url, target);
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.connectionTimeoutMillis, 5000);
  assert.equal(options.statement_timeout, 5000);
});
for (const [name, value] of [
  ['TLS disabled', url + '?sslmode=disable'], ['TLS require without verification', url + '?sslmode=require'],
  ['SSL parameter injection', url + '?sslcert=/tmp/cert'], ['foreign hostname', url.replace('db.example.test', 'foreign.example.test')],
  ['foreign port', url.replace('/db', ':6543/db')], ['wrong protocol', url.replace('postgresql:', 'https:')],
  ['missing password', 'postgresql://reader@db.example.test/db']
]) test('rejects ' + name, () => assert.throws(() => connectionOptions(value, target)));
const connect = event => () => {
  const socket = new EventEmitter(); socket.setTimeout = () => {}; socket.destroy = () => {};
  queueMicrotask(() => event(socket)); return socket;
};
test('TCP connection is an exposure even without successful authentication', async () =>
  assert.equal(await tcpProbe(target.host, 5432, 1, connect(s => s.emit('connect'))), 'allowed'));
test('DNS failure does not count as isolation', async () =>
  assert.equal(await tcpProbe(target.host, 5432, 1, connect(s => s.emit('error', {code: 'ENOTFOUND'}))), 'inconclusive'));
test('bounded timeout produces a candidate denial requiring independent positive controls', async () =>
  assert.equal(await tcpProbe(target.host, 5432, 1, connect(s => s.emit('timeout'))), 'denied'));
test('SQL authentication error is inconclusive and does not leak its text', async () => {
  let closed = false;
  const result = await sqlProbe(url, target, undefined, () => ({
    connect: async () => { throw new Error('synthetic-secret'); },
    end: async () => { closed = true; }
  }));
  assert.equal(result, 'inconclusive'); assert.equal(closed, true);
});
test('SQL probe issues only SELECT 1 and closes connection', async () => {
  const calls = [];
  assert.equal(await sqlProbe(url, target, undefined, () => ({
    connect: async () => calls.push('connect'),
    query: async text => { calls.push(text); return {rows: [{isolation_probe: 1}]}; },
    end: async () => calls.push('end')
  })), 'allowed');
  assert.deepEqual(calls, ['connect', 'SELECT 1 AS isolation_probe', 'end']);
});
