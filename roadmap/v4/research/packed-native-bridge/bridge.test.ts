import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as b from '../../../../src/tier1/build.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { typeName } from '../../../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { domainDigest, type Digest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';
import { checkpointDigest } from '../../../../src/tier3/resumable-state.ts';
import { ResumableRuntime } from '../../../../src/tier3/resumable-runtime.ts';
import { PackedHeap, packResumableCheckpoint, unpackResumableCheckpoint, type PackedLayout } from '../../../../src/tier3/packed-heap.ts';
import { executePackedCheckpointNative } from './bridge.ts';

const directory = new URL('.', import.meta.url);
const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const nodeName = typeName('type:test:packed_native_node');
const nodeType = { t: 'Record' as const, name: nodeName,
  fields: [['number', b.Int], ['alive', b.Bool], ['link', b.Unit]] as const };
const layout: PackedLayout = { typeName: nodeName, fields: [
  { name: 'number', kind: 'int', min: '0', max: '1000', overflow: 'trap' },
  { name: 'alive', kind: 'bool' },
  { name: 'link', kind: 'ref', maxRelative: 3 },
] };

function runtimeFixture(authorization?: { value: Digest | null }) {
  const symbols = new SymbolSpace('packed-native'), entry = symbols.define('entry');
  const declaration = b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [declaration], symbolTable: symbols.table() });
  const store = new GraphStore(), digest = (name: string) => domainDigest('aether.packed-native-test/1', name);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module),
    specRoot: digest('spec'), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'),
    target: { abiVersion: 'resumable/1', profileDigest: digest('target'), artifactDigest: digest('artifact') },
    capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence') };
  return new ResumableRuntime(module, { manifest, registry: new CapabilityRegistry(),
    executionId: 'packed-native-execution', authorizeCorrection: () => true,
    authorizePackedCandidate: authorization ? (_snapshot, subject) => subject.candidateImageDigest === authorization.value : undefined });
}
function fixture(authorization?: { value: Digest | null }) {
  const runtime = runtimeFixture(authorization);
  const a = runtime.allocateRecord(nodeType, { number: 1000n, alive: true, link: null });
  const bRef = runtime.allocateRecord(nodeType, { number: 5n, alive: false, link: null });
  const c = runtime.allocateRecord(nodeType, { number: 7n, alive: true, link: null });
  runtime.correctRecord(bRef, 'link', a);
  runtime.correctRecord(c, 'link', a);
  runtime.correctRecord(a, 'link', c);
  return { runtime, a, bRef, c };
}

test('actual /1 C mutation enters one authorized, replayable packed correction event', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aether-packed-native-commit-'));
  try {
    const executable = join(folder, 'native');
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      new URL('native.c', directory).pathname, new URL('../packed-heap/abi.c', directory).pathname, '-o', executable]);
    const authorization = { value: null as Digest | null };
    const runtime = runtimeFixture(authorization);
    const bRef = runtime.allocateRecord(nodeType, { number: 5n, alive: false, link: null });
    const original = runtime.snapshot(), sourceDigest = checkpointDigest(original);
    const packed = packResumableCheckpoint(original, runtime.program, [layout]);
    const result = executePackedCheckpointNative({ packed, program: runtime.program,
      expectedSnapshotDigest: sourceDigest, expectedLayoutDigest: packed.heap.layoutDigest,
      executable, expectedExecutableSha256: sha256(readFileSync(executable)), operations: [
        { kind: 'addInt', id: String(bRef.addr), field: 'number', increment: '10' },
      ] });
    assert.deepEqual(result.observations, ['I 0 15']);
    assert.equal(checkpointDigest(runtime.snapshot()), sourceDigest);
    assert.throws(() => runtime.commitPackedCandidate(packed, result.candidateHeap, sourceDigest, packed.heap.layoutDigest), /did not authorize/);
    assert.equal(checkpointDigest(runtime.snapshot()), sourceDigest);
    authorization.value = result.candidateHeap.imageDigest;
    const receipt = runtime.commitPackedCandidate(packed, result.candidateHeap, sourceDigest, packed.heap.layoutDigest);
    assert.equal(receipt.changedFields, 1);
    const after = runtime.snapshot();
    assert.equal(checkpointDigest(after), receipt.snapshotDigest);
    assert.equal(after.events.length, original.events.length + 1);
    assert.equal(after.events.at(-1)?.op, `packed-correction:${receipt.subjectDigest}`);
    assert.equal(runtime.readRecord(bRef).get('number'), 15n);
    const reopened = runtimeFixture();
    reopened.restore(after, receipt.snapshotDigest);
    assert.equal(reopened.readRecord(bRef).get('number'), 15n);
    reopened.rewind(1);
    assert.equal(checkpointDigest(reopened.snapshot()), sourceDigest);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('real packed checkpoint enters native executable, preserves aliases, and matches host correction', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aether-packed-native-'));
  try {
    const executable = join(folder, 'native');
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      new URL('native.c', directory).pathname,
      new URL('../packed-heap/abi.c', directory).pathname, '-o', executable]);
    const executableDigest = sha256(readFileSync(executable));
    const { runtime, a, bRef, c } = fixture();
    const original = runtime.snapshot(), digest = checkpointDigest(original);
    const packed = packResumableCheckpoint(original, runtime.program, [layout]);
    const run = (operations: Parameters<typeof executePackedCheckpointNative>[0]['operations']) =>
      executePackedCheckpointNative({ packed, program: runtime.program,
        expectedSnapshotDigest: digest, expectedLayoutDigest: packed.heap.layoutDigest,
        executable, expectedExecutableSha256: executableDigest, operations });
    const result = run([
      { kind: 'readInt', id: String(a.addr), field: 'number' },
      { kind: 'readBool', id: String(bRef.addr), field: 'alive' },
      { kind: 'readRef', id: String(bRef.addr), field: 'link' },
      { kind: 'readRef', id: String(c.addr), field: 'link' },
      { kind: 'addInt', id: String(a.addr), field: 'number', increment: '1' }, // trap: no partial mutation
      { kind: 'addInt', id: String(bRef.addr), field: 'number', increment: '10' },
      { kind: 'setRef', id: String(a.addr), field: 'link', targetId: String(bRef.addr) },
      { kind: 'readRef', id: String(a.addr), field: 'link' },
    ]);
    assert.deepEqual(result.observations, [
      'i 0 1000', 'B 0 0', `R 0 0 ${a.addr} ${a.ownerEpoch}`,
      `R 0 0 ${a.addr} ${a.ownerEpoch}`, 'I 3 1000', 'I 0 15', 'S 0',
      `R 0 0 ${bRef.addr} ${bRef.ownerEpoch}`,
    ]);
    assert.notEqual(result.candidateHeap.bytes, packed.heap.bytes);
    assert.throws(() => unpackResumableCheckpoint({ ...packed, heap: result.candidateHeap }, runtime.program, digest),
      /checkpoint state does not match event head|invalid checkpoint after-state chain|logical digest mismatch/);
    runtime.correctRecord(bRef, 'number', 15n);
    runtime.correctRecord(a, 'link', bRef);
    const committed = packResumableCheckpoint(runtime.snapshot(), runtime.program, [layout]);
    assert.equal(result.candidateHeap.bytes, committed.heap.bytes);
    assert.notEqual(committed.snapshotDigest, packed.snapshotDigest);
    assert.throws(() => run([{ kind: 'addInt', id: String(a.addr), field: 'alive', increment: '1' }]), /unsupported native operation/);
    assert.throws(() => executePackedCheckpointNative({ packed, program: runtime.program,
      expectedSnapshotDigest: digest, expectedLayoutDigest: packed.heap.layoutDigest,
      executable, expectedExecutableSha256: 'sha256:wrong', operations: [] }), /executable digest/);
    const changed = join(folder, 'changed');
    writeFileSync(changed, readFileSync(executable));
    writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from('tampered')]));
    assert.throws(() => executePackedCheckpointNative({ packed, program: runtime.program,
      expectedSnapshotDigest: digest, expectedLayoutDigest: packed.heap.layoutDigest,
      executable: changed, expectedExecutableSha256: executableDigest, operations: [] }), /executable digest/);
    const malformed = [
      'AEPBR001 1 1 8 0\n00\n1 1 0 9\n', // row width exceeds payload
      'AEPBR001 2 1 8 0\n00\n1 1 0 4\n1 2 4 4\n', // duplicate logical ID
      'AEPBR001 1 1 7 0\n80\n1 1 0 7\n', // nonzero padding
      'AEPBR001 1 1 8 1\n00\n1 1 0 8\nX 0 0 1\n', // unknown command
    ];
    for (const frame of malformed) assert.throws(() => execFileSync(executable,
      { input: frame, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }));
    const stale = 'AEPBR001 2 1 8 1\n00\n1 1 0 4\n2 2 4 4\nS 0 0 3 1 1 999 2\n';
    assert.equal(execFileSync(executable, { input: stale, encoding: 'utf8', timeout: 5000 }).trim(), 'S 4\nH 00');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('seeded native differential covers local/wide aliases and all three overflow policies', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aether-packed-native-matrix-'));
  try {
    const executable = join(folder, 'native');
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      new URL('native.c', directory).pathname,
      new URL('../packed-heap/abi.c', directory).pathname, '-o', executable]);
    const executableDigest = sha256(readFileSync(executable));
    let seed = 0x62d8a441;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    let checks = 0;
    const campaigns: unknown[] = [];
    for (const maxRelative of [1, 15]) for (const overflow of ['trap', 'wrap', 'saturate'] as const) {
      const runtime = runtimeFixture(), refs = Array.from({ length: 16 }, (_, index) =>
        runtime.allocateRecord(nodeType, { number: BigInt(index * 61), alive: !!(index & 1), link: null }));
      for (let index = 0; index < refs.length; index++) {
        const target = maxRelative === 1 ? Math.min(index + 1, refs.length - 1) : next() % refs.length;
        runtime.correctRecord(refs[index], 'link', refs[target]);
      }
      const bounded: PackedLayout = { typeName: nodeName, fields: [
        { name: 'number', kind: 'int', min: '0', max: '1000', overflow },
        { name: 'alive', kind: 'bool' },
        { name: 'link', kind: 'ref', maxRelative },
      ] };
      const snapshot = runtime.snapshot(), expectedSnapshotDigest = checkpointDigest(snapshot);
      const packed = packResumableCheckpoint(snapshot, runtime.program, [bounded]);
      const operations: Parameters<typeof executePackedCheckpointNative>[0]['operations'][number][] = [];
      for (let step = 0; step < 128; step++) {
        const index = next() % refs.length, id = String(refs[index].addr);
        switch (next() % 5) {
          case 0: operations.push({ kind: 'readInt', id, field: 'number' }); break;
          case 1: operations.push({ kind: 'readBool', id, field: 'alive' }); break;
          case 2: operations.push({ kind: 'readRef', id, field: 'link' }); break;
          case 3: operations.push({ kind: 'addInt', id, field: 'number', increment: String((next() % 2001) - 1000) }); break;
          default: {
            const target = maxRelative === 1 ? Math.min(index + 1, refs.length - 1) : next() % refs.length;
            operations.push({ kind: 'setRef', id, field: 'link', targetId: String(refs[target].addr) });
          }
        }
      }
      const result = executePackedCheckpointNative({ packed, program: runtime.program,
        expectedSnapshotDigest, expectedLayoutDigest: packed.heap.layoutDigest,
        executable, expectedExecutableSha256: executableDigest, operations });
      assert.equal(result.observations.length, 128);
      assert.equal(PackedHeap.fromImage(result.candidateHeap).unpack().length, 16);
      checks += result.observations.length;
      campaigns.push({ maxRelative, overflow, inputSnapshotDigest: expectedSnapshotDigest,
        layoutDigest: packed.heap.layoutDigest, inputImageDigest: packed.heap.imageDigest,
        candidateImageDigest: result.candidateHeap.imageDigest, operations, observations: result.observations });
    }
    assert.equal(checks, 768);
    const evidencePath = process.env.AETHER_PACKED_NATIVE_EVIDENCE;
    if (evidencePath) {
      const root = fileURLToPath(new URL('../../../..', directory));
      const sources = [
        'roadmap/v4/research/packed-native-bridge/native.c',
        'roadmap/v4/research/packed-native-bridge/bridge.ts',
        'roadmap/v4/research/packed-native-bridge/bridge.test.ts',
        'roadmap/v4/research/packed-heap/abi.c',
        'roadmap/v4/research/packed-heap/abi.h',
        'src/tier3/packed-heap.ts',
        'src/tier3/resumable-state.ts',
      ].map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
      const report = { format: 'aether.packed-native-differential/1',
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        sources, executableSha256: executableDigest,
        compiler: execFileSync('cc', ['--version'], { encoding: 'utf8' }).split('\n')[0],
        environment: { platform: platform(), architecture: arch(), osRelease: release(), cpu: cpus()[0]?.model, node: process.version },
        registration: { seed: '0x62d8a441', generator: 'xorshift32', recordsPerCampaign: 16,
          operationsPerCampaign: 128, maxRelative: [1, 15], overflow: ['trap', 'wrap', 'saturate'], totalOperations: checks },
        campaigns };
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
