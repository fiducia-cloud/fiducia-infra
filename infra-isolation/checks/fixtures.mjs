import { roles, providers, sources, digest } from '../policy.mjs';
export const now = Date.parse('2026-09-04T12:00:00Z');
export function fixture(state = 'paused') {
  const contract = {
    schemaVersion: 1, githubOrg: 'example-org', expectedState: state,
    mapping: { neonOrg: 'neon-org-example', supabaseOrg: 'supa-org-example', cloudflareDomain: 'example.test', slackChannel: 'CEXAMPLE', gcpProject: 'example-gcp', linearProject: 'example-linear' },
    areas: roles.map(role => ({role, vpcId: 'vpc-' + role, region: 'us-east-1', sourceSecurityGroup: 'sg-' + role, workloadIdentity: 'identity-' + role, credentialRef: 'secret-ref-' + role})),
    projects: providers.flatMap(provider => roles.map(role => ({provider, role, projectId: provider + '-' + role, region: 'us-east-1', endpointIds: ['vpce-' + provider + '-' + role]})))
  };
  const snapshot = {
    schemaVersion: 1, githubOrg: contract.githubOrg, contractDigest: digest(contract), observedAt: new Date(now).toISOString(),
    collectionComplete: true, errors: [], areas: structuredClone(contract.areas), crossAreaRoutes: [],
    projects: contract.projects.map(p => ({...structuredClone(p), orgId: contract.mapping[p.provider + 'Org'], publicBlocked: true, publicServicesBlocked: true, status: state, autoResume: false, allowedVpcEndpointIds: [...p.endpointIds]})),
    endpoints: contract.projects.flatMap(p => p.endpointIds.map(endpointId => ({endpointId, vpcId: 'vpc-' + p.role, region: p.region, allowedSourceSecurityGroups: ['sg-' + p.role], allowedPorts: [5432], publicCidrs: [], projectIds: [p.projectId]})))
  };
  const batches = sources.map(source => ({
    schemaVersion: 1, githubOrg: contract.githubOrg, contractDigest: digest(contract), runId: 'synthetic-run',
    source, sourceVpcId: 'vpc-' + source, observedAt: new Date(now).toISOString(), baselineReachable: true,
    results: contract.projects.map(p => ({provider: p.provider, role: p.role, outcome: source === p.role ? 'allowed' : 'denied'}))
  }));
  return {contract, snapshot, batches};
}
