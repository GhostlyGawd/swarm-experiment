import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { typeName } from '../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { domainDigest, type Digest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { PackedHeap, packResumableCheckpoint, type PackedLayout } from '../../src/tier3/packed-heap.ts';
import { ResumableRuntime, type PackedCandidateSubject } from '../../src/tier3/resumable-runtime.ts';
import { checkpointDigest, eventDigest } from '../../src/tier3/resumable-state.ts';

function fixture() {
  const symbols = new SymbolSpace('packed-candidate-handoff'), entry = symbols.define('entry');
  const module = b.module_({symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({symbol: entry, returns: b.Int, body: b.ret(b.int(1))})
  ]});
  const digest = (name: string) => domainDigest('aether.packed-candidate-test/1', name);
  const manifest: ExecutionManifestV1 = {format: 'aether.execution/1', astRoot: new GraphStore().intern(module),
    specRoot: digest('spec'), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'),
    target: {abiVersion: 'resumable/1', profileDigest: digest('target'), artifactDigest: digest('artifact')},
    capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence')};
  const name = typeName('type:test:packed_candidate_node');
  const ty = {t: 'Record' as const, name, fields: [['count', b.Int], ['label', b.Str], ['next', b.Unit]] as const};
  const layout: PackedLayout = {typeName: name, fields: [
    {name: 'count', kind: 'int', min: '0', max: '100', overflow: 'trap'},
    {name: 'label', kind: 'string', maxUtf8Bytes: 32},
    {name: 'next', kind: 'ref', maxRelative: 2}
  ]};
  let expectedCandidate: Digest | null = null, observedSubject: PackedCandidateSubject | null = null;
  const options = {manifest, registry: new CapabilityRegistry(), executionId: 'packed-candidate-execution',
    authorizeCorrection: () => true,
    authorizePackedCandidate: (_snapshot: unknown, subject: PackedCandidateSubject) => {
      observedSubject = subject; return subject.candidateImageDigest === expectedCandidate;
    }};
  const runtime = new ResumableRuntime(module, options);
  const first = runtime.allocateRecord(ty, {count: 3n, label: 'alpha', next: null});
  const second = runtime.allocateRecord(ty, {count: 7n, label: 'βeta', next: null});
  runtime.correctRecord(second, 'next', first);
  const before = runtime.snapshot(), sourceDigest = checkpointDigest(before), packed = packResumableCheckpoint(before, runtime.program, [layout]);
  const candidate = PackedHeap.fromImage(packed.heap, packed.heap.layoutDigest);
  candidate.set(String(first.addr), 'count', {tag: 'int', value: '8'});
  candidate.set(String(first.addr), 'label', {tag: 'string', value: 'λambda'});
  candidate.set(String(second.addr), 'next', {tag: 'ref', value: {heapId: first.heapId, objectId: String(second.addr), ownerEpoch: second.ownerEpoch}});
  expectedCandidate = candidate.image().imageDigest;
  return {runtime, module, options, first, second, layout, before, sourceDigest, packed, candidate: candidate.image(),
    get observedSubject() {return observedSubject;}, set expectedCandidate(value: Digest | null) {expectedCandidate = value;}};
}

test('native packed candidate becomes one authorized, replayable correction event', () => {
  const f = fixture();
  const receipt = f.runtime.commitPackedCandidate(f.packed, f.candidate, f.sourceDigest, f.packed.heap.layoutDigest);
  assert.equal(receipt.changedFields, 3);
  assert.equal(receipt.eventCursor, String(f.before.events.length + 1));
  assert.equal(f.observedSubject?.candidateImageDigest, f.candidate.imageDigest);
  assert.equal(f.observedSubject?.sourceSnapshotDigest, f.sourceDigest);
  const after = f.runtime.snapshot();
  assert.equal(checkpointDigest(after), receipt.snapshotDigest);
  assert.equal(after.events.at(-1)?.op, `packed-correction:${receipt.subjectDigest}`);
  assert.equal(after.events.at(-1)?.delta.length, 1);
  assert.equal(after.events.at(-1)?.delta[0].section, 'records');
  assert.equal(f.runtime.readRecord(f.first).get('count'), 8n);
  assert.equal(f.runtime.readRecord(f.first).get('label'), 'λambda');
  assert.deepEqual(f.runtime.readRecord(f.second).get('next'), f.second);
  const repacked = packResumableCheckpoint(after, f.runtime.program, [f.layout]);
  assert.equal(repacked.heap.bytes, f.candidate.bytes);
  assert.equal(repacked.heap.stringBytes, f.candidate.stringBytes);
  const reopened = new ResumableRuntime(f.module, f.options);
  reopened.restore(after, receipt.snapshotDigest);
  assert.equal(reopened.readRecord(f.first).get('label'), 'λambda');
  const relabeled = structuredClone(after);
  relabeled.events.at(-1)!.op = 'packed-correction:unbound';
  relabeled.eventHead = eventDigest(relabeled.events.at(-1)!);
  assert.throws(() => new ResumableRuntime(f.module, f.options).restore(relabeled, checkpointDigest(relabeled)), /bound instruction/);
  reopened.rewind(1);
  assert.equal(checkpointDigest(reopened.snapshot()), f.sourceDigest);
});

test('stale, altered, unauthorised and identity-changing candidates leave runtime state untouched', () => {
  const f = fixture(), before = checkpointDigest(f.runtime.snapshot());
  f.expectedCandidate = null;
  assert.throws(() => f.runtime.commitPackedCandidate(f.packed, f.candidate, f.sourceDigest, f.packed.heap.layoutDigest), /did not authorize/);
  assert.equal(checkpointDigest(f.runtime.snapshot()), before);
  f.expectedCandidate = f.candidate.imageDigest;
  const asyncAuthority = new ResumableRuntime(f.module, {...f.options,
    authorizePackedCandidate: () => Promise.resolve(true) as never});
  asyncAuthority.restore(f.before, f.sourceDigest);
  assert.throws(() => asyncAuthority.commitPackedCandidate(f.packed, f.candidate, f.sourceDigest, f.packed.heap.layoutDigest), /did not authorize/);
  assert.equal(checkpointDigest(asyncAuthority.snapshot()), f.sourceDigest);
  assert.throws(() => f.runtime.commitPackedCandidate(f.packed, f.candidate,
    domainDigest('aether.packed-candidate-test/1', 'wrong'), f.packed.heap.layoutDigest), /trusted digest|stale|mismatch/);
  assert.equal(checkpointDigest(f.runtime.snapshot()), before);
  const changedRow = {...f.candidate, rows: f.candidate.rows.map((row, index) => index ? row : {...row, version: '999'})};
  const {imageDigest: _digest, ...body} = changedRow;
  const forged = {...body, imageDigest: domainDigest('aether.packed-heap-image/2', body)};
  assert.throws(() => f.runtime.commitPackedCandidate(f.packed, forged, f.sourceDigest, f.packed.heap.layoutDigest), /row identity/);
  assert.equal(checkpointDigest(f.runtime.snapshot()), before);
  assert.throws(() => f.runtime.commitPackedCandidate(f.packed, f.candidate, f.sourceDigest,
    domainDigest('aether.packed-candidate-test/1', 'wrong-layout')), /layout digest/);
  assert.equal(checkpointDigest(f.runtime.snapshot()), before);
  f.runtime.correctRecord(f.first, 'count', 4n);
  const advanced = checkpointDigest(f.runtime.snapshot());
  assert.throws(() => f.runtime.commitPackedCandidate(f.packed, f.candidate, f.sourceDigest, f.packed.heap.layoutDigest), /stale/);
  assert.equal(checkpointDigest(f.runtime.snapshot()), advanced);
});
