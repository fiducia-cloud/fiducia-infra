import { readFileSync, statSync } from 'node:fs';
import { sources, roles, providers, digest, readinessFindings } from './policy.mjs';
import { tcpProbe, sqlProbe, isHost, isPort } from './network.mjs';
const read = path => {
  if (!path || statSync(path).size > 1_048_576) throw new Error('INPUT_UNAVAILABLE');
  return JSON.parse(readFileSync(path, 'utf8'));
};
try {
  if (process.env.INFRA_LIVE !== '1' || process.env.INFRA_RESUME_AUTHORIZED !== '1') throw new Error('LIVE_NOT_AUTHORIZED');
  const contract = read(new URL('./contract.json', import.meta.url));
  if (contract.expectedState !== 'active' || readinessFindings(contract).length) throw new Error('CONTRACT_NOT_READY');
  const source = process.env.INFRA_SOURCE, sourceVpcId = process.env.INFRA_SOURCE_VPC_ID, runId = process.env.INFRA_RUN_ID;
  if (!sources.includes(source) || !sourceVpcId || !runId) throw new Error('SOURCE_NOT_CONFIGURED');
  const area = contract.areas.find(a => a.role === source);
  if (area ? area.vpcId !== sourceVpcId : contract.areas.some(a => a.vpcId === sourceVpcId)) throw new Error('SOURCE_MISMATCH');
  const targets = read(process.env.INFRA_TARGETS_FILE);
  if (!Array.isArray(targets) || targets.length !== 6 || new Set(targets.map(t => t.provider + '/' + t.role)).size !== 6
    || !targets.every(t => t && Object.keys(t).sort().join(',') === 'host,port,provider,role' && providers.includes(t.provider) && roles.includes(t.role) && isHost(t.host) && isPort(t.port)))
    throw new Error('INVALID_TARGETS');
  const controlHost = process.env.INFRA_CONTROL_HOST;
  if (!isHost(controlHost) || targets.some(t => t.host === controlHost)) throw new Error('BASELINE_NOT_CONFIGURED');
  const ca = process.env.INFRA_CA_FILE ? readFileSync(process.env.INFRA_CA_FILE, 'utf8') : undefined;
  const baselineReachable = await tcpProbe(controlHost, 443) === 'allowed';
  const results = [];
  for (const target of targets) {
    const outcome = !baselineReachable ? 'inconclusive' : target.role === source
      ? await sqlProbe(process.env[target.provider.toUpperCase() + '_' + source.toUpperCase() + '_DATABASE_URL'], target, ca)
      : await tcpProbe(target.host, target.port);
    results.push({provider: target.provider, role: target.role, outcome});
  }
  console.log(JSON.stringify({schemaVersion: 1, githubOrg: contract.githubOrg, contractDigest: digest(contract), runId,
    source, sourceVpcId, observedAt: new Date().toISOString(), baselineReachable, results}, null, 2));
  process.exitCode = results.some(r => r.outcome === 'inconclusive') ? 2
    : results.some(r => r.outcome !== (r.role === source ? 'allowed' : 'denied')) ? 1 : 0;
} catch {
  console.log(JSON.stringify({status: 'blocked', code: 'PROBE_CONFIGURATION_OR_AUTHORIZATION_MISSING'}));
  process.exitCode = 2;
}
