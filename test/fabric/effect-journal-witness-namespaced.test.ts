import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceWitnessHead, createEffectJournalWitness, createEffectJournalWitnessCatalog,
  createNamespacedEffectJournalWitness, createNamespacedEffectJournalWitnessCatalog,
  readWitnessHead, selectEffectJournalWitness,
  type NamespacedEffectJournalWitness, type WitnessHead,
} from '../../src/fabric/effect-journal-witness.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { DurableEffectBroker } from '../../src/fabric/effects.ts';

function witness(deploymentId = 'deployment:a', operationId = 'operation:shared', overrides: Partial<{
  authorityId: string; repositoryId: string; clockDomain: string;
}> = {}) {
  let head: WitnessHead = { revision: '0', journal: null };
  const value = createNamespacedEffectJournalWitness({
    authorityId: overrides.authorityId ?? 'operator:test', repositoryId: overrides.repositoryId ?? 'repo:test',
    catalogDeploymentId: deploymentId, operationId, clockDomain: overrides.clockDomain ?? 'clock:test',
    read: () => head,
    advance(expectedRevision, journal) {
      assert.equal(head.revision, expectedRevision);
      head = { revision: String(BigInt(expectedRevision) + 1n), journal };
      return head;
    },
  });
  return { value, head: () => head };
}
function catalog(deploymentId: string, witnessFor: (operationId: string) => NamespacedEffectJournalWitness,
  overrides: Partial<{ authorityId: string; repositoryId: string; clockDomain: string }> = {}) {
  return createNamespacedEffectJournalWitnessCatalog({
    authorityId: overrides.authorityId ?? 'operator:test', repositoryId: overrides.repositoryId ?? 'repo:test',
    deploymentId, clockDomain: overrides.clockDomain ?? 'clock:test', witnessFor,
  });
}

test('namespaced V2 identities bind deployment and operation, while V1 bytes remain stable', () => {
  const old = createEffectJournalWitness({ authorityId: 'operator:test', repositoryId: 'repo:test',
    deploymentId: 'op:test', clockDomain: 'clock:test', read: () => ({ revision: '0', journal: null }),
    advance: () => ({ revision: '1', journal: '{}' }) });
  const oldCatalog = createEffectJournalWitnessCatalog({ authorityId: 'operator:test', repositoryId: 'repo:test',
    deploymentId: 'deployment:test', clockDomain: 'clock:test', witnessFor: () => old });
  assert.equal(old.digest, 'aether.effect-journal-witness/1:b3:9ea2f5d5a7315a178c33689e1c49cbe264f39b0678a31c0ac90180b053b63842');
  assert.equal(oldCatalog.digest, 'aether.effect-journal-witness-catalog/1:b3:518275eaa6ab80744fe4ea9fe20b79673c2a1f632ccd73ef6a519151b9bb858a');

  const a = witness(), differentDeployment = witness('deployment:b'), differentOperation = witness('deployment:a', 'operation:other');
  const differentAuthority = witness('deployment:a', 'operation:shared', { authorityId: 'operator:other' });
  const differentRepository = witness('deployment:a', 'operation:shared', { repositoryId: 'repo:other' });
  const differentClock = witness('deployment:a', 'operation:shared', { clockDomain: 'clock:other' });
  for (const other of [old, differentDeployment.value, differentOperation.value,
    differentAuthority.value, differentRepository.value, differentClock.value])
    assert.notEqual(a.value.digest, other.digest);
  assert.notEqual(catalog('deployment:a', () => a.value).digest, catalog('deployment:b', () => a.value).digest);
  assert.equal(selectEffectJournalWitness(oldCatalog, 'op:test'), old);
  assert.equal(selectEffectJournalWitness(catalog('deployment:a', () => a.value), 'operation:shared'), a.value);
  assert.deepEqual(advanceWitnessHead(a.value, '0', '{}'), { revision: '1', journal: '{}' });
  assert.deepEqual(readWitnessHead(a.value), { revision: '1', journal: '{}' });
});

test('V2 catalog rejects V1, wrong deployment, operation, authority, repository, and clock', () => {
  const old = createEffectJournalWitness({ authorityId: 'operator:test', repositoryId: 'repo:test',
    deploymentId: 'operation:shared', clockDomain: 'clock:test', read: () => ({ revision: '0', journal: null }),
    advance: () => ({ revision: '1', journal: '{}' }) });
  const wrong = [
    old as unknown as NamespacedEffectJournalWitness,
    witness('deployment:b').value,
    witness('deployment:a', 'operation:other').value,
    witness('deployment:a', 'operation:shared', { authorityId: 'operator:other' }).value,
    witness('deployment:a', 'operation:shared', { repositoryId: 'repo:other' }).value,
    witness('deployment:a', 'operation:shared', { clockDomain: 'clock:other' }).value,
  ];
  for (const candidate of wrong) {
    const source = catalog('deployment:a', () => candidate);
    assert.throws(() => selectEffectJournalWitness(source, 'operation:shared'), /outside operator catalog/);
  }
  const namespaced = witness().value;
  const legacyCatalog = createEffectJournalWitnessCatalog({ authorityId: 'operator:test', repositoryId: 'repo:test',
    deploymentId: 'deployment:a', clockDomain: 'clock:test',
    witnessFor: () => namespaced as unknown as typeof old });
  assert.throws(() => selectEffectJournalWitness(legacyCatalog, 'operation:shared'), /outside operator catalog/);
});

test('V2 catalog pins the selected object for its lifetime', () => {
  const first = witness().value, replacement = witness().value;
  let selected = first;
  const source = catalog('deployment:a', () => selected);
  assert.equal(selectEffectJournalWitness(source, 'operation:shared'), first);
  selected = replacement;
  assert.throws(() => selectEffectJournalWitness(source, 'operation:shared'), /swapped during catalog lifetime/);
});

test('V1 and V2 require a retained head after a falsely successful CAS response', () => {
  const read = (): WitnessHead => ({ revision: '0', journal: null });
  const advance = (): WitnessHead => ({ revision: '1', journal: '{}' });
  const old = createEffectJournalWitness({ authorityId: 'operator:test', repositoryId: 'repo:test',
    deploymentId: 'operation:shared', clockDomain: 'clock:test', read, advance });
  const namespaced = createNamespacedEffectJournalWitness({ authorityId: 'operator:test', repositoryId: 'repo:test',
    catalogDeploymentId: 'deployment:a', operationId: 'operation:shared', clockDomain: 'clock:test', read, advance });
  for (const candidate of [old, namespaced])
    assert.throws(() => advanceWitnessHead(candidate, '0', '{}'), /rolled back|did not retain/);
});

test('broker accepts V2 and rejects a head aliased across deployment namespaces', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-effect-witness-namespace-'));
  try {
    let shared: WitnessHead = { revision: '0', journal: null };
    const make = (catalogDeploymentId: string) => createNamespacedEffectJournalWitness({
      authorityId: 'operator:test', repositoryId: 'repo:test', catalogDeploymentId,
      operationId: 'operation:shared', clockDomain: 'clock:test', read: () => shared,
      advance(expectedRevision, journal) {
        assert.equal(shared.revision, expectedRevision);
        shared = { revision: String(BigInt(expectedRevision) + 1n), journal };
        return shared;
      },
    });
    const first = make('deployment:a'), second = make('deployment:b');
    const journal = Buffer.from(encodeCanonical({ format: 'aether.effect-journal/2', clockDomain: 'clock:test',
      witnessDigest: first.digest, revision: '1', records: [] })).toString('utf8');
    advanceWitnessHead(first, '0', journal);
    const options = { clockDomain: 'clock:test', authorize: () => true, authorizeReconciliation: () => true };
    assert.deepEqual(new DurableEffectBroker({ ...options, directory: join(directory, 'first'), witness: first }).events(), []);
    assert.throws(() => new DurableEffectBroker({ ...options,
      directory: join(directory, 'second'), witness: second }).events(), /identity\/canonical mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
