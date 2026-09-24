import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { domainDigest } from '../../src/fabric/identity.ts';
import { advancePureVirtualDeploymentHeadV1, createPureVirtualDeploymentWitnessV1,
  PureVirtualDeploymentJournalStoreV1, type PureVirtualDeploymentHeadV1,
  type PureVirtualDeploymentJournalV1 } from '../../src/tier4/process-virtual-deployment-journal.ts';

test('versioned pure virtual witness repairs a mirror after CAS/crash and refuses rollback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-virtual-deployment-journal-'));
  let head: PureVirtualDeploymentHeadV1 = { revision: '0', journal: null };
  const witness = createPureVirtualDeploymentWitnessV1({ authorityId: 'operator',
    repositoryId: 'virtual-repo', deploymentId: 'pure-deployment', read: () => head,
    advance: (expected, journal) => {
      if (head.revision !== expected) throw new Error('witness CAS conflict');
      head = { revision: String(BigInt(expected) + 1n), journal }; return head;
    } });
  const digest = (domain: string, value: string) => domainDigest(domain, value);
  const genesis = digest('aether.execution/1', 'source');
  const candidate = digest('aether.execution/1', 'candidate');
  const artifact = digest('aether.process-artifact/4', 'candidate-artifact');
  const base: PureVirtualDeploymentJournalV1 = {
    format: 'aether.process-virtual-deployment/1', witnessRevision: '1',
    witnessDigest: witness.digest, repositoryId: witness.repositoryId,
    deploymentId: witness.deploymentId, admissionProfile: 'strict-lineage-v1',
    genesisManifest: genesis,
    active: { manifest: genesis, generation: '0', artifactDigest: null },
    readiness: 'ready', pendingProposal: null, preparedDigest: null,
    trustDigest: digest('aether.process-virtual-worker-trust/1', 'operator-trust'),
    hostWitnessCatalogDigest: digest('aether.process-host-journal-witness-catalog/1', 'catalog'),
  };
  try {
    const store = new PureVirtualDeploymentJournalStoreV1(directory, witness);
    assert.equal(store.read(), null);
    store.write('0', base);
    assert.equal(store.read()?.active.manifest, genesis);
    const next: PureVirtualDeploymentJournalV1 = { ...base, witnessRevision: '2',
      active: { manifest: candidate, generation: '1', artifactDigest: artifact } };
    // Controller death after the external CAS but before the local mirror write.
    advancePureVirtualDeploymentHeadV1(witness, '1', next);
    const reopened = new PureVirtualDeploymentJournalStoreV1(directory, witness);
    assert.equal(reopened.read()?.active.manifest, candidate);
    assert.equal(readFileSync(join(directory, 'virtual-deployment.json'), 'utf8'), head.journal);
    assert.throws(() => reopened.write('1', { ...next, witnessRevision: '2' }),
      /stale pure virtual witness revision/);
    assert.throws(() => reopened.write('2', { ...next, witnessRevision: '3',
      active: { ...next.active, artifactDigest: digest('aether.process-artifact/1', 'legacy') } }),
    /invalid digest|digest domain/i);
    head = { revision: '1', journal: JSON.stringify(base) };
    assert.throws(() => reopened.read(), /rolled back|noncanonical/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
