import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { advanceHostJournalHead, assertHostJournalWitness, assertHostJournalWitnessCatalog,
  createHostJournalWitness, createHostJournalWitnessCatalog, selectHostJournalWitness,
  readHostJournalHead, type HostJournalHead } from '../../src/fabric/host-journal-witness.ts';

const configuration = domainDigest('aether.process-host-configuration/1', { test: true });
function journal(revision: string, generation = '1', format: 'aether.process-host/3' | 'aether.process-host/4' = 'aether.process-host/4'): string {
  return Buffer.from(encodeCanonical({ format, configuration, generation, plan: '{}', snapshot: {},
    calls: [], migrations: [], allocations: [], snapshots: [], heads: [],
    ...(format === 'aether.process-host/4' ? { witnessRevision: revision } : {}) })).toString('utf8');
}
function fixture() {
  let head: HostJournalHead = { revision: '0', journal: null };
  let advances = 0;
  const witness = createHostJournalWitness({ authorityId: 'operator:host', repositoryId: 'repo:test', hostId: 'host:stable',
    read: () => head,
    advance(expected, bytes) {
      advances++;
      if (head.revision !== expected) throw new Error('provider CAS lost');
      head = { revision: String(BigInt(expected) + 1n), journal: bytes };
      return head;
    } });
  return { witness, head: () => head, setHead: (next: HostJournalHead) => { head = next; }, advances: () => advances };
}

test('host witness pins operator, repository and stable host identity, with exact CAS bytes', () => {
  const f = fixture();
  const first = journal('1');
  assert.deepEqual(readHostJournalHead(f.witness), { revision: '0', journal: null });
  assert.deepEqual(advanceHostJournalHead(f.witness, '0', first), { revision: '1', journal: first });
  assert.deepEqual(advanceHostJournalHead(f.witness, '1', journal('2', '2')), { revision: '2', journal: journal('2', '2') });
  assert.equal(f.advances(), 2);
  assert.equal(f.witness.digest, domainDigest('aether.process-host-journal-witness/1', {
    format: 'aether.process-host-journal-witness/1', authorityId: 'operator:host', repositoryId: 'repo:test', hostId: 'host:stable' }));
  assert.ok(Object.isFrozen(f.witness));
  assert.throws(() => assertHostJournalWitness({ ...f.witness }), /independently supplied/);
  assert.throws(() => createHostJournalWitness({ authorityId: '', repositoryId: 'repo:test', hostId: 'host:stable',
    read: () => f.head(), advance: () => f.head() }), /identifier/);
});

test('host witness rejects stale writers, rollback and same-revision equivocation', () => {
  const f = fixture();
  const first = journal('1');
  advanceHostJournalHead(f.witness, '0', first);
  assert.throws(() => advanceHostJournalHead(f.witness, '0', first), /stale/);
  assert.equal(f.advances(), 1);
  f.setHead({ revision: '1', journal: journal('1', '2') });
  assert.throws(() => readHostJournalHead(f.witness), /equivocated/);
  f.setHead({ revision: '0', journal: null });
  assert.throws(() => readHostJournalHead(f.witness), /rolled back/);
});

test('host witness refuses malformed, noncanonical and oversized heads before advancing', () => {
  const f = fixture();
  const valid = journal('1');
  for (const bytes of [
    ` ${valid}`, valid.replace('"format"', '"format" '),
    valid.replace('{', '{"format":"aether.process-host/4",'),
    valid.replace('aether.process-host/4', 'aether.other/4'),
    valid.replace('"witnessRevision":"1"', '"witnessRevision":"0"'),
    '{}', 'x'.repeat(8 * 1024 * 1024 + 1),
  ]) assert.throws(() => advanceHostJournalHead(f.witness, '0', bytes));
  assert.equal(f.advances(), 0);
  f.setHead({ revision: '1', journal: '{}'});
  assert.throws(() => readHostJournalHead(f.witness), /incomplete|format/);
  f.setHead({ revision: '1', journal: valid + ' ' });
  assert.throws(() => readHostJournalHead(f.witness), /noncanonical/);
  f.setHead({ revision: '0', journal: valid });
  assert.throws(() => readHostJournalHead(f.witness), /genesis/);
  f.setHead({ revision: '1', journal: null });
  assert.throws(() => readHostJournalHead(f.witness), /genesis/);
});

test('host witness refuses false CAS acknowledgments and can reread after a lost response', () => {
  let head: HostJournalHead = { revision: '0', journal: null };
  let response: 'wrong-revision' | 'wrong-bytes' = 'wrong-revision';
  const witness = createHostJournalWitness({ authorityId: 'operator', repositoryId: 'repo', hostId: 'host',
    read: () => head,
    advance(expected, bytes) {
      const next = String(BigInt(expected) + 1n);
      if (response === 'wrong-revision') return { revision: expected, journal: null };
      return { revision: next, journal: journal(next, '9') };
    } });
  assert.throws(() => advanceHostJournalHead(witness, '0', journal('1')), /did not durably accept/);
  response = 'wrong-bytes';
  assert.throws(() => advanceHostJournalHead(witness, '0', journal('1')), /did not durably accept/);
  assert.throws(() => readHostJournalHead(witness), /rolled back/);

  const recovered = createHostJournalWitness({ authorityId: 'operator', repositoryId: 'repo', hostId: 'host:second',
    read: () => head,
    advance(expected, bytes) {
      if (head.revision !== expected) throw new Error('provider CAS lost');
      head = { revision: String(BigInt(expected) + 1n), journal: bytes };
      if (expected === '0') throw new Error('response lost after durable CAS');
      return head;
    } });
  assert.throws(() => advanceHostJournalHead(recovered, '0', journal('1')), /response lost/);
  assert.deepEqual(readHostJournalHead(recovered), { revision: '1', journal: journal('1') });
  assert.deepEqual(advanceHostJournalHead(recovered, '1', journal('2', '2')), { revision: '2', journal: journal('2', '2') });
});

test('host witness rejects malformed source objects and accepts prior canonical host formats', () => {
  const f = fixture();
  const third = journal('1', '1', 'aether.process-host/3');
  assert.equal(advanceHostJournalHead(f.witness, '0', third).journal, third);
  f.setHead({ revision: '01', journal: third });
  assert.throws(() => readHostJournalHead(f.witness), /canonical decimal/);
  f.setHead({ revision: '1', journal: third, extra: true } as HostJournalHead);
  assert.throws(() => readHostJournalHead(f.witness), /object fields/);
  f.setHead(Object.defineProperty({ revision: '1' }, 'journal', { enumerable: true, get: () => third }) as HostJournalHead);
  assert.throws(() => readHostJournalHead(f.witness), /accessor/);
});

test('host catalog pins an operator namespace and one witness object per stable host', () => {
  const first = fixture();
  const second = createHostJournalWitness({ authorityId: 'operator:host', repositoryId: 'repo:test', hostId: 'host:second',
    read: () => ({ revision: '0', journal: null }),
    advance: () => { throw new Error('unused'); } });
  const selected = new Map([['host:stable', first.witness], ['host:second', second]]);
  const catalog = createHostJournalWitnessCatalog({ authorityId: 'operator:host', repositoryId: 'repo:test',
    deploymentId: 'deployment:one', witnessFor: id => selected.get(id)! });
  assert.equal(selectHostJournalWitness(catalog, 'host:stable'), first.witness);
  assert.equal(selectHostJournalWitness(catalog, 'host:second'), second);
  assert.ok(Object.isFrozen(catalog));
  assert.equal(catalog.digest, domainDigest('aether.process-host-journal-witness-catalog/1', {
    format: 'aether.process-host-journal-witness-catalog/1', authorityId: 'operator:host',
    repositoryId: 'repo:test', deploymentId: 'deployment:one' }));
  assert.throws(() => assertHostJournalWitnessCatalog({ ...catalog }), /independently supplied/);
  selected.set('host:stable', createHostJournalWitness({ authorityId: 'operator:host', repositoryId: 'repo:test',
    hostId: 'host:stable', read: () => ({ revision: '0', journal: null }), advance: () => { throw new Error('unused'); } }));
  assert.throws(() => selectHostJournalWitness(catalog, 'host:stable'), /swapped/);
  selected.set('host:second', first.witness);
  assert.throws(() => selectHostJournalWitness(catalog, 'host:second'), /outside operator catalog/);
  assert.throws(() => selectHostJournalWitness(catalog, 'host:missing'), /independently supplied/);
});
