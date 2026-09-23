import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { typeName, type SymbolId } from '../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { MACHINE_LIMITS, checkpointDigest, type MachineRecord } from '../../src/tier3/resumable-state.ts';
import { ResumableRuntime } from '../../src/tier3/resumable-runtime.ts';
import { PackedHeap, migratePackedHeap, migratePackedResumableCheckpoint, packResumableCheckpoint, unpackResumableCheckpoint, type PackedLayout, type PackedHeapImage } from '../../src/tier3/packed-heap.ts';

const nodeName = typeName('type:test:packed_node');
const nodeType = { t: 'Record' as const, name: nodeName, fields: [['number', b.Int], ['alive', b.Bool], ['link', b.Unit]] as const };
const layout: PackedLayout = { typeName: nodeName, fields: [
  { name: 'number', kind: 'int', min: '0', max: '1000', overflow: 'trap' },
  { name: 'alive', kind: 'bool' },
  { name: 'link', kind: 'ref', maxRelative: 3 },
] };
const val = (number: number, alive: boolean, link: MachineRecord['fields'][number][1]) => [
  ['number', { tag: 'int', value: String(number) }], ['alive', { tag: 'bool', value: alive }], ['link', link],
] as MachineRecord['fields'];
function rows(): MachineRecord[] {
  const ref = (id: string, epoch: string) => ({ tag: 'ref' as const, value: { heapId: 'heap:test', objectId: id, ownerEpoch: epoch } });
  return [
    { id: '7', epoch: '101', version: '2', ty: nodeType, fields: val(1000, true, ref('9', '103')) },
    { id: '8', epoch: '102', version: '0', ty: nodeType, fields: val(0, false, ref('9', '103')) },
    { id: '9', epoch: '103', version: '3', ty: nodeType, fields: val(512, true, ref('9', '103')) },
  ];
}
const rehash = (image: PackedHeapImage): PackedHeapImage => {
  const { imageDigest: _old, ...body } = image;
  return { ...body, imageDigest: domainDigest('aether.packed-heap-image/1', body, MACHINE_LIMITS) };
};
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('bit-packed records round-trip exact values, self-cycles, and two aliases to one target', () => {
  const original = rows(), heap = PackedHeap.pack(original, 'heap:test', [layout]);
  assert.deepEqual(plain(heap.unpack()), plain(original));
  assert.equal(heap.byteLength, 6); // 10 + 1 + 3 bits per row = 42 bits.
  assert.deepEqual(heap.get('7', 'link'), heap.get('8', 'link'));
  assert.deepEqual(plain(PackedHeap.fromImage(heap.image()).unpack()), plain(original));
  heap.set('7', 'number', { tag: 'int', value: '999' });
  heap.set('8', 'link', { tag: 'null' });
  assert.equal((heap.get('7', 'number') as { value: string }).value, '999');
  assert.deepEqual(heap.get('8', 'link'), { tag: 'null' });
  assert.equal((PackedHeap.fromImage(heap.image()).get('7', 'number') as { value: string }).value, '999');
});

test('bounds, offset, identity, epoch, padding, kind, and image corruption fail closed', () => {
  const original = rows(), heap = PackedHeap.pack(original, 'heap:test', [layout]), image = heap.image();
  let accessorCalled = false;
  const accessorRows = rows();
  Object.defineProperty(accessorRows, '0', { get() { accessorCalled = true; return original[0]; }, enumerable: true });
  assert.throws(() => PackedHeap.pack(accessorRows, 'heap:test', [layout]), /accessor/);
  assert.equal(accessorCalled, false);
  assert.throws(() => heap.set('7', 'number', { tag: 'int', value: '1001' }), /bound/);
  assert.throws(() => heap.set('7', 'number', { tag: 'string', value: '1' }), /kind/);
  assert.throws(() => heap.set('7', 'link', { tag: 'ref', value: { heapId: 'heap:other', objectId: '9', ownerEpoch: '103' } }), /stale/);
  assert.throws(() => heap.set('7', 'link', { tag: 'ref', value: { heapId: 'heap:test', objectId: '9', ownerEpoch: 'wrong' } }), /canonical decimal/);
  assert.throws(() => heap.set('7', 'link', { tag: 'ref', value: { heapId: 'heap:test', objectId: '9', ownerEpoch: '104' } }), /stale/);
  assert.throws(() => PackedHeap.pack(original, 'heap:test', [{ ...layout, fields: [{ ...layout.fields[0]!, kind: 'int' as const, min: '0', max: '1000', overflow: 'trap' as const }, layout.fields[1]!, { name: 'link', kind: 'ref', maxRelative: 0 }] }]), /bound/);
  assert.throws(() => PackedHeap.fromImage({ ...image, imageDigest: 'bad' as PackedHeapImage['imageDigest'] }), /digest/);
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, rows: image.rows.map((row, i) => i === 1 ? { ...row, bitOffset: 999 } : row) })), /offset/);
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, rows: image.rows.map((row, i) => i === 1 ? { ...row, id: '7' } : row) })), /identity/);
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, rows: image.rows.map((row, i) => i === 1 ? { ...row, epoch: '-1' } : row) })), /unsigned/);
  const extraRow = { ...image.rows[0], ignored: 'metadata' };
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, rows: [extraRow, ...image.rows.slice(1)] } as PackedHeapImage)), /unknown, missing or accessor/);
  const extraLayout = { ...layout, ignored: 'metadata' };
  const extraLayouts = [extraLayout];
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, layouts: extraLayouts,
    layoutDigest: domainDigest('aether.packed-layout/1', extraLayouts) } as PackedHeapImage)), /unknown, missing or accessor/);
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, ignored: 'metadata' } as PackedHeapImage)), /unknown, missing or accessor/);
  let getterCalled = false;
  const accessor = { ...image };
  Object.defineProperty(accessor, 'format', { get() { getterCalled = true; return 'aether.packed-heap/1'; }, enumerable: true });
  assert.throws(() => PackedHeap.fromImage(accessor), /unknown, missing or accessor/); assert.equal(getterCalled, false);
  const padded = Buffer.from(image.bytes, 'base64'); padded[padded.length - 1] |= 0b1000_0000;
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, bytes: padded.toString('base64') })), /padding/);
  const invalidCode = Buffer.from(image.bytes, 'base64'); invalidCode[0] = 0xff; invalidCode[1] |= 0b11;
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, bytes: invalidCode.toString('base64') })), /bit pattern/);
  assert.throws(() => PackedHeap.fromImage({ ...image, format: 'aether.packed-heap/2' as PackedHeapImage['format'] }), /image/);
});

test('constant bounded field uses zero payload bits and refuses any other value', () => {
  const name = typeName('type:test:constant');
  const ty = { t: 'Record' as const, name, fields: [['number', b.Int]] as const };
  const constant: PackedLayout = { typeName: name, fields: [{ name: 'number', kind: 'int', min: '7', max: '7', overflow: 'trap' }] };
  const heap = PackedHeap.pack([{ id: '1', epoch: '1', version: '0', ty, fields: [['number', { tag: 'int', value: '7' }]] }], 'heap:constant', [constant]);
  assert.equal(heap.byteLength, 0);
  assert.equal((PackedHeap.fromImage(heap.image()).get('1', 'number') as { value: string }).value, '7');
  assert.throws(() => heap.set('1', 'number', { tag: 'int', value: '8' }), /bound/);
});

test('bounded arithmetic obeys trap, wrap and saturate without partial mutation', () => {
  const base = rows();
  for (const [overflow, expected] of [['wrap', '0'], ['saturate', '1000']] as const) {
    const heap = PackedHeap.pack(base, 'heap:test', [{ ...layout, fields: [{ name: 'number', kind: 'int', min: '0', max: '1000', overflow }, ...layout.fields.slice(1)] }]);
    heap.add('7', 'number', 1n); assert.equal((heap.get('7', 'number') as { value: string }).value, expected);
    heap.add('8', 'number', -1n); assert.equal((heap.get('8', 'number') as { value: string }).value, overflow === 'wrap' ? '1000' : '0');
  }
  const trap = PackedHeap.pack(base, 'heap:test', [layout]), before = trap.image();
  assert.throws(() => trap.add('7', 'number', 1n), /overflow/);
  assert.deepEqual(trap.image(), before);
});

test('new layout migration preserves logical rows; narrow migration rejects out-of-bounds values', () => {
  const source = PackedHeap.pack(rows(), 'heap:test', [layout]).image();
  const wider: PackedLayout = { ...layout, fields: [{ name: 'number', kind: 'int', min: '-1000', max: '2000', overflow: 'trap' }, ...layout.fields.slice(1)] };
  const migrated = migratePackedHeap(source, [wider]);
  assert.notEqual(migrated.layoutDigest, source.layoutDigest);
  assert.deepEqual(plain(PackedHeap.fromImage(migrated).unpack()), plain(rows()));
  assert.throws(() => migratePackedHeap(source, [{ ...layout, fields: [{ name: 'number', kind: 'int', min: '0', max: '500', overflow: 'trap' }, ...layout.fields.slice(1)] }]), /bound/);
  assert.throws(() => PackedHeap.fromImage(migrated, source.layoutDigest), /digest/);
});

test('deterministic 256-row differential preserves random aliases and mutations', () => {
  let seed = 0x72a16c35;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const records: MachineRecord[] = Array.from({ length: 256 }, (_, index) => {
    const target = (next() % 256) + 1;
    return { id: String(index + 1), epoch: '7', version: '0', ty: nodeType, fields: val(next() % 1001, !!(next() & 1),
      { tag: 'ref', value: { heapId: 'heap:test', objectId: String(target), ownerEpoch: '7' } }) };
  });
  const wide: PackedLayout = { ...layout, fields: [...layout.fields.slice(0, 2), { name: 'link', kind: 'ref', maxRelative: 255 }] };
  const heap = PackedHeap.pack(records, 'heap:test', [wide]);
  assert.deepEqual(plain(heap.unpack()), plain(records));
  for (let iteration = 0; iteration < 256; iteration++) {
    const row = records[next() % records.length], number = next() % 1001, target = records[next() % records.length];
    heap.set(row.id, 'number', { tag: 'int', value: String(number) });
    heap.set(row.id, 'link', { tag: 'ref', value: { heapId: 'heap:test', objectId: target.id, ownerEpoch: target.epoch } });
    row.fields[0][1] = { tag: 'int', value: String(number) };
    row.fields[2][1] = { tag: 'ref', value: { heapId: 'heap:test', objectId: target.id, ownerEpoch: target.epoch } };
  }
  assert.deepEqual(plain(PackedHeap.fromImage(heap.image()).unpack()), plain(records));
});

function runtimeFixture() {
  const symbols = new SymbolSpace('packed-runtime'), entry = symbols.define('entry');
  const declaration = b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [declaration], symbolTable: symbols.table() });
  const store = new GraphStore(), d = (name: string) => domainDigest('aether.packed-test/1', name);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module), specRoot: d('spec'), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'), target: { abiVersion: 'resumable/1', profileDigest: d('target'), artifactDigest: d('artifact') }, capabilityPolicyDigest: d('caps'), evidencePolicyDigest: d('evidence') };
  const options = { manifest, registry: new CapabilityRegistry(), executionId: 'packed-execution', authorizeCorrection: () => true };
  return { runtime: () => new ResumableRuntime(module, options), entry: entry as SymbolId };
}

test('real resumable runtime checkpoint packs, unpacks, restores, and retains aliases after correction', () => {
  const fixture = runtimeFixture(), runtime = fixture.runtime();
  const a = runtime.allocateRecord(nodeType, { number: 1n, alive: true, link: null });
  const bRef = runtime.allocateRecord(nodeType, { number: 2n, alive: false, link: null });
  runtime.correctRecord(a, 'link', bRef); runtime.correctRecord(bRef, 'link', a);
  const before = runtime.snapshot(), expected = checkpointDigest(before);
  const packed = packResumableCheckpoint(before, runtime.program, [layout]);
  assert.equal(packed.snapshotDigest, expected);
  const restored = unpackResumableCheckpoint(packed, runtime.program, expected), resumed = fixture.runtime();
  assert.deepEqual(plain(restored), plain(before));
  const wider: PackedLayout = { ...layout, fields: [{ name: 'number', kind: 'int', min: '-1000', max: '2000', overflow: 'trap' }, ...layout.fields.slice(1)] };
  const migrated = migratePackedResumableCheckpoint(packed, runtime.program, expected, [wider]);
  assert.notEqual(migrated.heap.layoutDigest, packed.heap.layoutDigest);
  assert.deepEqual(plain(unpackResumableCheckpoint(migrated, runtime.program, expected)), plain(before));
  resumed.restore(restored, expected);
  assert.deepEqual(resumed.readRecord(a).get('link'), bRef);
  assert.deepEqual(resumed.readRecord(bRef).get('link'), a);
  resumed.correctRecord(a, 'number', 3n);
  const corrected = resumed.snapshot(); assert.deepEqual(plain(unpackResumableCheckpoint(packResumableCheckpoint(corrected, resumed.program, [layout]), resumed.program, checkpointDigest(corrected))), plain(corrected));
  assert.throws(() => unpackResumableCheckpoint({ ...packed, snapshotDigest: domainDigest('aether.packed-test/1', 'wrong') }, runtime.program, expected), /trusted digest/);
  assert.throws(() => unpackResumableCheckpoint({ ...packed, format: 'aether.packed-resumable-checkpoint/2' as typeof packed.format }, runtime.program, expected), /version/);
});
