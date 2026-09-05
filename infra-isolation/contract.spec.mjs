import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contractFindings, readinessFindings } from './policy.mjs';
const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url)));
test('organization contract follows the schema and three-area invariants', () => assert.deepEqual(contractFindings(contract), []));
test('checked-in organization matches the GitHub repository owner', () => {
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository) assert.equal(contract.githubOrg.toLowerCase(), repository.split('/')[0].toLowerCase());
  else assert.ok(contract.githubOrg);
});
test('offline test result explicitly reports provisioned-infrastructure gaps', t => {
  const findings = readinessFindings(contract);
  t.diagnostic('OFFLINE CONTRACT TESTS ONLY: ' + findings.length + ' provisioning gaps; live isolation has not been accepted.');
});
