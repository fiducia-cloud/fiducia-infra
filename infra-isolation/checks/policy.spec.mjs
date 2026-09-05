import test from 'node:test';
import assert from 'node:assert/strict';
import { contractFindings, readinessFindings, auditSnapshot, auditProbes, digest, verdict } from '../policy.mjs';
import { fixture, now } from './fixtures.mjs';

test('complete paused provider evidence passes the configuration audit', () => {
  const {contract, snapshot} = fixture();
  assert.deepEqual(auditSnapshot(contract, snapshot, {now}), []);
});
test('complete active 30-cell matrix passes network acceptance', () => {
  const {contract, snapshot, batches} = fixture('active');
  assert.equal(batches.flatMap(b => b.results).length, 30);
  assert.deepEqual(auditProbes(contract, snapshot, batches, {now}), []);
});
test('all regional Neon endpoint services can belong to the same isolated project', () => {
  const {contract, snapshot} = fixture();
  const endpointId = 'vpce-neon-canonical-second-service';
  contract.projects[0].endpointIds.push(endpointId);
  snapshot.projects[0].endpointIds.push(endpointId);
  snapshot.projects[0].allowedVpcEndpointIds.push(endpointId);
  snapshot.endpoints.push({...structuredClone(snapshot.endpoints[0]), endpointId});
  snapshot.contractDigest = digest(contract);
  assert.deepEqual(auditSnapshot(contract, snapshot, {now}), []);
  snapshot.endpoints.pop();
  assert.ok(auditSnapshot(contract, snapshot, {now}).some(f => f.code === 'ENDPOINT_SET_DRIFT'));
});
test('paused projects can never produce a passing live acceptance', () => {
  const {contract, snapshot, batches} = fixture();
  assert.equal(verdict(auditProbes(contract, snapshot, batches, {now})), 'blocked');
});
test('unprovisioned contract is valid but readiness is blocked', () => {
  const {contract} = fixture();
  contract.areas[0].vpcId = null;
  contract.projects[0].projectId = null;
  contract.mapping.cloudflareDomain = null;
  assert.deepEqual(contractFindings(contract), []);
  assert.equal(verdict(readinessFindings(contract)), 'blocked');
});
test('contract hash is independent of object key ordering', () => {
  assert.equal(digest({a: 1, b: {c: 2, d: 3}}), digest({b: {d: 3, c: 2}, a: 1}));
});
const contractCases = [
  ['unknown credential field', c => { c.password = 'synthetic-only'; }, 'SCHEMA'],
  ['missing required role', c => { c.areas.pop(); }, 'SCHEMA'],
  ['duplicate area role', c => { c.areas[1].role = c.areas[0].role; }, 'AREA_ROLES'],
  ['duplicate project role', c => { c.projects[1].role = c.projects[0].role; }, 'PROJECT_ROLES'],
  ...['vpcId', 'sourceSecurityGroup', 'workloadIdentity', 'credentialRef'].map(field => [
    'shared ' + field, c => { c.areas[1][field] = c.areas[0][field]; }, 'SHARED_AREA_' + field
  ]),
  ...['projectId', 'endpointIds'].map(field => ['shared ' + field, c => { c.projects[1][field] = c.projects[0][field]; }, 'SHARED_PROJECT_' + field]),
  ['incompatible AWS regions', c => { c.projects[0].region = 'us-east-2'; }, 'REGION_MISMATCH']
];
for (const [name, mutate, code] of contractCases) test('rejects ' + name, () => {
  const {contract} = fixture(); mutate(contract);
  assert.ok(contractFindings(contract).some(f => f.code === code));
});
const snapshotCases = [
  ['absent snapshot', () => null, 'SNAPSHOT_SCHEMA'],
  ['unknown snapshot field', s => { s.rawToken = 'synthetic-only'; }, 'SNAPSHOT_SCHEMA'],
  ['wrong snapshot organization', s => { s.githubOrg = 'foreign-org'; }, 'WRONG_ORG'],
  ['replayed contract', s => { s.contractDigest = 'wrong'; }, 'WRONG_CONTRACT'],
  ['old evidence', s => { s.observedAt = '2026-09-03T12:00:00Z'; }, 'STALE_EVIDENCE'],
  ['future evidence', s => { s.observedAt = '2026-09-05T12:00:00Z'; }, 'STALE_EVIDENCE'],
  ['invalid timestamp', s => { s.observedAt = 'yesterday'; }, 'STALE_EVIDENCE'],
  ['partial API pagination', s => { s.collectionComplete = false; }, 'INCOMPLETE_COLLECTION'],
  ['provider error', s => { s.errors = ['provider-unavailable']; }, 'INCOMPLETE_COLLECTION'],
  ['cross-role peering', s => { s.crossAreaRoutes = ['canonical-to-admin']; }, 'CROSS_AREA_ROUTE'],
  ['workload identity drift', s => { s.areas[0].workloadIdentity = s.areas[1].workloadIdentity; }, 'AREA_DRIFT'],
  ['missing admin database', s => { s.projects.pop(); }, 'PROJECT_SET_DRIFT'],
  ['duplicate database', s => { s.projects.push(structuredClone(s.projects[0])); }, 'PROJECT_SET_DRIFT'],
  ['extra endpoint', s => { s.endpoints.push(structuredClone(s.endpoints[0])); }, 'ENDPOINT_SET_DRIFT'],
  ['foreign provider project', s => { s.projects[0].projectId = 'foreign'; }, 'PROJECT_DRIFT'],
  ['foreign provider org', s => { s.projects[0].orgId = 'foreign'; }, 'PROJECT_ORG_DRIFT'],
  ['public Postgres access', s => { s.projects[0].publicBlocked = false; }, 'PUBLIC_ACCESS'],
  ['Supabase APIs still public', s => { s.projects[3].publicServicesBlocked = false; }, 'PUBLIC_ACCESS'],
  ['another VPC allowlisted', s => { s.projects[0].allowedVpcEndpointIds.push('vpce-foreign'); }, 'VPC_RESTRICTION'],
  ['running project in paused fleet', s => { s.projects[0].status = 'active'; }, 'PAUSE_STATE_DRIFT'],
  ['Neon can auto resume', s => { s.projects[0].autoResume = true; }, 'PAUSE_STATE_DRIFT'],
  ['endpoint in other VPC', s => { s.endpoints[0].vpcId = 'vpc-admin'; }, 'ENDPOINT_AREA_DRIFT'],
  ['endpoint in other region', s => { s.endpoints[0].region = 'us-east-2'; }, 'ENDPOINT_AREA_DRIFT'],
  ['endpoint serves other database', s => { s.endpoints[0].projectIds.push('other-db'); }, 'ENDPOINT_PROJECT_DRIFT'],
  ['cross-role security group', s => { s.endpoints[0].allowedSourceSecurityGroups.push('sg-admin'); }, 'ENDPOINT_SOURCE_DRIFT'],
  ['public IPv4 rule', s => { s.endpoints[0].publicCidrs = ['0.0.0.0/0']; }, 'ENDPOINT_EXPOSURE'],
  ['public IPv6 rule', s => { s.endpoints[0].publicCidrs = ['::/0']; }, 'ENDPOINT_EXPOSURE'],
  ['unexpected open port', s => { s.endpoints[0].allowedPorts.push(22); }, 'ENDPOINT_EXPOSURE'],
  ['no allowed database port', s => { s.endpoints[0].allowedPorts = []; }, 'ENDPOINT_EXPOSURE']
];
for (const [name, mutate, code] of snapshotCases) test('rejects ' + name, () => {
  const {contract, snapshot} = fixture();
  const replacement = mutate(snapshot);
  assert.ok(auditSnapshot(contract, replacement === null ? null : snapshot, {now}).some(f => f.code === code));
});
const probeCases = [
  ['missing source runner', b => { b.pop(); }, 'INCOMPLETE_PROBE_MATRIX'],
  ['duplicate source runner', b => { b[4] = structuredClone(b[0]); }, 'INCOMPLETE_PROBE_MATRIX'],
  ['missing probe cell', b => { b[0].results.pop(); }, 'INCOMPLETE_PROBE_MATRIX'],
  ['duplicate probe cell', b => { b[0].results.push(structuredClone(b[0].results[0])); }, 'INCOMPLETE_PROBE_MATRIX'],
  ['all probes denied by offline database', b => { b.forEach(x => x.results.forEach(r => { r.outcome = 'denied'; })); }, 'NETWORK_ISOLATION_FAILED'],
  ['cross-role access', b => { b[0].results[1].outcome = 'allowed'; }, 'NETWORK_ISOLATION_FAILED'],
  ['public access', b => { b[3].results[0].outcome = 'allowed'; }, 'NETWORK_ISOLATION_FAILED'],
  ['foreign org access', b => { b[4].results[0].outcome = 'allowed'; }, 'NETWORK_ISOLATION_FAILED'],
  ['DNS or authentication uncertainty', b => { b[0].results[0].outcome = 'inconclusive'; }, 'PROBE_INCONCLUSIVE'],
  ['source baseline offline', b => { b[0].baselineReachable = false; }, 'PROBE_BASELINE_FAILED'],
  ['wrong role runner', b => { b[0].sourceVpcId = 'vpc-auth'; }, 'PROBE_WRONG_SOURCE'],
  ['foreign runner inside admin VPC', b => { b[4].sourceVpcId = 'vpc-admin'; }, 'PROBE_WRONG_SOURCE'],
  ['mixed capture runs', b => { b[0].runId = 'another-run'; }, 'PROBE_RUN_MISMATCH'],
  ['old probe capture', b => { b[0].observedAt = '2026-09-03T12:00:00Z'; }, 'STALE_PROBE'],
  ['probe against wrong configuration', b => { b[0].contractDigest = 'wrong'; }, 'PROBE_WRONG_CONTRACT'],
  ['malformed probe', b => { b[0].results[0].outcome = 'skipped'; }, 'PROBE_SCHEMA']
];
for (const [name, mutate, code] of probeCases) test('rejects ' + name, () => {
  const {contract, snapshot, batches} = fixture('active'); mutate(batches);
  assert.ok(auditProbes(contract, snapshot, batches, {now}).some(f => f.code === code));
});
test('findings contain no raw provider errors or credential values', () => {
  const {contract, snapshot} = fixture();
  snapshot.errors = ['synthetic-secret'];
  assert.ok(!JSON.stringify(auditSnapshot(contract, snapshot, {now})).includes('synthetic-secret'));
});
