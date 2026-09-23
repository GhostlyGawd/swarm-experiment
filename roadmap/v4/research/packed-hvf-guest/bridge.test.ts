import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, release, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as b from '../../../../src/tier1/build.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { typeName } from '../../../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';
import { checkpointDigest } from '../../../../src/tier3/resumable-state.ts';
import { ResumableRuntime } from '../../../../src/tier3/resumable-runtime.ts';
import { packResumableCheckpoint, unpackResumableCheckpoint, type PackedLayout } from '../../../../src/tier3/packed-heap.ts';
import { compilePackedGuest, sha256 } from './build.ts';
import { executePackedCheckpointGuest, type GuestOperation } from './bridge.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const nodeName = typeName('type:test:packed_hvf_node');
const nodeType = { t: 'Record' as const, name: nodeName,
  fields: [['number', b.Int], ['alive', b.Bool], ['link', b.Unit]] as const };
const layout = (maxRelative: number): PackedLayout => ({ typeName: nodeName, fields: [
  { name: 'number', kind: 'int', min: '0', max: '1000', overflow: 'trap' },
  { name: 'alive', kind: 'bool' },
  { name: 'link', kind: 'ref', maxRelative },
] });
function fixture(name: string) {
  const symbols = new SymbolSpace(name), entry = symbols.define('entry');
  const declaration = b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [declaration], symbolTable: symbols.table() });
  const store = new GraphStore(), digest = (value: string) => domainDigest('aether.packed-hvf-test/1', value);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module),
    specRoot: digest('spec'), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'),
    target: { abiVersion: 'resumable/1', profileDigest: digest('target'), artifactDigest: digest('artifact') },
    capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence') };
  return new ResumableRuntime(module, { manifest, registry: new CapabilityRegistry(),
    executionId: name, authorizeCorrection: () => true });
}

test('actual EL1 guest reads and mutates authenticated packed checkpoint with differential and failure evidence',
  { timeout: 120000 }, () => {
    if (platform() !== 'darwin' || arch() !== 'arm64') return;
    const folder = mkdtempSync(join(tmpdir(), 'aether-packed-hvf-'));
    try {
      const binary = compilePackedGuest(folder);
      const cases: unknown[] = [];
      const runtime = fixture('packed-hvf-small');
      const a = runtime.allocateRecord(nodeType, { number: 1000n, alive: true, link: null });
      const bRef = runtime.allocateRecord(nodeType, { number: 5n, alive: false, link: null });
      runtime.correctRecord(bRef, 'link', a);
      runtime.correctRecord(a, 'link', bRef);
      const original = runtime.snapshot(), originalDigest = checkpointDigest(original);
      const packed = packResumableCheckpoint(original, runtime.program, [layout(1)]);
      const run = (operations: readonly GuestOperation[]) => executePackedCheckpointGuest({
        packed, program: runtime.program, expectedSnapshotDigest: originalDigest,
        expectedLayoutDigest: packed.heap.layoutDigest, driver: binary.driver, guestImage: binary.image,
        expectedDriverSha256: binary.driverSha256, expectedGuestSha256: binary.guestSha256, operations,
      });
      const operations: GuestOperation[] = [
        { kind: 'readInt', id: String(a.addr), field: 'number' },
        { kind: 'readBool', id: String(bRef.addr), field: 'alive' },
        { kind: 'readRef', id: String(bRef.addr), field: 'link' },
        { kind: 'addInt', id: String(a.addr), field: 'number', increment: '1' },
        { kind: 'addInt', id: String(bRef.addr), field: 'number', increment: '10' },
        { kind: 'readInt', id: String(bRef.addr), field: 'number' },
      ];
      const result = run(operations);
      assert.deepEqual(result.observations, [
        { kind: 'readInt', status: 0, value: '1000' },
        { kind: 'readBool', status: 0, value: '0' },
        { kind: 'readRef', status: 0, value: `${a.addr}@${a.ownerEpoch}` },
        { kind: 'addInt', status: 3, value: '1000' },
        { kind: 'addInt', status: 0, value: '15' },
        { kind: 'readInt', status: 0, value: '15' },
      ]);
      assert.notEqual(result.candidateHeap.imageDigest, packed.heap.imageDigest);
      assert.equal(result.diagnostics.guestMappedBytes, 65536);
      assert.ok(result.diagnostics.guestResidentObservedBytes > 0);
      assert.ok(result.diagnostics.freshGuestToValidatedResponseNs > 0);
      assert.throws(() => unpackResumableCheckpoint({ ...packed, heap: result.candidateHeap }, runtime.program, originalDigest),
        /checkpoint state does not match event head|invalid checkpoint after-state chain|logical digest mismatch/);
      runtime.correctRecord(bRef, 'number', 15n);
      const committed = packResumableCheckpoint(runtime.snapshot(), runtime.program, [layout(1)]);
      assert.equal(result.candidateHeap.bytes, committed.heap.bytes);
      cases.push({ kind: 'real-checkpoint', snapshotDigest: originalDigest, operations,
        observations: result.observations, inputImageDigest: packed.heap.imageDigest,
        candidateImageDigest: result.candidateHeap.imageDigest, committedDigest: committed.snapshotDigest,
        diagnostics: result.diagnostics });
      assert.throws(() => run([{ kind: 'addInt', id: String(a.addr), field: 'alive', increment: '1' }]),
        /unsupported packed guest operation/);
      assert.throws(() => executePackedCheckpointGuest({ packed, program: runtime.program,
        expectedSnapshotDigest: originalDigest, expectedLayoutDigest: packed.heap.layoutDigest,
        driver: binary.driver, guestImage: binary.image, expectedDriverSha256: 'sha256:changed',
        expectedGuestSha256: binary.guestSha256, operations: [] }), /executable digest mismatch/);
      const changed = join(folder, 'changed.bin');
      writeFileSync(changed, Buffer.concat([readFileSync(binary.image), Buffer.from([0])]));
      assert.throws(() => executePackedCheckpointGuest({ packed, program: runtime.program,
        expectedSnapshotDigest: originalDigest, expectedLayoutDigest: packed.heap.layoutDigest,
        driver: binary.driver, guestImage: changed, expectedDriverSha256: binary.driverSha256,
        expectedGuestSha256: binary.guestSha256, operations: [] }), /executable digest mismatch/);
      const tampered = { ...packed, heap: { ...packed.heap, bytes: 'AA==' } };
      assert.throws(() => executePackedCheckpointGuest({ ...{
        packed: tampered, program: runtime.program, expectedSnapshotDigest: originalDigest,
        expectedLayoutDigest: packed.heap.layoutDigest, driver: binary.driver, guestImage: binary.image,
        expectedDriverSha256: binary.driverSha256, expectedGuestSha256: binary.guestSha256, operations: [],
      } }), /digest mismatch/);
      const edge = fixture('packed-hvf-i64-edge');
      const signed = edge.allocateRecord(nodeType, { number: -(1n << 63n), alive: true, link: null });
      const edgeLayout: PackedLayout = { typeName: nodeName, fields: [
        { name: 'number', kind: 'int', min: String(-(1n << 63n)),
          max: String((1n << 63n) - 1n), overflow: 'trap' },
        { name: 'alive', kind: 'bool' }, { name: 'link', kind: 'ref', maxRelative: 0 },
      ] };
      const edgeSnapshot = edge.snapshot(), edgeDigest = checkpointDigest(edgeSnapshot);
      const edgePacked = packResumableCheckpoint(edgeSnapshot, edge.program, [edgeLayout]);
      const edgeOperations: GuestOperation[] = [
        { kind: 'readInt', id: String(signed.addr), field: 'number' },
        { kind: 'addInt', id: String(signed.addr), field: 'number', increment: '-1' },
        { kind: 'addInt', id: String(signed.addr), field: 'number', increment: String((1n << 63n) - 1n) },
        { kind: 'readInt', id: String(signed.addr), field: 'number' },
        { kind: 'addInt', id: String(signed.addr), field: 'number', increment: String((1n << 63n) - 1n) },
      ];
      const edgeResult = executePackedCheckpointGuest({ packed: edgePacked, program: edge.program,
        expectedSnapshotDigest: edgeDigest, expectedLayoutDigest: edgePacked.heap.layoutDigest,
        driver: binary.driver, guestImage: binary.image, expectedDriverSha256: binary.driverSha256,
        expectedGuestSha256: binary.guestSha256, operations: edgeOperations });
      assert.deepEqual(edgeResult.observations.map(item => [item.status, item.value]), [
        [0, String(-(1n << 63n))], [3, String(-(1n << 63n))], [0, '-1'], [0, '-1'],
        [0, String((1n << 63n) - 2n)],
      ]);
      cases.push({ kind: 'signed-i64-edges', operations: edgeOperations,
        observations: edgeResult.observations, inputImageDigest: edgePacked.heap.imageDigest,
        candidateImageDigest: edgeResult.candidateHeap.imageDigest, diagnostics: edgeResult.diagnostics });
      let state = 0x52d8a441;
      const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
      for (const maxRelative of [1, 15]) for (let campaign = 0; campaign < 3; campaign++) {
        const other = fixture(`packed-hvf-${maxRelative}-${campaign}`);
        const refs = Array.from({ length: 16 }, (_, index) => other.allocateRecord(nodeType,
          { number: BigInt(index * 61), alive: !!(index & 1), link: null }));
        for (let index = 0; index < refs.length; index++) {
          const target = maxRelative === 1 ? Math.min(index + 1, refs.length - 1) : next() % refs.length;
          other.correctRecord(refs[index], 'link', refs[target]);
        }
        const snapshot = other.snapshot(), digest = checkpointDigest(snapshot);
        const input = packResumableCheckpoint(snapshot, other.program, [layout(maxRelative)]);
        const actions: GuestOperation[] = [];
        for (let step = 0; step < 128; step++) {
          const ordinal = next() % refs.length, id = String(refs[ordinal].addr);
          switch (next() % 4) {
            case 0: actions.push({ kind: 'readInt', id, field: 'number' }); break;
            case 1: actions.push({ kind: 'readBool', id, field: 'alive' }); break;
            case 2: actions.push({ kind: 'readRef', id, field: 'link' }); break;
            default: actions.push({ kind: 'addInt', id, field: 'number', increment: String((next() % 2001) - 1000) });
          }
        }
        const observed = executePackedCheckpointGuest({ packed: input, program: other.program,
          expectedSnapshotDigest: digest, expectedLayoutDigest: input.heap.layoutDigest,
          driver: binary.driver, guestImage: binary.image, expectedDriverSha256: binary.driverSha256,
          expectedGuestSha256: binary.guestSha256, operations: actions });
        assert.equal(observed.observations.length, 128);
        cases.push({ kind: 'seeded-differential', maxRelative, campaign, snapshotDigest: digest,
          operations: actions, observations: observed.observations, inputImageDigest: input.heap.imageDigest,
          candidateImageDigest: observed.candidateHeap.imageDigest, diagnostics: observed.diagnostics });
      }
      // A syntactically bounded frame with an invalid row span reaches the EL1
      // guest; the controller must refuse to return any candidate bytes.
      const malformed = Buffer.alloc(57);
      malformed.writeUInt32LE(0x47504541, 0); malformed.writeUInt32LE(1, 4);
      malformed.writeUInt32LE(57, 8); malformed.writeUInt32LE(1, 12);
      malformed.writeUInt32LE(8, 20); malformed.writeUInt32LE(1, 24);
      malformed.writeUInt32LE(48, 28); malformed.writeUInt32LE(56, 32);
      malformed.writeUInt32LE(56, 36); malformed.writeUInt32LE(56, 40);
      malformed.writeUInt32LE(9, 52);
      assert.throws(() => execFileSync(binary.driver, [binary.image],
        { input: malformed, timeout: 5000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'] }), /guest exit\/status/);
      // A looping guest is forcibly killed at the research bridge timeout.
      const linker = join(execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim(),
        'lib/rustlib/aarch64-apple-darwin/bin/gcc-ld/ld.lld');
      const hangObject = join(folder, 'hang.o'), hangImage = join(folder, 'hang.bin');
      execFileSync('clang', ['-target', 'aarch64-none-elf', '-c', join(here, 'hang.S'), '-o', hangObject]);
      execFileSync(linker, ['-T', join(here, 'kernel.ld'), '--oformat=binary', hangObject, '-o', hangImage]);
      assert.throws(() => execFileSync(binary.driver, [hangImage], { input: malformed,
        timeout: 250, killSignal: 'SIGKILL', maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'] }),
      (error: unknown) => error instanceof Error && 'signal' in error && error.signal === 'SIGKILL');
      cases.push({ kind: 'malformed-guest-frame', rejected: true },
        { kind: 'nonterminating-guest', controllerKilled: true, timeoutMs: 250 });
      if (process.env.AETHER_PACKED_HVF_EVIDENCE) {
        const paths = [
          'roadmap/v4/research/packed-hvf-guest/start.S', 'roadmap/v4/research/packed-hvf-guest/kernel.ld',
          'roadmap/v4/research/packed-hvf-guest/guest.c', 'roadmap/v4/research/packed-hvf-guest/driver.c',
          'roadmap/v4/research/packed-hvf-guest/build.ts', 'roadmap/v4/research/packed-hvf-guest/bridge.ts',
          'roadmap/v4/research/packed-hvf-guest/bridge.test.ts', 'roadmap/v4/research/packed-hvf-guest/verify-evidence.ts',
          'roadmap/v4/research/packed-hvf-guest/hang.S',
          'roadmap/v4/research/native/hypervisor.entitlements', 'src/tier3/packed-heap.ts',
          'src/tier3/resumable-runtime.ts', 'src/tier3/resumable-state.ts',
        ];
        const evidence = { format: 'aether.packed-hvf-guest-evidence/1',
          sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
          sourceFiles: paths.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
          binary: { guestSha256: binary.guestSha256, driverSha256: binary.driverSha256,
            guestBytes: readFileSync(binary.image).length, driverBytes: readFileSync(binary.driver).length },
          environment: { os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model,
            compiler: binary.compiler, linker: binary.linker, hypervisor: 'Apple Hypervisor.framework EL1 AArch64' },
          seed: 'xorshift32 0x52d8a441', cases };
        const destination = resolve(process.env.AETHER_PACKED_HVF_EVIDENCE);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
