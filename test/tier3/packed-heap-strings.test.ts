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
import { PackedHeap, migratePackedHeap, migratePackedResumableCheckpoint, packResumableCheckpoint, unpackResumableCheckpoint, type PackedHeapImage, type PackedLayout } from '../../src/tier3/packed-heap.ts';

const name = typeName('type:test:packed_string_node');
const ty = { t: 'Record' as const, name, fields: [['text', b.Str], ['copy', b.Str], ['link', b.Unit]] as const };
const layout: PackedLayout = { typeName: name, fields: [
  { name: 'text', kind: 'string', maxUtf8Bytes: 32 },
  { name: 'copy', kind: 'string', maxUtf8Bytes: 32 },
  { name: 'link', kind: 'ref', maxRelative: 4 },
] };
const ref = (objectId: string) => ({ tag: 'ref' as const, value: { heapId: 'heap:strings', objectId, ownerEpoch: '3' } });
const values = (text: string, copy: string, link: MachineRecord['fields'][number][1]): MachineRecord['fields'] => [
  ['text', { tag: 'string', value: text }], ['copy', { tag: 'string', value: copy }], ['link', link],
];
const rows = (): MachineRecord[] => [
  { id: '1', epoch: '3', version: '0', ty, fields: values('é', '🙂', ref('3')) },
  { id: '2', epoch: '3', version: '1', ty, fields: values('🙂', 'é', ref('3')) },
  { id: '3', epoch: '3', version: '2', ty, fields: values('', 'e\u0301', ref('3')) },
];
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const rehash = (image: PackedHeapImage): PackedHeapImage => {
  const { imageDigest: _old, ...body } = image;
  return { ...body, imageDigest: domainDigest('aether.packed-heap-image/2', body, MACHINE_LIMITS) };
};

test('v2 UTF-8 dictionary round-trips distinct bytes, duplicate values, aliases, and canonical v1 shape', () => {
  const original = rows(), heap = PackedHeap.pack(original, 'heap:strings', [layout]);
  const image = heap.image();
  assert.equal(image.format, 'aether.packed-heap/2');
  assert.deepEqual(image.stringEntries, [{ offset: 0, length: 2 }, { offset: 2, length: 4 }, { offset: 6, length: 0 }, { offset: 6, length: 3 }]);
  assert.equal(Buffer.from(image.stringBytes!, 'base64').toString('utf8'), 'é🙂e\u0301');
  assert.deepEqual(plain(PackedHeap.fromImage(image, image.layoutDigest).unpack()), plain(original));
  assert.deepEqual(heap.get('1', 'link'), heap.get('2', 'link'));
  assert.notDeepEqual(heap.get('1', 'text'), heap.get('3', 'copy')); // NFC is not silently substituted for NFD.
  heap.set('3', 'text', { tag: 'string', value: '\ufefflead' });
  assert.deepEqual(PackedHeap.fromImage(heap.image()).get('3', 'text'), { tag: 'string', value: '\ufefflead' });
  const v1 = PackedHeap.pack([{ id: '1', epoch: '3', version: '0', ty: { t: 'Record', name: typeName('type:test:v1'), fields: [['flag', b.Bool]] }, fields: [['flag', { tag: 'bool', value: true }]] }],
    'heap:strings', [{ typeName: typeName('type:test:v1'), fields: [{ name: 'flag', kind: 'bool' }] }]).image();
  assert.equal(v1.format, 'aether.packed-heap/1');
  assert.deepEqual(Object.keys(v1).sort(), ['bytes', 'format', 'heapId', 'imageDigest', 'layoutDigest', 'layouts', 'rows'].sort());
  assert.deepEqual(plain(PackedHeap.fromImage(v1).image()), plain(v1));
});

test('string mutation compacts dictionary and rejects oversize or malformed Unicode without changing state', () => {
  const heap = PackedHeap.pack(rows(), 'heap:strings', [layout]);
  heap.set('1', 'text', { tag: 'string', value: '新しい' });
  assert.equal((heap.get('1', 'text') as { value: string }).value, '新しい');
  assert.equal(heap.image().stringEntries?.length, 5);
  heap.set('1', 'text', { tag: 'string', value: '🙂' });
  assert.equal(heap.image().stringEntries?.length, 4);
  const before = heap.image();
  assert.throws(() => heap.set('1', 'text', { tag: 'string', value: 'é'.repeat(17) }), /overlong/);
  assert.throws(() => heap.set('1', 'text', { tag: 'string', value: '\ud800' }), /UTF-8/);
  assert.throws(() => heap.set('1', 'text', { tag: 'int', value: '1' }), /kind/);
  assert.deepEqual(heap.image(), before);
  assert.deepEqual(plain(PackedHeap.fromImage(before).unpack()), plain(heap.unpack()));
});

test('dictionary and per-field UTF-8 limits reject excess without partial output', () => {
  const onlyText: PackedLayout = { typeName: name, fields: [{ name: 'text', kind: 'string', maxUtf8Bytes: 32 }, { name: 'copy', kind: 'string', maxUtf8Bytes: 32 }, { name: 'link', kind: 'ref', maxRelative: 0 }] };
  const many: MachineRecord[] = Array.from({ length: 4097 }, (_, i) => ({
    id: String(i + 1), epoch: '3', version: '0', ty,
    fields: values(`item-${i}`, `item-${i}`, { tag: 'null' }),
  }));
  const atLimit = PackedHeap.pack(many.slice(0, 4096), 'heap:strings', [onlyText]);
  assert.equal(atLimit.image().stringEntries?.length, 4096);
  assert.deepEqual(atLimit.get('4096', 'text'), { tag: 'string', value: 'item-4095' });
  assert.throws(() => PackedHeap.pack(many, 'heap:strings', [onlyText]), /dictionary limit/);
  assert.throws(() => PackedHeap.pack(rows(), 'heap:strings', [{ ...layout, fields: [{ name: 'text', kind: 'string', maxUtf8Bytes: 4097 }, ...layout.fields.slice(1)] }]), /bound/);
  assert.throws(() => PackedHeap.pack(rows(), 'heap:strings', [{ ...layout, fields: [{ name: 'text', kind: 'string', maxUtf8Bytes: -1 }, ...layout.fields.slice(1)] }]), /bound/);
});

test('v2 rejects wrong offsets, malformed UTF-8, invalid codes, bounds, duplicate dictionary entries, and altered digests', () => {
  const image = PackedHeap.pack(rows(), 'heap:strings', [layout]).image();
  assert.throws(() => PackedHeap.fromImage({ ...image, stringBytes: 'AA==' }), /digest/);
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, stringEntries: image.stringEntries!.map((entry, i) => i === 1 ? { ...entry, offset: 99 } : entry) })), /offset/);
  const badUtf8 = Buffer.from(image.stringBytes!, 'base64'); badUtf8[0] = 0xc0; badUtf8[1] = 0xaf;
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, stringBytes: badUtf8.toString('base64') })), /encoded data|UTF-8/);
  const badCode = Buffer.from(image.bytes, 'base64'); badCode[0] = 0xff; badCode[1] |= 0x0f;
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, bytes: badCode.toString('base64') })), /dictionary index/);
  const narrow = { ...layout, fields: [{ name: 'text', kind: 'string' as const, maxUtf8Bytes: 1 }, ...layout.fields.slice(1)] };
  assert.throws(() => PackedHeap.pack(rows(), 'heap:strings', [narrow]), /overlong/);
  const duplicate = Buffer.from(image.stringBytes!, 'base64'); duplicate.set(Buffer.from('é'), 2);
  const entries = image.stringEntries!.map((entry, i) => i === 1 ? { ...entry, length: 2 } : i === 2 ? { ...entry, offset: 4 } : i === 3 ? { ...entry, offset: 4 } : entry);
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, stringEntries: entries, stringBytes: duplicate.subarray(0, duplicate.length - 2).toString('base64') })), /duplicate|offset|UTF-8/);
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, stringEntries: [...image.stringEntries!, { offset: 9, length: 0 }] })), /duplicate|order or unused entry/);
  assert.throws(() => PackedHeap.fromImage({ ...image, format: 'aether.packed-heap/1' }), /version/);
  assert.throws(() => PackedHeap.fromImage(rehash({ ...image, stringBytes: `${image.stringBytes!}=` })), /digest|base64/);
});

test('seeded 256-row string differential and layout migration preserve logical values', () => {
  let seed = 0x6d4aa921;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const pool = ['', 'a', 'é', '🙂', '漢字', 'e\u0301'];
  const original: MachineRecord[] = Array.from({ length: 256 }, (_, index) => ({
    id: String(index + 1), epoch: '3', version: '0', ty,
    fields: values(pool[next() % pool.length], pool[next() % pool.length], ref(String(next() % 256 + 1))),
  }));
  const wide: PackedLayout = { ...layout, fields: [...layout.fields.slice(0, 2), { name: 'link', kind: 'ref', maxRelative: 255 }] };
  const heap = PackedHeap.pack(original, 'heap:strings', [wide]);
  for (let i = 0; i < 256; i++) {
    const row = original[next() % 256], value = pool[next() % pool.length];
    heap.set(row.id, 'text', { tag: 'string', value }); row.fields[0][1] = { tag: 'string', value };
  }
  assert.deepEqual(plain(PackedHeap.fromImage(heap.image()).unpack()), plain(original));
  const grown = { ...wide, fields: [{ name: 'text', kind: 'string' as const, maxUtf8Bytes: 64 }, ...wide.fields.slice(1)] };
  const migrated = migratePackedHeap(heap.image(), [grown]);
  assert.notEqual(migrated.layoutDigest, heap.image().layoutDigest);
  assert.deepEqual(plain(PackedHeap.fromImage(migrated).unpack()), plain(original));
  const tooNarrow = { ...wide, fields: [{ name: 'text', kind: 'string' as const, maxUtf8Bytes: 1 }, ...wide.fields.slice(1)] };
  assert.throws(() => migratePackedHeap(migrated, [tooNarrow]), /overlong/);
});

function runtimeFixture() {
  const symbols = new SymbolSpace('packed-string-runtime'), entry = symbols.define('entry');
  const declaration = b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [declaration], symbolTable: symbols.table() });
  const store = new GraphStore(), d = (label: string) => domainDigest('aether.packed-string-test/1', label);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module), specRoot: d('spec'), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'), target: { abiVersion: 'resumable/1', profileDigest: d('target'), artifactDigest: d('artifact') }, capabilityPolicyDigest: d('caps'), evidencePolicyDigest: d('evidence') };
  const options = { manifest, registry: new CapabilityRegistry(), executionId: 'packed-string-execution', authorizeCorrection: () => true };
  return { runtime: () => new ResumableRuntime(module, options), entry: entry as SymbolId };
}

test('real resumable v2 checkpoint restores strings and aliases; rehashed dictionary tamper fails trusted logical digest', () => {
  const fixture = runtimeFixture(), runtime = fixture.runtime();
  const first = runtime.allocateRecord(ty, { text: 'é', copy: '🙂', link: null });
  const second = runtime.allocateRecord(ty, { text: '🙂', copy: 'e\u0301', link: null });
  runtime.correctRecord(first, 'link', second); runtime.correctRecord(second, 'link', first);
  const before = runtime.snapshot(), expected = checkpointDigest(before), packed = packResumableCheckpoint(before, runtime.program, [layout]);
  assert.equal(packed.format, 'aether.packed-resumable-checkpoint/2');
  const restored = unpackResumableCheckpoint(packed, runtime.program, expected, packed.heap.layoutDigest);
  assert.deepEqual(plain(restored), plain(before));
  const resumed = fixture.runtime(); resumed.restore(restored, expected);
  assert.equal(resumed.readRecord(first).get('text'), 'é');
  assert.deepEqual(resumed.readRecord(first).get('link'), second);
  assert.deepEqual(resumed.readRecord(second).get('link'), first);
  const grown = { ...layout, fields: [{ name: 'text', kind: 'string' as const, maxUtf8Bytes: 64 }, ...layout.fields.slice(1)] };
  const migrated = migratePackedResumableCheckpoint(packed, runtime.program, expected, [grown]);
  assert.deepEqual(plain(unpackResumableCheckpoint(migrated, runtime.program, expected)), plain(before));
  const arena = Buffer.from(packed.heap.stringBytes!, 'base64'); arena[0] = 0x61; arena[1] = 0x62;
  const altered = { ...packed, heap: rehash({ ...packed.heap, stringBytes: arena.toString('base64') }) };
  assert.throws(() => unpackResumableCheckpoint(altered, runtime.program, expected), /event head|logical digest/);
  assert.throws(() => unpackResumableCheckpoint({ ...packed, format: 'aether.packed-resumable-checkpoint/1' }, runtime.program, expected), /version/);
});
