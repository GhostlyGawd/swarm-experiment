import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as b from '../../../../src/tier1/build.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { typeName } from '../../../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';
import { checkpointDigest } from '../../../../src/tier3/resumable-state.ts';
import { ResumableRuntime } from '../../../../src/tier3/resumable-runtime.ts';
import { PackedHeap, packResumableCheckpoint, unpackResumableCheckpoint, type PackedHeapImage, type PackedLayout } from '../../../../src/tier3/packed-heap.ts';
import { executePackedCheckpointNative, type NativeOperation } from './bridge.ts';

const directory = new URL('.', import.meta.url);
const root = fileURLToPath(new URL('../../../..', directory));
const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const name = typeName('type:test:native_string_node');
const ty = { t: 'Record' as const, name, fields: [['text', b.Str], ['copy', b.Str], ['flag', b.Bool], ['link', b.Unit], ['number', b.Int]] as const };
const layout: PackedLayout = { typeName: name, fields: [
  { name: 'text', kind: 'string', maxUtf8Bytes: 32 },
  { name: 'copy', kind: 'string', maxUtf8Bytes: 32 },
  { name: 'flag', kind: 'bool' },
  { name: 'link', kind: 'ref', maxRelative: 15 },
  { name: 'number', kind: 'int', min: '0', max: '1000', overflow: 'trap' },
] };

function fixture() {
  const symbols = new SymbolSpace('native-strings'), entry = symbols.define('entry');
  const declaration = b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [declaration], symbolTable: symbols.table() });
  const store = new GraphStore(), digest = (label: string) => domainDigest('aether.native-strings-test/1', label);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module),
    specRoot: digest('spec'), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'),
    target: { abiVersion: 'resumable/1', profileDigest: digest('target'), artifactDigest: digest('artifact') },
    capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence') };
  return new ResumableRuntime(module, { manifest, registry: new CapabilityRegistry(), executionId: 'native-strings', authorizeCorrection: () => true });
}
function compiled(folder: string) {
  const executable = join(folder, 'native');
  execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
    new URL('native.c', directory).pathname, new URL('../packed-heap/abi.c', directory).pathname, '-o', executable]);
  return { executable, expectedExecutableSha256: sha256(readFileSync(executable)) };
}

test('authenticated /2 checkpoint gives exact UTF-8 reads, byte equality, and mixed reference reads', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aether-native-strings-'));
  try {
    const binary = compiled(folder), runtime = fixture();
    const first = runtime.allocateRecord(ty, { text: 'é', copy: '🙂', flag: true, link: null, number: 5n });
    const second = runtime.allocateRecord(ty, { text: '🙂', copy: 'e\u0301', flag: false, link: null, number: 7n });
    const third = runtime.allocateRecord(ty, { text: '', copy: '\ufefflead', flag: true, link: null, number: 0n });
    runtime.correctRecord(first, 'link', second);
    const snapshot = runtime.snapshot(), expectedSnapshotDigest = checkpointDigest(snapshot);
    const packed = packResumableCheckpoint(snapshot, runtime.program, [layout]);
    assert.equal(packed.format, 'aether.packed-resumable-checkpoint/2');
    const run = (operations: NativeOperation[]) => executePackedCheckpointNative({ packed, program: runtime.program,
      expectedSnapshotDigest, expectedLayoutDigest: packed.heap.layoutDigest, ...binary, operations });
    const result = run([
      { kind: 'readString', id: String(first.addr), field: 'text' },
      { kind: 'readString', id: String(second.addr), field: 'copy' },
      { kind: 'readString', id: String(third.addr), field: 'text' },
      { kind: 'readString', id: String(third.addr), field: 'copy' },
      { kind: 'equalString', id: String(first.addr), field: 'copy', otherId: String(second.addr), otherField: 'text' },
      { kind: 'equalString', id: String(first.addr), field: 'text', otherId: String(second.addr), otherField: 'copy' },
      { kind: 'readBool', id: String(first.addr), field: 'flag' },
      { kind: 'readRef', id: String(first.addr), field: 'link' },
      { kind: 'readInt', id: String(first.addr), field: 'number' },
    ]);
    assert.equal(result.format, 'aether.packed-native-bridge-result/2');
    assert.deepEqual(result.observations, [
      'T 0 c3a9', 'T 0 65cc81', 'T 0 -', 'T 0 efbbbf6c656164', 'E 0 1', 'E 0 0',
      'B 0 1', `R 0 0 ${second.addr} ${second.ownerEpoch}`, 'i 0 5',
    ]);
    assert.deepEqual(result.candidateHeap, packed.heap);
    assert.deepEqual(PackedHeap.fromImage(result.candidateHeap).unpack(), PackedHeap.fromImage(packed.heap).unpack());
    const changed = run([{ kind: 'addInt', id: String(first.addr), field: 'number', increment: '10' },
      { kind: 'readString', id: String(first.addr), field: 'text' }]);
    assert.deepEqual(changed.observations, ['I 0 15', 'T 0 c3a9']);
    assert.deepEqual(changed.candidateHeap.stringEntries, packed.heap.stringEntries);
    assert.equal(changed.candidateHeap.stringBytes, packed.heap.stringBytes);
    assert.deepEqual(PackedHeap.fromImage(changed.candidateHeap).get(String(first.addr), 'number'), { tag: 'int', value: '15' });
    assert.throws(() => unpackResumableCheckpoint({ ...packed, heap: changed.candidateHeap }, runtime.program, expectedSnapshotDigest),
      /checkpoint|digest|event/);
    assert.throws(() => run([{ kind: 'equalString', id: String(first.addr), field: 'text', otherId: String(second.addr), otherField: 'flag' }]), /requires string/);
    assert.throws(() => run([{ kind: 'readString', id: String(first.addr), field: 'flag' }]), /unsupported native operation/);
    assert.throws(() => executePackedCheckpointNative({ packed, program: runtime.program, expectedSnapshotDigest: domainDigest('wrong', 'snapshot'),
      expectedLayoutDigest: packed.heap.layoutDigest, ...binary, operations: [] }), /digest|checkpoint/);
    assert.throws(() => executePackedCheckpointNative({ packed, program: runtime.program, expectedSnapshotDigest,
      expectedLayoutDigest: domainDigest('wrong', 'layout'), ...binary, operations: [] }), /digest/);
    assert.throws(() => executePackedCheckpointNative({ packed, program: runtime.program, expectedSnapshotDigest,
      expectedLayoutDigest: packed.heap.layoutDigest, ...binary, expectedExecutableSha256: 'sha256:wrong', operations: [] }), /executable digest/);
    const tampered: PackedHeapImage = { ...packed.heap, stringBytes: 'YQ==' };
    assert.throws(() => executePackedCheckpointNative({ packed: { ...packed, heap: tampered }, program: runtime.program,
      expectedSnapshotDigest, expectedLayoutDigest: packed.heap.layoutDigest, ...binary, operations: [] }), /digest/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('compiled /2 parser rejects corrupt dictionary offsets, UTF-8, indexes, bounds, and mixed-version commands', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aether-native-string-frame-'));
  try {
    const { executable } = compiled(folder);
    const frame = (bytes: string, entry: string, arena: string, op: string, suffix = '') =>
      `AEPBR002 1 2 12 1 1 1\n${bytes}\n1 0 0 12\n${entry}\n${arena}\n${op}\n${suffix}`;
    assert.equal(execFileSync(executable, { input: frame('0000', '0 1', '61', 'T 0 0 12 1'), encoding: 'utf8' }).trim(), 'T 0 61\nH 0000');
    const invalid = [
      frame('0000', '1 1', '61', 'T 0 0 12 1'), // non-contiguous dictionary
      frame('0000', '0 2', '61', 'T 0 0 12 1'), // overrun
      frame('0000', '0 1', 'ff', 'T 0 0 12 1'), // invalid UTF-8
      frame('0100', '0 1', '61', 'T 0 0 12 1'), // missing ordinal
      frame('0000', '0 1', '61', 'T 0 0 12 0'), // field bound
      frame('0000', '0 1', '61', 'T 0 0 11 1'), // string width
      frame('0000', '0 1', '61', 'T 0 1 12 1'), // field outside row
      frame('0000', '0 1', '61', 'E 0 0 12 1 0 1 12 1'), // comparison field outside row
      frame('0000', '0 1', '61', 'T 0 0 12 1', 'junk'), // trailing frame data
      'AEPBR001 1 2 12 1\n0000\n1 0 0 12\nT 0 0 12 1\n', // /2 operation in /1
    ];
    for (const [index, input] of invalid.entries()) assert.throws(() => execFileSync(executable,
      { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }), `corrupt frame ${index}`);
    const duplicate = 'AEPBR002 1 2 12 0 2 2\n0000\n1 0 0 12\n0 1\n1 1\n6161\n';
    assert.throws(() => execFileSync(executable, { input: duplicate, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }));
    for (const badUtf8 of ['c0af', 'eda080', 'f4908080', 'e282', '80']) {
      const length = badUtf8.length / 2;
      const input = `AEPBR002 1 2 12 1 1 ${length}\n0000\n1 0 0 12\n0 ${length}\n${badUtf8}\nT 0 0 12 4\n`;
      assert.throws(() => execFileSync(executable,
        { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }), `invalid UTF-8 ${badUtf8}`);
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('seeded /2 native differential retains raw observations and process latency samples', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aether-native-strings-campaign-'));
  try {
    const binary = compiled(folder), runtime = fixture();
    let seed = 0x6c327a91;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const pool = ['', 'a', 'é', '🙂', '漢字', 'e\u0301', '\ufefflead'];
    const refs = Array.from({ length: 16 }, (_, index) => runtime.allocateRecord(ty,
      { text: pool[next() % pool.length], copy: pool[next() % pool.length], flag: !!(index & 1), link: null, number: BigInt(index) }));
    const snapshot = runtime.snapshot(), expectedSnapshotDigest = checkpointDigest(snapshot);
    const packed = packResumableCheckpoint(snapshot, runtime.program, [layout]);
    const operations: NativeOperation[] = [];
    for (let step = 0; step < 256; step++) {
      const id = String(refs[next() % refs.length].addr), otherId = String(refs[next() % refs.length].addr);
      if (step % 4 === 0) operations.push({ kind: 'readString', id, field: 'text' });
      else if (step % 4 === 1) operations.push({ kind: 'readString', id, field: 'copy' });
      else operations.push({ kind: 'equalString', id, field: 'text', otherId, otherField: step % 4 === 2 ? 'text' : 'copy' });
    }
    const run = () => executePackedCheckpointNative({ packed, program: runtime.program,
      expectedSnapshotDigest, expectedLayoutDigest: packed.heap.layoutDigest, ...binary, operations });
    const first = run();
    assert.equal(first.observations.length, 256);
    assert.deepEqual(first.candidateHeap, packed.heap);
    const samplesNs: number[] = [];
    for (let sample = 0; sample < 30; sample++) {
      const start = process.hrtime.bigint(), result = run();
      samplesNs.push(Number(process.hrtime.bigint() - start));
      assert.deepEqual(result.observations, first.observations);
      assert.deepEqual(result.candidateHeap, packed.heap);
    }
    const evidencePath = process.env.AETHER_PACKED_NATIVE_STRING_EVIDENCE;
    if (evidencePath) {
      const paths = [
        'roadmap/v4/research/packed-native-bridge/native.c',
        'roadmap/v4/research/packed-native-bridge/bridge.ts',
        'roadmap/v4/research/packed-native-bridge/bridge-strings.test.ts',
        'roadmap/v4/research/packed-heap/abi.c',
        'roadmap/v4/research/packed-heap/abi.h',
        'src/tier3/packed-heap.ts',
        'src/tier3/resumable-state.ts',
      ];
      const sorted = [...samplesNs].sort((a, b) => a - b);
      const report = { format: 'aether.packed-native-string-differential/2',
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        sources: paths.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
        executableSha256: binary.expectedExecutableSha256,
        compiler: execFileSync('cc', ['--version'], { encoding: 'utf8' }).split('\n')[0],
        environment: { platform: platform(), architecture: arch(), osRelease: release(), cpu: cpus()[0]?.model, node: process.version },
        registration: { seed: '0x6c327a91', generator: 'xorshift32', records: 16, operations: 256, samples: 30 },
        inputSnapshotDigest: expectedSnapshotDigest, inputImageDigest: packed.heap.imageDigest,
        layoutDigest: packed.heap.layoutDigest, candidateImageDigest: first.candidateHeap.imageDigest,
        operations, observations: first.observations, samplesNs,
        latencyNs: { median: (sorted[14] + sorted[15]) / 2, maximum: sorted[29] },
      };
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
