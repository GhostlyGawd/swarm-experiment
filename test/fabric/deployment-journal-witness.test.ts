import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { advanceDeploymentJournalHead, assertDeploymentJournalWitness,
  createDeploymentJournalWitness, readDeploymentJournalHead,
  type DeploymentJournalHead, type DeploymentJournalWitness } from '../../src/fabric/deployment-journal-witness.ts';

const digest = (domain: string) => domainDigest(domain, { fixture: true });
function journal(witness: DeploymentJournalWitness, revision: string, generation = '0'): string {
  return Buffer.from(encodeCanonical({
    format: 'aether.process-deployment/9', witnessRevision: revision,
    deploymentJournalWitnessDigest: witness.digest,
    admissionProfile: 'strict-lineage-v1', capabilityProfile: 'scoped-anchored-wasm-v9',
    effectSignerAnchorDigest: digest('aether.effect-signer-anchor/1'),
    trustedClockAnchorDigest: digest('aether.trusted-clock-anchor/1'),
    effectJournalWitnessCatalogDigest: digest('aether.effect-journal-witness-catalog/1'),
    hostJournalWitnessCatalogDigest: digest('aether.process-host-journal-witness-catalog/1'),
    genesisManifest: digest('aether.execution/1'),
    active: { id: 'genesis', manifest: digest('aether.execution/1'),
      artifactDigest: digest('aether.process-artifact/1'), generation },
    readiness: 'ready', pendingProposal: null, invocations: [], allocations: [],
  })).toString('utf8');
}
function sinkJournal(witness: DeploymentJournalWitness, revision: string,
  overrides: Record<string, unknown> = {}): string {
  const historical = JSON.parse(journal(witness, revision)) as Record<string, unknown>;
  return Buffer.from(encodeCanonical({ ...historical,
    format: 'aether.process-deployment/10', capabilityProfile: 'scoped-anchored-sink-v10',
    sinkAnchorDigest: digest('aether.sink-anchor/1'),
    sinkDeploymentId: witness.deploymentId,
    approvedAdapterArtifactDigest: digest('aether.effect-adapter-artifact/2'),
    sinkStateWitnessDigest: digest('aether.sink-state-witness/1'),
    ...overrides,
  })).toString('utf8');
}
function resourceSinkJournal(witness: DeploymentJournalWitness, revision: string,
  overrides: Record<string, unknown> = {}): string {
  const v10 = JSON.parse(sinkJournal(witness, revision)) as Record<string, unknown>;
  return Buffer.from(encodeCanonical({ ...v10,
    format: 'aether.process-deployment/11', capabilityProfile: 'scoped-anchored-sink-v11',
    ...overrides,
  })).toString('utf8');
}
function fixture() {
  let head: DeploymentJournalHead = { revision: '0', journal: null };
  let advances = 0;
  const witness = createDeploymentJournalWitness({
    authorityId: 'operator:deployment', repositoryId: 'repo:test', deploymentId: 'deployment:one',
    read: () => head,
    advance(expected, bytes) {
      advances++;
      if (head.revision !== expected) throw new Error('provider CAS lost');
      head = { revision: String(BigInt(expected) + 1n), journal: bytes };
      return head;
    },
  });
  return { witness, head: () => head, setHead: (next: DeploymentJournalHead) => { head = next; }, advances: () => advances };
}

test('deployment witness pins operator and namespace with exact durable CAS bytes', () => {
  const f = fixture();
  const first = journal(f.witness, '1');
  const second = journal(f.witness, '2', '1');
  assert.deepEqual(readDeploymentJournalHead(f.witness), { revision: '0', journal: null });
  assert.deepEqual(advanceDeploymentJournalHead(f.witness, '0', first), { revision: '1', journal: first });
  assert.deepEqual(advanceDeploymentJournalHead(f.witness, '1', second), { revision: '2', journal: second });
  assert.equal(f.advances(), 2);
  assert.equal(f.witness.digest, domainDigest('aether.process-deployment-journal-witness/1', {
    format: 'aether.process-deployment-journal-witness/1', authorityId: 'operator:deployment',
    repositoryId: 'repo:test', deploymentId: 'deployment:one' }));
  assert.ok(Object.isFrozen(f.witness));
  assert.throws(() => assertDeploymentJournalWitness({ ...f.witness }), /independently supplied/);
  assert.throws(() => createDeploymentJournalWitness({ authorityId: '', repositoryId: 'repo:test', deploymentId: 'deployment:one',
    read: () => f.head(), advance: () => f.head() }), /identifier/);
});

test('deployment witness rejects stale writers, rollback and same-revision equivocation', () => {
  const f = fixture();
  const first = journal(f.witness, '1');
  advanceDeploymentJournalHead(f.witness, '0', first);
  assert.throws(() => advanceDeploymentJournalHead(f.witness, '0', first), /stale/);
  assert.equal(f.advances(), 1);
  f.setHead({ revision: '1', journal: journal(f.witness, '1', '1') });
  assert.throws(() => readDeploymentJournalHead(f.witness), /equivocated/);
  f.setHead({ revision: '0', journal: null });
  assert.throws(() => readDeploymentJournalHead(f.witness), /rolled back/);
});

test('deployment witness rejects incomplete, wrong-revision, wrong-identity and noncanonical journals before CAS', () => {
  const f = fixture();
  const valid = journal(f.witness, '1');
  const other = createDeploymentJournalWitness({ authorityId: 'operator:deployment', repositoryId: 'repo:test', deploymentId: 'deployment:other',
    read: () => ({ revision: '0', journal: null }), advance: () => { throw new Error('unused'); } });
  for (const bytes of [
    `{}`, ` ${valid}`, `${valid} `, valid.replace('"format"', '"format" '),
    valid.replace('{', '{"format":"aether.process-deployment/9",'),
    valid.replace('aether.process-deployment/9', 'aether.process-deployment/8'),
    valid.replace('"witnessRevision":"1"', '"witnessRevision":"0"'),
    valid.replace(f.witness.digest, other.digest),
    valid.replace('"allocations":[]', ''),
    'x'.repeat(16 * 1024 * 1024 + 1),
  ]) assert.throws(() => advanceDeploymentJournalHead(f.witness, '0', bytes));
  assert.equal(f.advances(), 0);
  f.setHead({ revision: '1', journal: valid.replace(f.witness.digest, other.digest) });
  assert.throws(() => readDeploymentJournalHead(f.witness), /identity mismatch/);
  f.setHead({ revision: '0', journal: valid });
  assert.throws(() => readDeploymentJournalHead(f.witness), /genesis/);
  f.setHead({ revision: '1', journal: null });
  assert.throws(() => readDeploymentJournalHead(f.witness), /genesis/);
});

test('deployment witness rejects false CAS acknowledgments and can recover a lost response', () => {
  const result: DeploymentJournalHead = { revision: '0', journal: null };
  const liar = createDeploymentJournalWitness({ authorityId: 'operator', repositoryId: 'repo', deploymentId: 'lying',
    read: () => result,
    advance: (_expected, bytes) => ({ revision: '1', journal: bytes }),
  });
  assert.throws(() => advanceDeploymentJournalHead(liar, '0', journal(liar, '1')), /rolled back/);
  const wrong = createDeploymentJournalWitness({ authorityId: 'operator', repositoryId: 'repo', deploymentId: 'wrong-result',
    read: () => result,
    advance: () => ({ revision: '0', journal: null }),
  });
  assert.throws(() => advanceDeploymentJournalHead(wrong, '0', journal(wrong, '1')), /did not durably accept/);
  const wrongBytes = createDeploymentJournalWitness({ authorityId: 'operator', repositoryId: 'repo', deploymentId: 'wrong-bytes',
    read: () => result,
    advance: () => ({ revision: '1', journal: journal(wrongBytes, '1', '9') }),
  });
  assert.throws(() => advanceDeploymentJournalHead(wrongBytes, '0', journal(wrongBytes, '1')), /did not durably accept/);

  let head: DeploymentJournalHead = { revision: '0', journal: null };
  const recovered = createDeploymentJournalWitness({ authorityId: 'operator', repositoryId: 'repo', deploymentId: 'recovered',
    read: () => head,
    advance(expected, bytes) {
      if (head.revision !== expected) throw new Error('provider CAS lost');
      head = { revision: String(BigInt(expected) + 1n), journal: bytes };
      if (expected === '0') throw new Error('response lost after durable CAS');
      return head;
    },
  });
  const committed = journal(recovered, '1');
  assert.throws(() => advanceDeploymentJournalHead(recovered, '0', committed), /response lost/);
  assert.deepEqual(readDeploymentJournalHead(recovered), { revision: '1', journal: committed });
  assert.deepEqual(advanceDeploymentJournalHead(recovered, '1', journal(recovered, '2')),
    { revision: '2', journal: journal(recovered, '2') });
});

test('deployment witness rejects malformed source heads', () => {
  const f = fixture();
  f.setHead({ revision: '01', journal: journal(f.witness, '1') });
  assert.throws(() => readDeploymentJournalHead(f.witness), /canonical decimal/);
  f.setHead({ revision: '1', journal: journal(f.witness, '1'), extra: true } as DeploymentJournalHead);
  assert.throws(() => readDeploymentJournalHead(f.witness), /object fields/);
  f.setHead(Object.defineProperty({ revision: '1' }, 'journal', { enumerable: true, get: () => journal(f.witness, '1') }) as DeploymentJournalHead);
  assert.throws(() => readDeploymentJournalHead(f.witness), /accessor/);
});

test('deployment witness admits exact /10 sink identity and retains canonical CAS bytes', () => {
  const f = fixture();
  const first = sinkJournal(f.witness, '1');
  const second = sinkJournal(f.witness, '2', { readiness: 'ready' });
  assert.deepEqual(advanceDeploymentJournalHead(f.witness, '0', first), { revision: '1', journal: first });
  assert.deepEqual(advanceDeploymentJournalHead(f.witness, '1', second), { revision: '2', journal: second });
  assert.deepEqual(readDeploymentJournalHead(f.witness), { revision: '2', journal: second });
  assert.equal(f.advances(), 2);
});

test('deployment witness rejects malformed /10 sink fields and profile before CAS', () => {
  const f = fixture();
  const base = JSON.parse(sinkJournal(f.witness, '1')) as Record<string, unknown>;
  const encode = (value: Record<string, unknown>) => Buffer.from(encodeCanonical(value)).toString('utf8');
  const { sinkAnchorDigest: _omitted, ...missing } = base;
  const cases = [
    missing,
    { ...base, extra: true },
    { ...base, capabilityProfile: 'scoped-anchored-wasm-v9' },
    { ...base, sinkAnchorDigest: digest('aether.other/1') },
    { ...base, sinkDeploymentId: 'deployment:other' },
    { ...base, sinkDeploymentId: '' },
    { ...base, approvedAdapterArtifactDigest: digest('aether.other/1') },
    { ...base, sinkStateWitnessDigest: digest('aether.other/1') },
    { ...base, format: 'aether.process-deployment/9' },
  ];
  for (const candidate of cases) assert.throws(() => advanceDeploymentJournalHead(f.witness, '0', encode(candidate)));
  assert.equal(f.advances(), 0);
});

test('deployment witness forbids sink identity drift and /9↔/10 switch before CAS', () => {
  for (const [field, changed] of [
    ['sinkAnchorDigest', domainDigest('aether.sink-anchor/1', 'different')],
    ['sinkDeploymentId', 'deployment:other'],
    ['approvedAdapterArtifactDigest', digest('aether.effect-adapter-artifact/3')],
    ['sinkStateWitnessDigest', domainDigest('aether.sink-state-witness/1', 'different')],
  ] as const) {
    const f = fixture();
    const first = sinkJournal(f.witness, '1');
    advanceDeploymentJournalHead(f.witness, '0', first);
    assert.throws(() => advanceDeploymentJournalHead(f.witness, '1',
      sinkJournal(f.witness, '2', { [field]: changed })), /namespace mismatch|identity changed/);
    assert.equal(f.advances(), 1);
  }
  const v9 = fixture();
  advanceDeploymentJournalHead(v9.witness, '0', journal(v9.witness, '1'));
  assert.throws(() => advanceDeploymentJournalHead(v9.witness, '1', sinkJournal(v9.witness, '2')), /identity changed/);
  assert.equal(v9.advances(), 1);
  const v10 = fixture();
  advanceDeploymentJournalHead(v10.witness, '0', sinkJournal(v10.witness, '1'));
  assert.throws(() => advanceDeploymentJournalHead(v10.witness, '1', journal(v10.witness, '2')), /identity changed/);
  assert.equal(v10.advances(), 1);
});

test('deployment witness admits exact /11 resource-scoped sink journal and durable CAS bytes', () => {
  const f = fixture();
  const first = resourceSinkJournal(f.witness, '1');
  const second = resourceSinkJournal(f.witness, '2', {
    active: { id: 'genesis', manifest: digest('aether.execution/1'),
      artifactDigest: digest('aether.process-artifact/1'), generation: '1' },
  });
  assert.deepEqual(advanceDeploymentJournalHead(f.witness, '0', first), { revision: '1', journal: first });
  assert.deepEqual(advanceDeploymentJournalHead(f.witness, '1', second), { revision: '2', journal: second });
  assert.deepEqual(readDeploymentJournalHead(f.witness), { revision: '2', journal: second });
  assert.equal(f.advances(), 2);
});

test('deployment witness rejects malformed /11 sink fields, namespace, and profile before CAS', () => {
  const f = fixture();
  const base = JSON.parse(resourceSinkJournal(f.witness, '1')) as Record<string, unknown>;
  const encode = (value: Record<string, unknown>) => Buffer.from(encodeCanonical(value)).toString('utf8');
  const { sinkStateWitnessDigest: _omitted, ...missing } = base;
  for (const candidate of [
    missing,
    { ...base, extra: true },
    { ...base, capabilityProfile: 'scoped-anchored-sink-v10' },
    { ...base, sinkAnchorDigest: digest('aether.other/1') },
    { ...base, sinkDeploymentId: 'deployment:other' },
    { ...base, approvedAdapterArtifactDigest: digest('aether.other/1') },
    { ...base, sinkStateWitnessDigest: digest('aether.other/1') },
  ]) assert.throws(() => advanceDeploymentJournalHead(f.witness, '0', encode(candidate)));
  assert.equal(f.advances(), 0);
});

test('deployment witness prevents /11 sink identity changes and cross-version adoption before CAS', () => {
  for (const [field, changed] of [
    ['sinkAnchorDigest', domainDigest('aether.sink-anchor/1', 'other')],
    ['sinkDeploymentId', 'deployment:other'],
    ['approvedAdapterArtifactDigest', digest('aether.effect-adapter-artifact/3')],
    ['sinkStateWitnessDigest', domainDigest('aether.sink-state-witness/1', 'other')],
  ] as const) {
    const f = fixture();
    advanceDeploymentJournalHead(f.witness, '0', resourceSinkJournal(f.witness, '1'));
    assert.throws(() => advanceDeploymentJournalHead(f.witness, '1',
      resourceSinkJournal(f.witness, '2', { [field]: changed })), /namespace mismatch|identity changed/);
    assert.equal(f.advances(), 1);
  }
  for (const [first, next] of [
    [journal, resourceSinkJournal],
    [sinkJournal, resourceSinkJournal],
    [resourceSinkJournal, sinkJournal],
    [resourceSinkJournal, journal],
  ] as const) {
    const f = fixture();
    advanceDeploymentJournalHead(f.witness, '0', first(f.witness, '1'));
    assert.throws(() => advanceDeploymentJournalHead(f.witness, '1', next(f.witness, '2')), /identity changed/);
    assert.equal(f.advances(), 1);
  }
});
