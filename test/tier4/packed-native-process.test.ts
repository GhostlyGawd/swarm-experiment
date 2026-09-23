import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { typeName } from '../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { checkpointDigest } from '../../src/tier3/resumable-state.ts';
import { ResumableRuntime } from '../../src/tier3/resumable-runtime.ts';
import { PackedHeap, packResumableCheckpoint, type PackedLayout } from '../../src/tier3/packed-heap.ts';
import { PackedNativeProcessRunner, PackedNativeRun, type NativeOperation } from '../../src/tier4/packed-native-process.ts';

test('V2 runner executes a private copy of digest-pinned bytes and binds an unforgeable native run', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-packed-native-production-'));
  try {
    const original = readFileSync(new URL('../../roadmap/v4/research/packed-native-bridge/native.c', import.meta.url), 'utf8');
    const launchPath = join(directory, 'launched-path');
    const sourcePath = join(directory, 'instrumented.c');
    const marker = `FILE *marker = fopen(${JSON.stringify(launchPath)}, "w"); if (marker) { fputs(argv[0], marker); fclose(marker); }`;
    assert.match(original, /int main\(void\) \{/);
    writeFileSync(sourcePath, original.replace('int main(void) {', `int main(int argc, char **argv) { (void)argc; ${marker}`));
    const executable = join(directory, 'native');
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      '-I', new URL('../../roadmap/v4/research/packed-native-bridge/', import.meta.url).pathname, sourcePath,
      new URL('../../roadmap/v4/research/packed-heap/abi.c', import.meta.url).pathname, '-o', executable]);
    const executableSha256 = `sha256:${createHash('sha256').update(readFileSync(executable)).digest('hex')}`;

    const symbols = new SymbolSpace('packed-native-production'), entry = symbols.define('entry');
    const module = b.module_({ symbol: symbols.define('module'), members: [
      b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) }),
    ], symbolTable: symbols.table() });
    const digest = (value: string) => domainDigest('aether.packed-native-production-test/1', value);
    const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: new GraphStore().intern(module),
      specRoot: digest('spec'), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'),
      target: { abiVersion: 'resumable/1', profileDigest: digest('target'), artifactDigest: digest('artifact') },
      capabilityPolicyDigest: digest('capabilities'), evidencePolicyDigest: digest('evidence') };
    const runtime = new ResumableRuntime(module, { manifest, registry: new CapabilityRegistry(), executionId: 'packed-native-production' });
    const nodeName = typeName('type:test:packed_native_production_node');
    const nodeType = { t: 'Record' as const, name: nodeName, fields: [['value', b.Int]] as const };
    const layout: PackedLayout = { typeName: nodeName, fields: [{ name: 'value', kind: 'int', min: '0', max: '100', overflow: 'trap' }] };
    const reference = runtime.allocateRecord(nodeType, { value: 5n });
    const snapshot = runtime.snapshot();
    const source = packResumableCheckpoint(snapshot, runtime.program, [layout]);
    const candidateModel = PackedHeap.fromImage(source.heap);
    candidateModel.add(String(reference.addr), 'value', 15n);
    const operations: NativeOperation[] = [{ kind: 'addInt', id: String(reference.addr), field: 'value', increment: '15' }];
    const runner = new PackedNativeProcessRunner({ program: runtime.program,
      artifactDigest: manifest.target.artifactDigest, executable, expectedExecutableSha256: executableSha256, operations });
    const identity = PackedNativeProcessRunner.identity(runner);
    const request = { kind: 'packed-v2' as const, format: 'aether.process-packed-control/2' as const,
      operationId: 'production-native-run', expectedCheckpoint: checkpointDigest(snapshot),
      sourceImageDigest: source.heap.imageDigest, candidateImageDigest: candidateModel.image().imageDigest,
      layoutDigest: source.heap.layoutDigest, ...identity };
    assert.equal(identity.operationsDigest, domainDigest('aether.packed-native-operations/1', operations));
    operations[0] = { kind: 'addInt', id: String(reference.addr), field: 'value', increment: '60' };
    assert.equal(PackedNativeProcessRunner.identity(runner).operationsDigest, request.operationsDigest,
      'caller mutation cannot change the bound operation plan');
    assert.equal(PackedNativeProcessRunner.executionCount(runner), 0);
    assert.throws(() => PackedNativeProcessRunner.executeVerified(runner, source,
      { ...request, operationsDigest: domainDigest('aether.packed-native-operations/1', []) }), /identity mismatch/);
    assert.equal(PackedNativeProcessRunner.executionCount(runner), 0);
    assert.throws(() => PackedNativeProcessRunner.executeVerified(runner, source,
      { ...request, candidateImageDigest: source.heap.imageDigest }), /candidate identity mismatch/);
    assert.equal(PackedNativeProcessRunner.executionCount(runner), 1);

    const run = PackedNativeProcessRunner.executeVerified(runner, source, request);
    assert.equal(PackedNativeProcessRunner.executionCount(runner), 2);
    const childPath = readFileSync(launchPath, 'utf8');
    assert.match(childPath, /aether-packed-run-[^/]+\/verified-native$/);
    assert.notEqual(childPath, executable);
    assert.equal(existsSync(childPath), false, 'the executable copy is deleted after the child returns');
    assert.equal(PackedNativeProcessRunner.assertRun(run, request).imageDigest, request.candidateImageDigest);
    assert.throws(() => PackedNativeProcessRunner.assertRun(Object.create(PackedNativeRun.prototype), request), /proof required/);
    assert.throws(() => PackedNativeProcessRunner.assertRun(run,
      { ...request, sourceImageDigest: request.candidateImageDigest }), /binding mismatch/);
    assert.throws(() => PackedNativeProcessRunner.assertRun(run,
      { ...request, operationId: 'different-operation' }), /binding mismatch/);
    const exposed = run.candidateHeap as { bytes: string };
    exposed.bytes = source.heap.bytes;
    assert.equal(PackedNativeProcessRunner.assertRun(run, request).imageDigest, request.candidateImageDigest);

    writeFileSync(executable, 'changed executable bytes');
    assert.throws(() => PackedNativeProcessRunner.executeVerified(runner, source, request), /digest mismatch/);
    assert.equal(PackedNativeProcessRunner.executionCount(runner), 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
