import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { domainDigest } from '../../src/fabric/identity.ts';
import { advancePureVirtualDeploymentHeadV1, createPureVirtualDeploymentWitnessV1,
  PureVirtualDeploymentJournalStoreV1, type PureVirtualDeploymentHeadV1,
  pureVirtualInvocationDigestV2, type PureVirtualDeploymentJournalV1,
  type PureVirtualDeploymentJournalV2,
  type PureVirtualDeploymentJournalV3 } from '../../src/tier4/process-virtual-deployment-journal.ts';

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

test('pure virtual /3 witness pins source plan and operator authority across revisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-virtual-config-journal-'));
  let head: PureVirtualDeploymentHeadV1 = { revision: '0', journal: null };
  const witness = createPureVirtualDeploymentWitnessV1({ authorityId: 'operator',
    repositoryId: 'virtual-repo', deploymentId: 'pure-config', read: () => head,
    advance: (expected, journal) => {
      if (head.revision !== expected) throw new Error('witness CAS conflict');
      head = { revision: String(BigInt(expected) + 1n), journal }; return head;
    } });
  const digest = (domain: string, value: string) => domainDigest(domain, value);
  const manifest = digest('aether.execution/1', 'source');
  const state: PureVirtualDeploymentJournalV3 = {
    format: 'aether.process-virtual-deployment/3', witnessRevision: '1',
    witnessDigest: witness.digest, repositoryId: witness.repositoryId,
    deploymentId: witness.deploymentId, admissionProfile: 'strict-lineage-v1',
    genesisManifest: manifest,
    active: { manifest, generation: '0', artifactDigest: null },
    readiness: 'ready', pendingProposal: null, preparedDigest: null,
    trustDigest: digest('aether.process-virtual-worker-trust/1', 'operator-trust'),
    hostWitnessCatalogDigest: digest('aether.process-host-journal-witness-catalog/1', 'catalog'),
    sourcePlanDigest: digest('aether.process-virtual-source-plan/1', 'source-plan'),
    candidatePlanDigest: digest('aether.process-virtual-plan/1', 'candidate-plan'),
    sourceInitialSnapshotDigest: null,
    sealerIdentityDigest: digest('aether.process-virtual-sealer-identity/1', 'key'),
    recoveryAuthorityDigest: digest('aether.process-virtual-recovery-authority/1', 'operator'),
    invocations: [],
  };
  try {
    const store = new PureVirtualDeploymentJournalStoreV1(directory, witness);
    store.write('0', state);
    assert.equal(store.read()?.format, 'aether.process-virtual-deployment/3');
    assert.throws(() => store.write('1', { ...state, witnessRevision: '2',
      sourcePlanDigest: digest('aether.process-virtual-source-plan/1', 'swapped') }),
    /genesis\/authority changed/);
    assert.throws(() => store.write('1', { ...state, witnessRevision: '2',
      recoveryAuthorityDigest: digest('aether.process-virtual-recovery-authority/1', 'swapped') }),
    /genesis\/authority changed/);
    assert.equal(head.revision, '1');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('pure virtual /2 journal refuses duplicate and forged same-ID receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-virtual-operation-journal-'));
  let head: PureVirtualDeploymentHeadV1 = { revision: '0', journal: null };
  const witness = createPureVirtualDeploymentWitnessV1({ authorityId: 'operator',
    repositoryId: 'virtual-repo', deploymentId: 'pure-operations', read: () => head,
    advance: (expected, journal) => {
      if (head.revision !== expected) throw new Error('witness CAS conflict');
      head = { revision: String(BigInt(expected) + 1n), journal }; return head;
    } });
  const digest = (domain: string, value: string) => domainDigest(domain, value);
  const manifest = digest('aether.execution/1', 'source');
  const args = [{ tag: 'int' as const, value: '3' }];
  const row = { operationId: 'same-id', manifest, generation: '0', symbol: 'entry', args,
    requestDigest: pureVirtualInvocationDigestV2({ manifest, generation: '0',
      symbol: 'entry', args }), phase: 'settled' as const,
    result: { state: 'completed' as const, operationId: 'same-id', generation: '0',
      unit: 'pure', execution: { ok: true as const, value: { tag: 'int' as const,
        value: '4' }, steps: 0 } } };
  const state: PureVirtualDeploymentJournalV2 = {
    format: 'aether.process-virtual-deployment/2', witnessRevision: '1',
    witnessDigest: witness.digest, repositoryId: witness.repositoryId,
    deploymentId: witness.deploymentId, admissionProfile: 'strict-lineage-v1',
    genesisManifest: manifest,
    active: { manifest, generation: '0', artifactDigest: null },
    readiness: 'ready', pendingProposal: null, preparedDigest: null,
    trustDigest: digest('aether.process-virtual-worker-trust/1', 'operator-trust'),
    hostWitnessCatalogDigest: digest('aether.process-host-journal-witness-catalog/1', 'catalog'),
    invocations: [row],
  };
  try {
    const store = new PureVirtualDeploymentJournalStoreV1(directory, witness);
    store.write('0', state);
    assert.equal(store.read()?.format, 'aether.process-virtual-deployment/2');
    assert.throws(() => store.write('1', { ...state, witnessRevision: '2',
      invocations: [row, row] }), /duplicate|invalid virtual invocation inventory/);
    assert.throws(() => store.write('1', { ...state, witnessRevision: '2',
      invocations: [{ ...row, result: { ...row.result, generation: '1' } }] }),
    /virtual invocation result identity mismatch/);
    assert.equal(head.revision, '1');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
