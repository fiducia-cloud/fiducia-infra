import net from 'node:net';
import pg from 'pg';
export const isHost = host => typeof host === 'string' && host.length <= 253 && /^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host);
export const isPort = port => Number.isInteger(port) && [5432, 6543].includes(port);

export function connectionOptions(raw, target, ca) {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password
    || url.hostname !== target.host || Number(url.port || 5432) !== target.port || !url.pathname.slice(1)
    || url.hash || [...url.searchParams].some(([k,v]) => k !== 'sslmode' || v !== 'verify-full'))
    throw new Error('INVALID_CONNECTION_CONFIGURATION');
  return {host: target.host, port: target.port, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)), ssl: {rejectUnauthorized: true, ...(ca ? {ca} : {})},
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000, application_name: 'infra-isolation-readonly'};
}
export function tcpProbe(host, port, timeoutMs = 5000, connect = net.createConnection) {
  return new Promise(resolve => {
    let done = false, socket;
    const finish = result => { if (done) return; done = true; socket?.destroy(); resolve(result); };
    try {
      socket = connect({host, port});
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish('allowed'));
      socket.once('timeout', () => finish('denied'));
      socket.once('error', error => finish(['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code) ? 'denied' : 'inconclusive'));
    } catch { finish('inconclusive'); }
  });
}
export async function sqlProbe(raw, target, ca, makeClient = options => new pg.Client(options)) {
  let client;
  try {
    client = makeClient(connectionOptions(raw, target, ca));
    await client.connect();
    const result = await client.query('SELECT 1 AS isolation_probe');
    return result.rows?.[0]?.isolation_probe === 1 ? 'allowed' : 'inconclusive';
  } catch { return 'inconclusive'; }
  finally { if (client) { try { await client.end(); } catch { /* No provider error text is emitted. */ } } }
}
