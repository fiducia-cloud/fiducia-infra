import { readFileSync, statSync } from 'node:fs';
import { auditSnapshot, auditProbes, readinessFindings, verdict } from './policy.mjs';
const read = path => {
  if (!path || statSync(path).size > 1_048_576) throw new Error('INPUT_UNAVAILABLE');
  return JSON.parse(readFileSync(path, 'utf8'));
};
try {
  const contract = read(new URL('./contract.json', import.meta.url));
  let findings = readinessFindings(contract);
  const mode = process.env.INFRA_ACCEPTANCE_MODE || 'configuration';
  if (!['configuration', 'network'].includes(mode)) throw new Error('INVALID_MODE');
  if (!findings.length) {
    const snapshot = read(process.env.INFRA_SNAPSHOT_FILE);
    findings = mode === 'network'
      ? auditProbes(contract, snapshot, read(process.env.INFRA_PROBES_FILE))
      : auditSnapshot(contract, snapshot);
  }
  const status = verdict(findings);
  console.log(JSON.stringify({scope: mode, status, findings}, null, 2));
  process.exitCode = status === 'pass' ? 0 : status === 'blocked' ? 2 : 1;
} catch {
  console.log(JSON.stringify({status: 'blocked', findings: [{code: 'EVIDENCE_INPUT_UNAVAILABLE', path: '/'}]}));
  process.exitCode = 2;
}
