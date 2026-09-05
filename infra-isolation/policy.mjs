import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';

export const roles = Object.freeze(['canonical', 'auth', 'admin']);
export const providers = Object.freeze(['neon', 'supabase']);
export const sources = Object.freeze([...roles, 'public', 'foreign']);
const key = p => `${p.provider}/${p.role}`;
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(JSON.parse(readFileSync(new URL('./contract.schema.json', import.meta.url))));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const unique = a => new Set(a).size === a.length;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const issue = (code, path, severity = 'fail') => ({ code, path, severity });

export function contractFindings(contract) {
  if (!validate(contract)) return validate.errors.map(e => issue('SCHEMA', e.instancePath));
  const f = [];
  if (!same(contract.areas.map(a => a.role), roles)) f.push(issue('AREA_ROLES', '/areas'));
  if (!same(contract.projects.map(key), providers.flatMap(provider => roles.map(role => key({provider, role})))))
    f.push(issue('PROJECT_ROLES', '/projects'));
  for (const field of ['vpcId', 'sourceSecurityGroup', 'workloadIdentity', 'credentialRef']) {
    const values = contract.areas.map(a => a[field]).filter(v => v !== null);
    if (!unique(values)) f.push(issue('SHARED_AREA_' + field, '/areas'));
  }
  for (const field of ['projectId', 'endpointIds']) {
    const values = contract.projects.filter(p => p[field] !== null).flatMap(p => field === 'projectId' ? [p.provider + '/' + p[field]] : p[field]);
    if (!unique(values)) f.push(issue('SHARED_PROJECT_' + field, '/projects'));
  }
  for (const p of contract.projects) {
    const area = contract.areas.find(a => a.role === p.role);
    if (p.region && area?.region && p.region !== area.region) f.push(issue('REGION_MISMATCH', '/projects/' + key(p)));
  }
  return f;
}

export function readinessFindings(contract) {
  const f = contractFindings(contract);
  if (f.length) return f;
  for (const [name, value] of Object.entries(contract.mapping))
    if (value === null) f.push(issue('MAPPING_MISSING', '/mapping/' + name, 'blocked'));
  for (const a of contract.areas) for (const [name, value] of Object.entries(a))
    if (value === null) f.push(issue('AREA_UNCONFIGURED', '/areas/' + a.role + '/' + name, 'blocked'));
  for (const p of contract.projects) for (const [name, value] of Object.entries(p))
    if (value === null) f.push(issue('PROJECT_UNCONFIGURED', '/projects/' + key(p) + '/' + name, 'blocked'));
  return f;
}

const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && same(Object.keys(value), names);
const strings = value => Array.isArray(value) && value.every(x => typeof x === 'string' && x.length > 0) && unique(value);
const validArea = a => fields(a, ['role', 'vpcId', 'region', 'sourceSecurityGroup', 'workloadIdentity', 'credentialRef'])
  && Object.values(a).every(v => typeof v === 'string' && v.length > 0);
const validProject = p => fields(p, ['provider', 'role', 'projectId', 'orgId', 'region', 'endpointIds', 'publicBlocked', 'publicServicesBlocked', 'status', 'autoResume', 'allowedVpcEndpointIds'])
  && ['provider', 'role', 'projectId', 'orgId', 'region', 'status'].every(k => typeof p[k] === 'string' && p[k].length > 0)
  && ['publicBlocked', 'publicServicesBlocked', 'autoResume'].every(k => typeof p[k] === 'boolean')
  && strings(p.allowedVpcEndpointIds) && strings(p.endpointIds);
const validEndpoint = e => fields(e, ['endpointId', 'vpcId', 'region', 'allowedSourceSecurityGroups', 'allowedPorts', 'publicCidrs', 'projectIds'])
  && ['endpointId', 'vpcId', 'region'].every(k => typeof e[k] === 'string' && e[k].length > 0)
  && ['allowedSourceSecurityGroups', 'publicCidrs', 'projectIds'].every(k => strings(e[k]))
  && Array.isArray(e.allowedPorts) && e.allowedPorts.every(x => Number.isInteger(x) && x > 0 && x < 65536) && unique(e.allowedPorts);
const fresh = (date, now, maxAgeMs) => {
  const time = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(date) ? Date.parse(date) : NaN;
  return Number.isFinite(time) && Number.isFinite(now) && time <= now + 30_000 && now - time <= maxAgeMs;
};

export function auditSnapshot(contract, snapshot, { now = Date.now(), maxAgeMs = 300_000 } = {}) {
  const f = readinessFindings(contract);
  if (f.length) return f;
  if (!fields(snapshot, ['schemaVersion', 'githubOrg', 'contractDigest', 'observedAt', 'collectionComplete', 'errors', 'areas', 'projects', 'endpoints', 'crossAreaRoutes'])
    || snapshot.schemaVersion !== 1 || typeof snapshot.githubOrg !== 'string' || typeof snapshot.contractDigest !== 'string'
    || typeof snapshot.collectionComplete !== 'boolean' || !strings(snapshot.errors)
    || !Array.isArray(snapshot.areas) || !snapshot.areas.every(validArea)
    || !Array.isArray(snapshot.projects) || !snapshot.projects.every(validProject)
    || !Array.isArray(snapshot.endpoints) || !snapshot.endpoints.every(validEndpoint)
    || !strings(snapshot.crossAreaRoutes))
    return [issue('SNAPSHOT_SCHEMA', '/')];
  if (snapshot.githubOrg.toLowerCase() !== contract.githubOrg.toLowerCase()) f.push(issue('WRONG_ORG', '/githubOrg'));
  if (snapshot.contractDigest !== digest(contract)) f.push(issue('WRONG_CONTRACT', '/contractDigest'));
  if (!fresh(snapshot.observedAt, now, maxAgeMs)) f.push(issue('STALE_EVIDENCE', '/observedAt'));
  if (!snapshot.collectionComplete || snapshot.errors.length) f.push(issue('INCOMPLETE_COLLECTION', '/collectionComplete', 'blocked'));
  if (snapshot.crossAreaRoutes.length) f.push(issue('CROSS_AREA_ROUTE', '/crossAreaRoutes'));
  if (digest([...snapshot.areas].sort((a,b) => a.role.localeCompare(b.role))) !== digest([...contract.areas].sort((a,b) => a.role.localeCompare(b.role))))
    f.push(issue('AREA_DRIFT', '/areas'));
  if (!same(snapshot.projects.map(key), contract.projects.map(key))) f.push(issue('PROJECT_SET_DRIFT', '/projects'));
  if (!same(snapshot.endpoints.map(e => e.endpointId), contract.projects.flatMap(p => p.endpointIds))) f.push(issue('ENDPOINT_SET_DRIFT', '/endpoints'));
  for (const expected of contract.projects) {
    const path = '/projects/' + key(expected);
    const p = snapshot.projects.find(p => key(p) === key(expected));
    if (!p) continue;
    const area = contract.areas.find(a => a.role === p.role);
    for (const field of ['projectId', 'region'])
      if (p[field] !== expected[field]) f.push(issue('PROJECT_DRIFT', path + '/' + field));
    if (!same(p.endpointIds, expected.endpointIds)) f.push(issue('PROJECT_DRIFT', path + '/endpointIds'));
    if (p.orgId !== contract.mapping[p.provider + 'Org']) f.push(issue('PROJECT_ORG_DRIFT', path + '/orgId'));
    if (!p.publicBlocked || !p.publicServicesBlocked) f.push(issue('PUBLIC_ACCESS', path));
    if (!same(p.allowedVpcEndpointIds, expected.endpointIds)) f.push(issue('VPC_RESTRICTION', path));
    if (p.status !== contract.expectedState || (contract.expectedState === 'paused' && p.autoResume)) f.push(issue('PAUSE_STATE_DRIFT', path));
    for (const endpointId of expected.endpointIds) {
    const endpoint = snapshot.endpoints.find(e => e.endpointId === endpointId);
    if (!endpoint) continue;
    if (endpoint.vpcId !== area.vpcId || endpoint.region !== area.region) f.push(issue('ENDPOINT_AREA_DRIFT', path));
    if (!same(endpoint.projectIds, [p.projectId])) f.push(issue('ENDPOINT_PROJECT_DRIFT', path));
    if (!same(endpoint.allowedSourceSecurityGroups, [area.sourceSecurityGroup])) f.push(issue('ENDPOINT_SOURCE_DRIFT', path));
    if (endpoint.publicCidrs.length || !endpoint.allowedPorts.length || endpoint.allowedPorts.some(port => ![5432, 6543].includes(port)))
      f.push(issue('ENDPOINT_EXPOSURE', path));
    }
  }
  return f;
}

export function auditProbes(contract, snapshot, batches, options = {}) {
  const f = auditSnapshot(contract, snapshot, options);
  if (f.length) return f;
  if (contract.expectedState !== 'active') return [issue('LIVE_REQUIRES_AUTHORIZED_RESUME', '/expectedState', 'blocked')];
  if (!Array.isArray(batches) || batches.length !== sources.length) return [issue('INCOMPLETE_PROBE_MATRIX', '/', 'blocked')];
  const now = options.now ?? Date.now(), maxAgeMs = options.maxAgeMs ?? 300_000;
  const seen = [], runs = [];
  for (const batch of batches) {
    if (!fields(batch, ['schemaVersion', 'githubOrg', 'contractDigest', 'runId', 'source', 'sourceVpcId', 'observedAt', 'baselineReachable', 'results'])
      || batch.schemaVersion !== 1 || !sources.includes(batch.source)
      || typeof batch.githubOrg !== 'string' || typeof batch.contractDigest !== 'string' || typeof batch.runId !== 'string' || !batch.runId
      || typeof batch.sourceVpcId !== 'string' || !batch.sourceVpcId || typeof batch.baselineReachable !== 'boolean'
      || !Array.isArray(batch.results) || !batch.results.every(r => fields(r, ['provider', 'role', 'outcome']) && typeof r.provider === 'string' && typeof r.role === 'string' && ['allowed', 'denied', 'inconclusive'].includes(r.outcome))) {
      f.push(issue('PROBE_SCHEMA', '/')); continue;
    }
    seen.push(batch.source); runs.push(batch.runId);
    if (batch.githubOrg.toLowerCase() !== contract.githubOrg.toLowerCase() || batch.contractDigest !== digest(contract)) f.push(issue('PROBE_WRONG_CONTRACT', '/' + batch.source));
    if (!fresh(batch.observedAt, now, maxAgeMs)) f.push(issue('STALE_PROBE', '/' + batch.source));
    if (!batch.baselineReachable) f.push(issue('PROBE_BASELINE_FAILED', '/' + batch.source, 'blocked'));
    const area = contract.areas.find(a => a.role === batch.source);
    if (area ? area.vpcId !== batch.sourceVpcId : contract.areas.some(a => a.vpcId === batch.sourceVpcId))
      f.push(issue('PROBE_WRONG_SOURCE', '/' + batch.source));
    if (!same(batch.results.map(key), contract.projects.map(key))) f.push(issue('INCOMPLETE_PROBE_MATRIX', '/' + batch.source, 'blocked'));
    for (const row of batch.results) {
      const expected = row.role === batch.source ? 'allowed' : 'denied';
      if (row.outcome !== expected) f.push(issue(row.outcome === 'inconclusive' ? 'PROBE_INCONCLUSIVE' : 'NETWORK_ISOLATION_FAILED', '/' + batch.source + '/' + key(row), row.outcome === 'inconclusive' ? 'blocked' : 'fail'));
    }
  }
  if (!same(seen, sources)) f.push(issue('INCOMPLETE_PROBE_MATRIX', '/', 'blocked'));
  if (!runs.length || new Set(runs).size !== 1) f.push(issue('PROBE_RUN_MISMATCH', '/'));
  return f;
}

export const verdict = findings => findings.some(f => f.severity === 'fail') ? 'fail' : findings.length ? 'blocked' : 'pass';
