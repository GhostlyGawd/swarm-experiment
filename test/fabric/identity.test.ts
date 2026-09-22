import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { AetherRepository } from '../../src/tier1/repository.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { encodeCanonical, decodeCanonical, encodeTaggedValue, decodeTaggedValue, validateTaggedValue, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { domainDigest, createExecutionManifest, executionManifestDigest, decodeExecutionManifest, encodeExecutionManifest, verifyDependencyClosure, dependencyClosure, metadataSidecar, validateDigest, type ExecutionManifestV1, type DependencyV1 } from '../../src/fabric/identity.ts';
import { encodeRuntimeSnapshot, decodeRuntimeSnapshot, runtimeSnapshotDigest, type RuntimeSnapshotV1 } from '../../src/fabric/snapshot.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const digest = (name: string): string => domainDigest('aether.fixture/1', name);
const store = new GraphStore();
const astRoot = store.intern(b.int(42));
const context = {
  astRoot, specRoot: digest('spec'), semanticsVersion: 'aether-semantics/1', compilerDigest: digest('compiler'),
  target: { abiVersion: 'aether-abi/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
  capabilityPolicyDigest: digest('capabilities'), evidencePolicyDigest: digest('evidence-policy'),
};
const a = { symbol: 'sym:callee', declaration: digest('callee') };
const z = { symbol: 'module:import', declaration: digest('imported-module') };
const e = { symbol: 'external:summary', declaration: digest('external-summary') };
const resolve = (d: DependencyV1) => ({ declaration: d.declaration, dependencies: d.symbol === a.symbol ? [z] : d.symbol === z.symbol ? [e] : [] });
const manifest = (): ExecutionManifestV1 => createExecutionManifest(context, [a], resolve);

test('F03/G1 v1 AST and commit addresses remain unchanged across metadata observation and reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-v4-identity-'));
  try {
    const repo = new AetherRepository(directory);
    const term = b.block(b.ret(b.int(42)));
    const root = repo.store.intern(term);
    assert.equal(root, 'ast:b3:19ef8eabcbb36d9553c7048f9288952fdc7b9019d80735c95581af4c561dd3a3');
    assert.equal(repo.store.intern(b.int(42)), 'ast:b3:1fbf0bbf07105c5a953bc2937a2121891092db7e1c19de0762931d16f355b9a8');
    const commit = repo.commit('main', root, { timestamp: 42 });
    const pack = repo.exportPackfile();
    metadataSidecar(root, 'telemetry', '1', { calls: 10 });
    const reopen = new AetherRepository(directory);
    assert.equal(reopen.resolve('main')?.id, commit.id);
    assert.equal(reopen.resolve('main')?.root, root);
    assert.equal(reopen.store.intern(term), root);
    assert.deepEqual(reopen.exportPackfile(), pack);
    assert.deepEqual(reopen.fsck(), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('F03/G2 execution manifest binds every execution context component and sorts complete dependency closure', () => {
  const m = manifest(); const baseline = executionManifestDigest(m);
  assert.deepEqual(m.dependencies, [e, z, a].sort((a, b) => a.symbol < b.symbol ? -1 : 1));
  verifyDependencyClosure(m, [a], resolve);
  assert.equal(executionManifestDigest(createExecutionManifest(context, [e, z, a], resolve)), baseline);
  const changes: ExecutionManifestV1[] = [
    { ...m, astRoot: store.intern(b.int(43)) }, { ...m, specRoot: digest('new-spec') },
    { ...m, semanticsVersion: '2' }, { ...m, compilerDigest: digest('new-compiler') },
    { ...m, target: { ...m.target, abiVersion: '2' } }, { ...m, target: { ...m.target, profileDigest: digest('new-profile') } },
    { ...m, target: { ...m.target, artifactDigest: digest('new-artifact') } },
    { ...m, capabilityPolicyDigest: digest('new-capabilities') }, { ...m, evidencePolicyDigest: digest('new-evidence-policy') },
    ...m.dependencies.map((_, index) => ({ ...m, dependencies: m.dependencies.map((d, i) => i === index ? { ...d, declaration: digest('changed-dependency') } : d) })),
  ];
  for (const change of changes) assert.notEqual(executionManifestDigest(change), baseline);
  assert.deepEqual(encodeExecutionManifest(decodeExecutionManifest(encodeExecutionManifest(m))), encodeExecutionManifest(m));
  assert.throws(() => verifyDependencyClosure({ ...m, dependencies: [a] }, [a], resolve), /closure/);
  assert.throws(() => verifyDependencyClosure(m, [a], d => ({ declaration: digest('changed'), dependencies: [] })), /changed dependency/);
  assert.throws(() => dependencyClosure([a, { ...a, declaration: digest('conflict') }], resolve), /conflicting/);
  assert.throws(() => dependencyClosure([a], () => { throw new Error('missing import'); }), /missing import/);
});

test('F03/G2 metadata is content-bound independently and domains cannot be relabeled', () => {
  const first = metadataSidecar(astRoot, 'telemetry', '1', { calls: 1 });
  const next = metadataSidecar(astRoot, 'telemetry', '1', { calls: 2 });
  assert.notEqual(first.digest, next.digest); assert.equal(first.sidecar.subject, next.sidecar.subject);
  assert.equal(first.sidecar.subject, astRoot);
  assert.notEqual(domainDigest('aether.one/1', { n: 1 }).split(':').at(-1), domainDigest('aether.two/1', { n: 1 }).split(':').at(-1));
  assert.notEqual(domainDigest('aether.one/1', { n: 1 }), domainDigest('aether.one/2', { n: 1 }));
  assert.throws(() => validateDigest('ast:b3:123'), /digest/);
  assert.throws(() => validateDigest(digest('x'), 'aether.execution/1'), /domain/);
});

test('F03/G3 tagged wire values preserve bigint, Unicode and reference identity without numeric coercion', () => {
  const value: TaggedValueV1 = { tag: 'sequence', items: [
    { tag: 'null' }, { tag: 'bool', value: false }, { tag: 'string', value: '💫 é e\u0301' },
    { tag: 'int', value: '-999999999999999999999999999999999999999999999' },
    { tag: 'result', variant: 'ok', value: { tag: 'int', value: '0' } },
    { tag: 'ref', value: { heapId: 'heap:a', objectId: '123456789123456789', ownerEpoch: '2' } },
    { tag: 'authority', authorityId: 'grant:opaque-reference', policyEpoch: '2' },
  ] };
  assert.deepEqual(encodeTaggedValue(decodeTaggedValue(encodeTaggedValue(value))), encodeTaggedValue(value));
  assert.equal(Buffer.from(encodeCanonical({ b: 2, a: 1 })).toString(), '{"a":1,"b":2}');
  assert.notDeepEqual(encodeCanonical('é'), encodeCanonical('e\u0301'));
});

test('F03/G3 malformed values, duplicate map keys and unsupported versions are rejected', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '9007199254740993', '-0', '1.2', '1e3', '{"a":1,}', '[1,]', '"\\ud800"', '{"a":true}garbage']) assert.throws(() => decodeCanonical(bytes(text)), text);
  for (const value of [
    { tag: 'int', value: 123 }, { tag: 'int', value: '-0' }, { tag: 'int', value: '01' }, { tag: 'int', value: '1e10' },
    { tag: 'bool', value: 1 }, { tag: 'null', value: null }, { tag: 'secret', value: 'bearer' },
    { tag: 'result', variant: 'maybe', value: { tag: 'null' } }, { tag: 'string', value: '\udfff' },
    { tag: 'ref', value: { heapId: 'h', objectId: '1', ownerEpoch: '-1' } },
  ]) assert.throws(() => validateTaggedValue(value));
  for (const value of [1n, NaN, Infinity, 1.1, -0, 9007199254740992, () => {}, new Date(), new Map(), new Uint8Array(2), { get x() { throw new Error('getter must not run'); } }]) assert.throws(() => encodeCanonical(value));
  assert.throws(() => decodeTaggedValue(bytes('{"format":"aether.value/2","value":{"tag":"null"}}')), /version/);
  assert.throws(() => decodeExecutionManifest(encodeCanonical({ ...manifest(), format: 'aether.execution/2' })), /version/);
  assert.throws(() => decodeExecutionManifest(encodeCanonical({ ...manifest(), extra: true })), /fields/);
  assert.throws(() => executionManifestDigest({ ...manifest(), dependencies: [a, a] }), /duplicate/);
  assert.throws(() => decodeCanonical(Uint8Array.of(0xff)), /encoded data/);
});

test('F03/G3 schema resource limits reject byte, decompressed, depth, count and integer excess', () => {
  assert.throws(() => decodeCanonical(bytes('"abcdef"'), { maxFrameBytes: 4 }), /byte limit/);
  assert.throws(() => decodeCanonical(bytes('"abcdef"'), { maxDecompressedBytes: 4 }), /byte limit/);
  assert.throws(() => encodeCanonical('abcdef', { maxFrameBytes: 4 }), /byte limit/);
  assert.throws(() => decodeCanonical(bytes('[[[0]]]'), { maxDepth: 2 }), /depth/);
  assert.throws(() => encodeCanonical([[[0]]], { maxDepth: 2 }), /depth/);
  assert.throws(() => decodeCanonical(bytes('[1,2,3]'), { maxObjects: 3 }), /object limit/);
  assert.throws(() => encodeCanonical([1,2,3], { maxObjects: 3 }), /object limit/);
  assert.throws(() => validateTaggedValue({ tag: 'int', value: '12345' }, { maxIntegerDigits: 4 }), /digit limit/);
  assert.throws(() => decodeCanonical(bytes('12345'), { maxIntegerDigits: 4 }), /digit limit/);
  assert.throws(() => dependencyClosure([{ symbol: '0', declaration: digest('0') }], d => ({ declaration: d.declaration, dependencies: [{ symbol: String(Number(d.symbol) + 1), declaration: digest('next') }] }), { maxObjects: 8 }), /limit/);
  const cycle: unknown[] = []; cycle.push(cycle); assert.throws(() => encodeCanonical(cycle), /cycles/);
});

const snapshot = (): RuntimeSnapshotV1 => ({
  format: 'aether.state/1', executionManifest: executionManifestDigest(manifest()), heapId: 'heap:ledger', nextObjectId: '2', eventCursor: '0',
  records: [
    { objectId: '0', fields: [['alias', { tag: 'ref', value: { heapId: 'heap:ledger', objectId: '1', ownerEpoch: '2' } }], ['balance', { tag: 'int', value: '90' }]] },
    { objectId: '1', fields: [['cycle', { tag: 'ref', value: { heapId: 'heap:ledger', objectId: '0', ownerEpoch: '2' } }], ['shared', { tag: 'ref', value: { heapId: 'heap:ledger', objectId: '1', ownerEpoch: '2' } }]] },
  ], ownership: [{ objectId: '0', unit: 'worker:a', epoch: '2' }, { objectId: '1', unit: 'worker:b', epoch: '2' }],
});
test('F03/G3 state envelopes preserve cycles and shared IDs and reject malformed object tables', () => {
  const s = snapshot();
  const encoded = encodeRuntimeSnapshot(s);
  assert.deepEqual(encodeRuntimeSnapshot(decodeRuntimeSnapshot(encoded)), encoded);
  assert.equal(runtimeSnapshotDigest(decodeRuntimeSnapshot(encoded)), runtimeSnapshotDigest(s));
  const invalid: unknown[] = [
    { ...s, format: 'aether.state/2' }, { ...s, nextObjectId: '1' }, { ...s, ownership: [] },
    { ...s, records: [s.records[0], s.records[0]] },
    { ...s, ownership: [s.ownership[0], { ...s.ownership[1], epoch: '3' }] },
    { ...s, records: [{ ...s.records[0], fields: [['x', { tag: 'null' }], ['x', { tag: 'null' }]] }] },
    { ...s, records: [{ ...s.records[0], fields: [['x', { tag: 'ref', value: { heapId: 'other', objectId: '0', ownerEpoch: '2' } }]] }, s.records[1]] },
    { ...s, records: [{ ...s.records[0], fields: [['x', { tag: 'ref', value: { heapId: 'heap:ledger', objectId: '9', ownerEpoch: '2' } }]] }, s.records[1]] },
  ];
  for (const bad of invalid) assert.throws(() => decodeRuntimeSnapshot(encodeCanonical(bad)));
  assert.deepEqual(encodeRuntimeSnapshot(s), encoded, 'failed validation does not mutate the original snapshot');
});
test('canonical identity rejects proxy-backed mutable data without executing traps', () => {
  let traps = 0;
  const record = new Proxy({ value: 1 }, { ownKeys: () => { traps++; throw new Error('trap'); }, getPrototypeOf: () => { traps++; throw new Error('trap'); }, get: () => { traps++; throw new Error('trap'); } });
  assert.throws(() => encodeCanonical(record), /proxy/);
  assert.throws(() => encodeCanonical({ nested: record }), /proxy/);
  assert.throws(() => encodeCanonical(new Proxy([], { get: () => { traps++; throw new Error('trap'); } })), /proxy/);
  assert.equal(traps, 0);
});
