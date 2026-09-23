import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import type { Term, Ty } from '../../src/tier1/ast.ts';
import { atomicWrite, encodeStored } from '../../src/tier1/persistence.ts';
import { DurableEffectBroker, type EffectAdapter } from '../../src/fabric/effects.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { typeName } from '../../src/tier1/ids.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { runtimeSnapshotDigest } from '../../src/fabric/snapshot.ts';
import { checkpointDigest, machineClone } from '../../src/tier3/resumable-state.ts';
import { ResumableRuntime } from '../../src/tier3/resumable-runtime.ts';
import { packResumableCheckpoint, type PackedLayout } from '../../src/tier3/packed-heap.ts';
import { ProcessHost, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { ProcessResumableSession, type ProcessResumableOptions } from '../../src/tier4/process-resumable.ts';
import { PackedNativeProcessRunner } from '../../src/tier4/packed-native-process.ts';
import { checkpointControlDigest, seedProcessCheckpoint, seededProcessReference } from '../../src/tier4/process-checkpoint-contract.ts';
import { executePackedCheckpointNative } from '../../roadmap/v4/research/packed-native-bridge/bridge.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
const dirs: string[] = [];
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'aether-process-checkpoint-')); dirs.push(dir); return dir; }
after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));
const digest = (name: string) => domainDigest('aether.bridge-test/1', name);
const integer = (n: number) => ({ tag: 'int' as const, value: String(n) });
function fixture(twoUnits = false, effectful = false) {
  const symbols = new SymbolSpace('process-checkpoint'), main = symbols.define('main'), child = symbols.define('child'), read = symbols.define('read'), box = symbols.define('box'), amount = symbols.define('amount'), task = symbols.define('task'), first = symbols.define('first');
  const registry = new CapabilityRegistry(), cap = effectful ? registry.declare('cap:test:observe', { arity: 1, description: 'Observe the leased production record.' }).name : null, caps = cap ? [cap] : [], type: Ty = { t: 'Record', name: typeName('type:test:checkpoint_box'), fields: [['value', b.Int]] };
  const target = b.fn({ symbol: child, params: [b.param(box, type), b.param(amount, b.Int)], returns: b.Int, capabilities: caps, body: b.block(b.assign(b.place(box, 'value'), b.add(b.field(b.v(box), 'value'), b.v(amount))), ...(cap ? [b.exprStmt(b.invoke(cap, b.v(box)))] : []), b.ret(b.field(b.v(box), 'value'))) });
  const entry = b.fn({ symbol: main, params: [b.param(box, type), b.param(amount, b.Int)], returns: b.Int, capabilities: caps, body: b.block(b.let_(task, { t: 'Task', result: b.Int }, b.spawn(b.call(child, b.v(box), b.v(amount)))), b.let_(first, b.Int, b.call(child, b.v(box), b.v(amount))), b.ret(b.add(b.v(first), b.await_(b.v(task))))) });
  const reader = b.fn({ symbol: read, params: [b.param(box, type)], returns: b.Int, body: b.ret(b.field(b.v(box), 'value')) });
  const module = b.module_({ symbol: symbols.define('module'), members: [entry, target, reader], symbolTable: symbols.table() }), store = new GraphStore();
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module), specRoot: digest('spec'), dependencies: [{ symbol: child, declaration: store.intern(target) }], semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'), target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') }, capabilityPolicyDigest: digest('policy'), evidencePolicyDigest: digest('evidence') };
  const plan: TopologyPlan = { shape: 'containers', units: twoUnits ? [{ id: 'a', members: [main, read], capabilities: caps, placement: 'container', memoryMb: 32 }, { id: 'b', members: [child], capabilities: caps, placement: 'container', memoryMb: 16 }] : [{ id: 'a', members: [main, child, read], capabilities: caps, placement: 'container', memoryMb: 48 }], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  let allowed = true;
  const options: ProcessHostOptions = { directory: temporary(), module, manifest, registry, plan, sealer: new CapabilitySealer(new Uint8Array(32).fill(19)), authorizeCheckpoint: () => allowed };
  return { module, manifest, registry, cap, type, main, child, read, options, allow: (value: boolean) => { allowed = value; } };
}
async function source(f: ReturnType<typeof fixture>, host: ProcessHost) {
  const ref = await host.allocateRecord(f.type, { value: integer(5) }, { operationId: 'box' }), before = await host.snapshot();
  const runtimeOptions = { manifest: f.manifest, registry: f.registry, executionId: 'resumable-operation', heapId: before.heapId, ownerEpoch: '0', capabilities: () => f.cap ? [f.cap] : [] };
  const runtime = new ResumableRuntime(f.module, runtimeOptions), seed = seedProcessCheckpoint(runtime.snapshot(), before, host.generation, runtime.program, { [ref.objectId]: f.type });
  runtime.restore(seed.checkpoint, checkpointDigest(seed.checkpoint)); const mapped = seededProcessReference(ref, seed), native = { addr: Number(mapped.objectId), heapId: mapped.heapId, ownerEpoch: mapped.ownerEpoch };
  runtime.start(f.main, [native, 2n]);
  while (!(runtime.inspect().frames.length === 2 && runtime.inspect().tasks.some(task => task.state === 'pending'))) runtime.step();
  return { before, ref, mapped, native, runtime, base: seed.checkpoint, initial: runtime.snapshot() };
}
function sessionOptions(f: ReturnType<typeof fixture>, host: ProcessHost): ProcessResumableOptions { return { host, module: f.module, runtime: { manifest: f.manifest, registry: f.registry }, tokens: () => host.issueTokens(f.main) }; }

test('actual native packed candidate is one durable ProcessHost control across retry, reopen and publication', async () => {
  const f = fixture(); let host: ProcessHost | undefined, revokeAtCommit = false;
  const hostOptions: ProcessHostOptions = {...f.options, onPhase: phase => {
    if (phase === 'checkpoint-control-before-commit' && revokeAtCommit) f.allow(false);
  }};
  try {
    host = await ProcessHost.open(hostOptions);
    const input = await source(f, host), folder = temporary(), executable = join(folder, 'packed-native');
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      new URL('../../roadmap/v4/research/packed-native-bridge/native.c', import.meta.url).pathname,
      new URL('../../roadmap/v4/research/packed-heap/abi.c', import.meta.url).pathname, '-o', executable]);
    const executableSha256 = `sha256:${createHash('sha256').update(readFileSync(executable)).digest('hex')}`;
    const layout: PackedLayout = { typeName: (f.type as Extract<Ty, {t: 'Record'}>).name,
      fields: [{name: 'value', kind: 'int', min: '0', max: '100', overflow: 'trap'}] };
    const packed = packResumableCheckpoint(input.initial, input.runtime.program, [layout]);
    const operations = [{kind: 'addInt' as const, id: input.mapped.objectId, field: 'value', increment: '15'}];
    const runNative = (source: typeof packed) => executePackedCheckpointNative({packed: source, program: input.runtime.program,
      expectedSnapshotDigest: source.snapshotDigest, expectedLayoutDigest: source.heap.layoutDigest,
      executable, expectedExecutableSha256: executableSha256, operations});
    const predicted = runNative(packed);
    const runner = new PackedNativeProcessRunner({program: input.runtime.program,
      artifactDigest: f.manifest.target.artifactDigest, executable, expectedExecutableSha256: executableSha256, operations});
    const identity = PackedNativeProcessRunner.identity(runner);
    const withNative = (current: ProcessHost): ProcessResumableOptions => ({...sessionOptions(f, current), nativePacked: runner});
    let session = await ProcessResumableSession.begin(withNative(host), input.base, input.initial,
      {operationId: 'packed-control-job', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before)});
    const request = {kind: 'packed-v2' as const, format: 'aether.process-packed-control/2' as const,
      operationId: 'packed-control-one', expectedCheckpoint: checkpointDigest(input.initial),
      layoutDigest: packed.heap.layoutDigest, sourceImageDigest: packed.heap.imageDigest,
      candidateImageDigest: predicted.candidateHeap.imageDigest,
      artifactDigest: f.manifest.target.artifactDigest, executableSha256, operationsDigest: identity.operationsDigest};
    f.allow(false);
    await assert.rejects(session.correctPacked(request, [layout]), /authorization_denied/);
    assert.equal(PackedNativeProcessRunner.executionCount(runner), 0); f.allow(true);
    await assert.rejects(host.withCheckpoint(session.binding.id, 'packed', host.issueTokens(f.main),
      async access => access.finishControl(access.checkpoint, [], undefined), request), /verified native run proof required/);
    const {operationsDigest: _oldOperations, ...legacyRequest} = request;
    await assert.rejects(host.withCheckpoint(session.binding.id, 'packed', host.issueTokens(f.main),
      async () => null, {...legacyRequest, kind: 'packed-v1', format: 'aether.process-packed-control/1'}), /new packed-v1 controls/);
    await assert.rejects(session.correctPacked({...request, operationId: 'wrong-candidate', candidateImageDigest: packed.heap.imageDigest}, [layout]), /candidate identity mismatch/);
    assert.equal(checkpointDigest(await host.readCheckpoint(session.binding.id)), checkpointDigest(input.initial));
    const noOpRunner = new PackedNativeProcessRunner({program: input.runtime.program,
      artifactDigest: f.manifest.target.artifactDigest, executable, expectedExecutableSha256: executableSha256, operations: []});
    const noOp = ProcessResumableSession.reopen({...withNative(host), nativePacked: noOpRunner}, session.binding.id);
    await assert.rejects(noOp.correctPacked({...request, operationId: 'no-op-candidate', candidateImageDigest: packed.heap.imageDigest,
      operationsDigest: PackedNativeProcessRunner.identity(noOpRunner).operationsDigest}, [layout]), /control does not match|empty packed control/);
    assert.equal(checkpointDigest(await host.readCheckpoint(session.binding.id)), checkpointDigest(input.initial));
    revokeAtCommit = true;
    await assert.rejects(session.correctPacked(request, [layout]), /authorization_denied/);
    assert.equal(checkpointDigest(await host.readCheckpoint(session.binding.id)), checkpointDigest(input.initial));
    revokeAtCommit = false; f.allow(true);
    const receipt = await session.correctPacked(request, [layout]);
    assert.equal(PackedNativeProcessRunner.executionCount(runner), 3);
    assert.deepEqual(await session.correctPacked(request, [layout]), receipt);
    assert.equal(PackedNativeProcessRunner.executionCount(runner), 3, 'a committed same-ID retry must not rerun native code');
    const corrected = await host.readCheckpoint(session.binding.id);
    assert.equal(corrected.core.records[0].fields[0][1].tag, 'int');
    assert.equal((corrected.core.records[0].fields[0][1] as {value: string}).value, '20');
    assert.match(corrected.events.at(-1)!.op, /^packed-correction-v2:aether\.packed-candidate-correction\/2:b3:/);
    assert.deepEqual(await host.snapshot(), input.before);
    await assert.rejects(session.correctPacked({...request, operationId: 'stale-packed'}, [layout]), /stale checkpoint control/);
    await host.close(); host = await ProcessHost.open(hostOptions);
    session = ProcessResumableSession.reopen(withNative(host), session.binding.id);
    assert.deepEqual(await session.correctPacked(request, [layout]), receipt);
    assert.equal(PackedNativeProcessRunner.executionCount(runner), 3);
    assert.equal((await session.run()).state, 'completed');
    await session.commit();
    const mapped = await session.publishedReference(input.mapped);
    const result = await host.call(f.read, [{tag: 'ref', value: mapped}], {operationId: 'read-native-packed-published', tokens: host.issueTokens(f.read)});
    assert.equal(result.state, 'completed');
    if (result.state === 'completed' && result.execution.ok) assert.equal((result.execution.value as {value: string}).value, '24');
    else assert.fail('published native packed correction was not visible to worker');
    const sidecar = join(f.options.directory, 'checkpoint-packed-layouts', `${request.layoutDigest.split(':').at(-1)!}.json`);
    const sidecarBytes = readFileSync(sidecar);
    await host.close(); host = undefined;
    const journalPath = join(f.options.directory, 'host.json'), journalBytes = readFileSync(journalPath);
    const forgedJournal = JSON.parse(journalBytes.toString('utf8'));
    const forgedControl = {...forgedJournal.checkpointControls[0], request: {
      ...forgedJournal.checkpointControls[0].request, candidateImageDigest: request.sourceImageDigest}};
    const {id: _oldId, ...forgedBody} = forgedControl;
    forgedJournal.checkpointControls[0] = {...forgedBody, id: checkpointControlDigest(forgedBody)};
    writeFileSync(journalPath, JSON.stringify(forgedJournal));
    await assert.rejects(ProcessHost.open(hostOptions), /packed control candidate image mismatch/);
    writeFileSync(journalPath, journalBytes);
    const forgedOperations = JSON.parse(journalBytes.toString('utf8'));
    const alteredControl = {...forgedOperations.checkpointControls[0], request: {
      ...forgedOperations.checkpointControls[0].request,
      operationsDigest: domainDigest('aether.packed-native-operations/1', [])}};
    const {id: _previousId, ...alteredBody} = alteredControl;
    forgedOperations.checkpointControls[0] = {...alteredBody, id: checkpointControlDigest(alteredBody)};
    writeFileSync(journalPath, JSON.stringify(forgedOperations));
    await assert.rejects(ProcessHost.open(hostOptions), /packed control event subject mismatch/);
    writeFileSync(journalPath, journalBytes);
    writeFileSync(sidecar, '[]');
    await assert.rejects(ProcessHost.open(hostOptions), /packed layout digest mismatch/);
    writeFileSync(sidecar, sidecarBytes);
  } finally { await host?.close(); }
});

test('packed control survives real controller SIGKILL before and after durable decision', async () => {
  for (const boundary of ['checkpoint-control-before-commit', 'checkpoint-control-committed']) {
    const f = fixture(); let host: ProcessHost | undefined;
    try {
      host = await ProcessHost.open(f.options);
      const input = await source(f, host), directory = f.options.directory, executable = join(temporary(), 'native');
      execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
        new URL('../../roadmap/v4/research/packed-native-bridge/native.c', import.meta.url).pathname,
        new URL('../../roadmap/v4/research/packed-heap/abi.c', import.meta.url).pathname, '-o', executable]);
      const executableSha256 = `sha256:${createHash('sha256').update(readFileSync(executable)).digest('hex')}`;
      const layout: PackedLayout = {typeName: (f.type as Extract<Ty, {t: 'Record'}>).name,
        fields: [{name: 'value', kind: 'int', min: '0', max: '100', overflow: 'trap'}]};
      const packed = packResumableCheckpoint(input.initial, input.runtime.program, [layout]);
      const operations = [{kind: 'addInt' as const, id: input.mapped.objectId, field: 'value', increment: '15'}];
      const runNative = (source: typeof packed) => executePackedCheckpointNative({packed: source, program: input.runtime.program,
        expectedSnapshotDigest: source.snapshotDigest, expectedLayoutDigest: source.heap.layoutDigest,
        executable, expectedExecutableSha256: executableSha256, operations});
      const runner = new PackedNativeProcessRunner({program: input.runtime.program, artifactDigest: f.manifest.target.artifactDigest,
        executable, expectedExecutableSha256: executableSha256, operations});
      const request = {kind: 'packed-v2' as const, format: 'aether.process-packed-control/2' as const,
        operationId: `packed-kill-${boundary}`, expectedCheckpoint: checkpointDigest(input.initial),
        layoutDigest: packed.heap.layoutDigest, sourceImageDigest: packed.heap.imageDigest,
        candidateImageDigest: runNative(packed).candidateHeap.imageDigest,
        artifactDigest: f.manifest.target.artifactDigest, executableSha256,
        operationsDigest: PackedNativeProcessRunner.identity(runner).operationsDigest};
      const session = await ProcessResumableSession.begin({...sessionOptions(f, host), nativePacked: runner}, input.base, input.initial,
      {operationId: `packed-lease-${boundary}`, symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before)});
      const id = session.binding.id;
      writeFileSync(join(directory, 'packed-child-input.json'), encodeStored({module: f.module, manifest: f.manifest, plan: f.options.plan,
        main: f.main, id, request, layout, executable, mappedId: input.mapped.objectId}));
      const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
      writeFileSync(join(directory, 'packed-controller.ts'), `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeStored } from ${moduleUrl('../../src/tier1/persistence.ts')};
import { CapabilityRegistry, CapabilitySealer } from ${moduleUrl('../../src/tier2/ocap.ts')};
import { ProcessHost } from ${moduleUrl('../../src/tier4/process-host.ts')};
import { ProcessResumableSession } from ${moduleUrl('../../src/tier4/process-resumable.ts')};
import { PackedNativeProcessRunner } from ${moduleUrl('../../src/tier4/packed-native-process.ts')};
import { compileResumableProgram } from ${moduleUrl('../../src/tier3/resumable-program.ts')};
const directory = ${JSON.stringify(directory)}, boundary = ${JSON.stringify(boundary)};
const f = decodeStored(readFileSync(join(directory, 'packed-child-input.json'), 'utf8'));
const registry = new CapabilityRegistry(), program = compileResumableProgram(f.module, {manifest:f.manifest, registry});
const host = await ProcessHost.open({directory, module:f.module, manifest:f.manifest, registry, plan:f.plan,
  sealer:new CapabilitySealer(new Uint8Array(32).fill(19)), authorizeCheckpoint:()=>true,
  onPhase:phase=>{if(phase===boundary)process.kill(process.pid,'SIGKILL');}});
const runner = new PackedNativeProcessRunner({program,artifactDigest:f.request.artifactDigest,executable:f.executable,
  expectedExecutableSha256:f.request.executableSha256,operations:[{kind:'addInt',id:f.mappedId,field:'value',increment:'15'}]});
const session = ProcessResumableSession.reopen({host,module:f.module,runtime:{manifest:f.manifest,registry},
  tokens:()=>host.issueTokens(f.main),nativePacked:runner},f.id);
await session.correctPacked(f.request,[f.layout]);
throw Error('expected SIGKILL');
`);
      await host.close(); host = undefined;
      const killed = spawnSync(process.execPath, ['--experimental-strip-types', join(directory, 'packed-controller.ts')],
        {encoding: 'utf8', timeout: 90000});
      assert.equal(killed.signal, 'SIGKILL', `${boundary}: ${killed.stderr}`);
      host = await ProcessHost.open(f.options);
      const resumed = ProcessResumableSession.reopen({...sessionOptions(f, host), nativePacked: runner}, id);
      const receipt = await resumed.correctPacked(request, [layout]);
      assert.deepEqual(await resumed.correctPacked(request, [layout]), receipt);
      assert.equal(PackedNativeProcessRunner.executionCount(runner), boundary === 'checkpoint-control-before-commit' ? 1 : 0);
      const corrected = await host.readCheckpoint(id);
      assert.equal((corrected.core.records[0].fields[0][1] as {value: string}).value, '20');
      assert.deepEqual(await host.snapshot(), input.before);
      assert.equal((await resumed.run()).state, 'completed');
      await resumed.commit();
      const mapped = await resumed.publishedReference(input.mapped);
      const result = await host.call(f.read, [{tag: 'ref', value: mapped}],
        {operationId: `packed-kill-read-${boundary}`, tokens: host.issueTokens(f.read)});
      assert.equal(result.state, 'completed');
      if (result.state === 'completed' && result.execution.ok) assert.equal((result.execution.value as {value: string}).value, '24');
      else assert.fail('packed correction was not recovered');
    } finally {await host?.close();}
  }
});

test('checkpoint lease preserves nonempty frames/tasks and publishes state to actual production workers', async () => {
  const f = fixture(); let host: ProcessHost | undefined, second: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options); const input = await source(f, host), oldPids = Object.values(host.workerPids);
    const session = await ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'checkpoint-job', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
    second = await ProcessHost.open(f.options);
    await assert.rejects(second.call(f.read, [{ tag: 'ref', value: input.ref }], { operationId: 'while-owned', tokens: second.issueTokens(f.read) }), /checkpoint lease/);
    await assert.rejects(second.allocateRecord(f.type, { value: integer(1) }, { operationId: 'while-owned-allocation' }), /checkpoint lease/);
    await assert.rejects(second.move(f.main, 'a', { migrationId: 'while-owned-move' }), /checkpoint lease/);
    assert.equal((await session.run(3)).state, 'running'); const persisted = await host.readCheckpoint(session.binding.id); assert.ok(persisted.core.frames.length > 1); assert.equal(persisted.core.tasks[0].state, 'pending');
    assert.deepEqual(await host.snapshot(), input.before, 'private continuation does not publish partial heap writes');
    await host.close(); host = await ProcessHost.open(f.options); const resumed = ProcessResumableSession.reopen(sessionOptions(f, host), session.binding.id);
    assert.equal((await resumed.run()).state, 'completed'); const receipt = await resumed.commit(); assert.deepEqual(await resumed.commit(), receipt);
    const mapped = await resumed.publishedReference(input.mapped); assert.equal(mapped.ownerEpoch, '1'); assert.notEqual(mapped.ownerEpoch, input.mapped.ownerEpoch);
    const result = await host.call(f.read, [{ tag: 'ref', value: mapped }], { operationId: 'read-published', tokens: host.issueTokens(f.read) });
    assert.equal(result.state, 'completed'); if (result.state === 'completed' && result.execution.ok) assert.equal((result.execution.value as { value: string }).value, '9'); else assert.fail('production read did not succeed');
    assert.ok(Object.values(host.workerPids).every(pid => !oldPids.includes(pid))); assert.equal(host.checkpointStatus(session.binding.id).state, 'committed');
    assert.equal(JSON.parse(readFileSync(join(f.options.directory, 'host.json'), 'utf8')).format, 'aether.process-host/2');
  } finally { await second?.close(); await host?.close(); }
});

test('stale production generations reject while explicit fresh epoch mapping preserves the same allocation', async () => {
  const f = fixture(true); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options); const input = await source(f, host);
    await assert.rejects(ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'multi-unit', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) }), /single execution unit/);
    await host.move(f.child, 'a', { migrationId: 'merge', expectedGeneration: '1' }); assert.equal(host.generation, '2');
    await assert.rejects(ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'stale', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) }), /stale/);
    const before = await host.snapshot(), session = await ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'fresh', symbol: f.main, expectedGeneration: '2', expectedSnapshot: runtimeSnapshotDigest(before) });
    await session.run(); await session.commit(); const mapped = await session.publishedReference(input.mapped); assert.equal(mapped.ownerEpoch, '2');
    await assert.rejects(host.call(f.read, [{ tag: 'ref', value: input.ref }], { operationId: 'old-ref', tokens: host.issueTokens(f.read) }), /stale/);
    assert.equal((await host.call(f.read, [{ tag: 'ref', value: mapped }], { operationId: 'new-ref', tokens: host.issueTokens(f.read) })).state, 'completed');
    await assert.rejects(session.publishedReference({ ...input.mapped, ownerEpoch: '999' }), /stale/);
  } finally { await host?.close(); }
});

test('checkpoint publication requires current grants, exact origin and engine-produced progression', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options); const input = await source(f, host);
    f.allow(false); await assert.rejects(ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'denied', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) }), /authorization_denied/); f.allow(true);
    const session = await ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'job', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
    const forged = machineClone(input.initial); input.runtime.run(); const finished = input.runtime.snapshot();
    await assert.rejects(host.withCheckpoint(session.binding.id, 'run', host.issueTokens(f.main), async access => { access.save(machineClone(finished)); }), /not produced/);
    const other = new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: forged.core.executionId, heapId: forged.core.heapId }); other.restore(finished, checkpointDigest(finished));
    await assert.rejects(host.withCheckpoint(session.binding.id, 'run', host.issueTokens(f.main), async access => { access.save(other.snapshot()); }), /not produced/);
    f.allow(false); await assert.rejects(session.run(), /authorization_denied/); f.allow(true);
    await session.abort(); assert.deepEqual(await host.snapshot(), input.before);
  } finally { await host?.close(); }
});


function effectFactory(f: ReturnType<typeof fixture>, directory: string, failReceipt = false): NonNullable<ProcessResumableOptions['effects']> {
  let fail = failReceipt;
  return context => {
    const file = join(directory, 'sink.json');
    const adapter: EffectAdapter = { id: 'leased-record-sink/1', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true },
      execute: request => {
        assert.equal(request.payload.tag, 'sequence'); if (request.payload.tag !== 'sequence' || request.payload.items[1].tag !== 'ref') throw new Error('expected record effect argument');
        const reference = request.payload.items[1].value, view = context.snapshot(); assert.equal(reference.ownerEpoch, context.binding.generation);
        const field = view.records.find(record => record.objectId === reference.objectId)?.fields.find(([name]) => name === 'value')?.[1];
        const rows: { id: string; value: string }[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [], id = `${request.executionId}/${request.effectId}`;
        if (!rows.some(row => row.id === id)) { rows.push({ id, value: field?.tag === 'int' ? field.value : 'invalid' }); atomicWrite(file, JSON.stringify(rows)); }
        return { tag: 'null' };
      },
      reconcile: request => { const rows: { id: string }[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []; return rows.some(row => row.id === `${request.executionId}/${request.effectId}`) ? { state: 'committed', value: { tag: 'null' } } : { state: 'not_committed' }; },
    };
    const broker = new DurableEffectBroker({ directory: join(directory, 'effects', context.binding.id.split(':').at(-1)!), clockDomain: 'bridge-test/1', clock: () => 1n, authorize: () => true, authorizeReconciliation: () => true,
      beforePersist: event => { if (fail && event.state === 'committed') { fail = false; throw new Error('injected receipt interruption'); } } });
    return { broker, adapters: new Map([[f.cap!, adapter]]), policyEpoch: '0', deadline: '100000', grant: () => 'bridge-grant' };
  };
}

test('leased effects use the durable private C1 view, reconcile unknown outcomes and publish exactly once', async () => {
  const f = fixture(false, true); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options); const input = await source(f, host), effects = effectFactory(f, f.options.directory, true);
    const options = { ...sessionOptions(f, host), effects };
    const session = await ProcessResumableSession.begin(options, input.base, input.initial, { operationId: 'effects', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
    assert.equal((await session.run()).state, 'blocked');
    await assert.rejects(session.commit(), /unresolved effects/); await assert.rejects(session.abort(), /possible external work/);
    const blocked = await host.readCheckpoint(session.binding.id);
    await assert.rejects(session.rewind({ kind: 'rewind', operationId: 'unknown-outcome-rewind', expectedCheckpoint: checkpointDigest(blocked), steps: 1 }), /reconciled effects/);
    assert.deepEqual(await host.snapshot(), input.before);
    await session.reconcile(); assert.equal((await session.run()).state, 'completed'); const receipt = await session.commit();
    const rows = JSON.parse(readFileSync(join(f.options.directory, 'sink.json'), 'utf8')); assert.deepEqual(rows.map((row: { value: string }) => row.value), ['7', '9']);
    assert.ok(rows.every((row: { id: string }) => row.id.startsWith('aether.process-checkpoint-execution/1:')));
    assert.deepEqual(await session.commit(), receipt); assert.equal(JSON.parse(readFileSync(join(f.options.directory, 'sink.json'), 'utf8')).length, 2);
    await host.close(); host = await ProcessHost.open(f.options); assert.equal(host.checkpointStatus(session.binding.id).state, 'committed');
    const after = await host.snapshot(); assert.equal((after.records[0].fields[0][1] as { value: string }).value, '9');
  } finally { await host?.close(); }
});

test('checkpoint policy requires literal true and publication rechecks policy after preparation', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open({ ...f.options, authorizeCheckpoint: (() => Promise.resolve(false)) as unknown as ProcessHostOptions['authorizeCheckpoint'] }); const input = await source(f, host);
    await assert.rejects(ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'promise-policy', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) }), /authorization_denied/);
    await host.close();
    let revoke = false;
    host = await ProcessHost.open({ ...f.options, onPhase: phase => { if (phase === 'checkpoint-before-commit' && revoke) f.allow(false); } });
    const session = await ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'policy-flip', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
    await session.run(); revoke = true; await assert.rejects(session.commit(), /authorization_denied/); assert.deepEqual(await host.snapshot(), input.before);
    f.allow(true); revoke = false; await session.commit();
  } finally { await host?.close(); }
});

test('typed local and heap controls survive restart, retain audit, and resume without rebuilding workers', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options); const input = await source(f, host), pids = host.workerPids;
    let session = await ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'control-job', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
    const initial = await host.readCheckpoint(session.binding.id), frame = initial.core.frames.at(-1)!;
    const target = f.module.kind === 'Module' ? f.module.members.find(member => member.kind === 'FunctionDecl' && member.symbol === f.child) : null; if (target?.kind !== 'FunctionDecl') throw new Error('fixture');
    const correction = { kind: 'local' as const, operationId: 'change-amount', expectedCheckpoint: checkpointDigest(initial), frameId: frame.id, symbol: target.params[1].symbol, value: integer(3) };
    f.allow(false); await assert.rejects(session.correct(correction), /authorization_denied/); f.allow(true);
    await assert.rejects(session.correct({ ...correction, value: { tag: 'string', value: 'invalid' } }), /type/);
    const first = await session.correct(correction); assert.deepEqual(await session.correct(correction), first);
    await assert.rejects(session.correct({ ...correction, value: integer(4) }), /identity conflict/);
    const changed = await host.readCheckpoint(session.binding.id);
    await session.correct({ kind: 'record', operationId: 'change-record', expectedCheckpoint: checkpointDigest(changed), reference: input.mapped, field: 'value', value: integer(20) });
    const beforeRun = await host.readCheckpoint(session.binding.id); await session.run(3); const advanced = await host.readCheckpoint(session.binding.id);
    await session.rewind({ kind: 'rewind', operationId: 'rewind-three', expectedCheckpoint: checkpointDigest(advanced), steps: 3 });
    const rewound = await host.readCheckpoint(session.binding.id); assert.deepEqual(rewound.core, beforeRun.core); assert.equal(rewound.events.length, advanced.events.length + 1); assert.deepEqual(host.workerPids, pids);
    await assert.rejects(session.rewind({ kind: 'rewind', operationId: 'outside-lease', expectedCheckpoint: checkpointDigest(rewound), steps: rewound.events.length }), /ownership/);
    await host.close(); host = await ProcessHost.open(f.options); session = ProcessResumableSession.reopen(sessionOptions(f, host), session.binding.id);
    assert.equal((await session.run()).state, 'completed'); await session.commit();
    const result = await host.call(f.read, [{ tag: 'ref', value: await session.publishedReference(input.mapped) }], { operationId: 'read-corrected', tokens: host.issueTokens(f.read) });
    assert.equal(result.state, 'completed'); if (result.state === 'completed' && result.execution.ok) assert.equal((result.execution.value as { value: string }).value, '25'); else assert.fail('worker read failed');
    const journal = JSON.parse(readFileSync(join(f.options.directory, 'host.json'), 'utf8')); assert.equal(journal.format, 'aether.process-host/3'); assert.equal(journal.checkpointControls.length, 3);
    const file = join(f.options.directory, 'host.json'), bytes = readFileSync(file); await host.close(); host = undefined;
    writeFileSync(file, JSON.stringify({ ...journal, checkpointControls: [] }));
    await assert.rejects(ProcessHost.open(f.options), /unaudited control/); writeFileSync(file, bytes);
  } finally { await host?.close(); }
});

test('correction policies reject Promise grants and revocation at the durable publication boundary', async () => {
  const f = fixture(); let host: ProcessHost | undefined, policy: unknown = true, revoke = false;
  try {
    host = await ProcessHost.open({ ...f.options, authorizeCheckpoint: (() => policy) as ProcessHostOptions['authorizeCheckpoint'], onPhase: phase => { if (phase === 'checkpoint-control-before-commit' && revoke) policy = false; } });
    const input = await source(f, host), session = await ProcessResumableSession.begin(sessionOptions(f, host), input.base, input.initial, { operationId: 'control-policy', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
    const request = { kind: 'record' as const, operationId: 'revoked-control', expectedCheckpoint: checkpointDigest(input.initial), reference: input.mapped, field: 'value', value: integer(20) };
    policy = Promise.resolve(true); await assert.rejects(session.correct(request), /authorization_denied/); policy = true;
    revoke = true; await assert.rejects(session.correct(request), /authorization_denied/); assert.equal(checkpointDigest(await host.readCheckpoint(session.binding.id)), checkpointDigest(input.initial));
    policy = true; revoke = false; await session.correct(request); await session.abort(); assert.deepEqual(await host.snapshot(), input.before);
  } finally { await host?.close(); }
});

test('durable rewind debt replays committed effects without redispatch and blocks divergent corrections', async () => {
  const f = fixture(false, true); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options); const input = await source(f, host);
    let session = await ProcessResumableSession.begin({ ...sessionOptions(f, host), effects: effectFactory(f, f.options.directory) }, input.base, input.initial, { operationId: 'debt', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
    await session.run(); const completed = await host.readCheckpoint(session.binding.id);
    await assert.rejects(session.correct({ kind: 'record', operationId: 'late-correction', expectedCheckpoint: checkpointDigest(completed), reference: input.mapped, field: 'value', value: integer(100) }), /before postcondition/);
    const control = { kind: 'rewind' as const, operationId: 'replay-effects', expectedCheckpoint: checkpointDigest(completed), steps: completed.events.length - input.initial.events.length };
    await session.rewind(control); const rewound = await host.readCheckpoint(session.binding.id); assert.equal(rewound.core.effectCursor, '0');
    await host.close(); host = await ProcessHost.open(f.options); session = ProcessResumableSession.reopen({ ...sessionOptions(f, host), effects: effectFactory(f, f.options.directory) }, session.binding.id);
    const withoutBroker = ProcessResumableSession.reopen(sessionOptions(f, host), session.binding.id);
    await assert.rejects(withoutBroker.run(), /lost its durable recorded outcome/); assert.equal(checkpointDigest(await host.readCheckpoint(session.binding.id)), checkpointDigest(rewound));
    await assert.rejects(session.correct({ kind: 'record', operationId: 'unsafe-change', expectedCheckpoint: checkpointDigest(rewound), reference: input.mapped, field: 'value', value: integer(100) }), /replay debt/);
    await assert.rejects(session.abort(), /possible external work/);
    assert.equal((await session.run()).state, 'completed'); await session.commit();
    assert.deepEqual(JSON.parse(readFileSync(join(f.options.directory, 'sink.json'), 'utf8')).map((row: { value: string }) => row.value), ['7', '9']);
  } finally { await host?.close(); }
});

test('fresh controllers recover SIGKILL at checkpoint, effect receipt and publication boundaries', async () => {
  for (const boundary of ['checkpoint-saved', 'effect-receipt', 'checkpoint-committed', 'checkpoint-control-before-commit', 'checkpoint-control-committed']) {
    const f = fixture(false, true); let host: ProcessHost | undefined;
    try {
      host = await ProcessHost.open(f.options); const input = await source(f, host);
      const session = await ProcessResumableSession.begin({ ...sessionOptions(f, host), effects: effectFactory(f, f.options.directory) }, input.base, input.initial, { operationId: boundary, symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
      const id = session.binding.id, directory = f.options.directory;
      writeFileSync(join(directory, 'child-input.json'), encodeStored({ module: f.module, manifest: f.manifest, plan: f.options.plan, main: f.main, cap: f.cap, id, initialEvents: input.initial.events.length }));
      const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
      const factory = effectFactory.toString().replace("throw new Error('injected receipt interruption')", "process.kill(process.pid, 'SIGKILL')");
      writeFileSync(join(directory, 'controller.ts'), `
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, decodeStored } from ${moduleUrl('../../src/tier1/persistence.ts')};
import { DurableEffectBroker } from ${moduleUrl('../../src/fabric/effects.ts')};
import { CapabilityRegistry, CapabilitySealer } from ${moduleUrl('../../src/tier2/ocap.ts')};
import { ProcessHost } from ${moduleUrl('../../src/tier4/process-host.ts')};
import { ProcessResumableSession } from ${moduleUrl('../../src/tier4/process-resumable.ts')};
import { checkpointDigest } from ${moduleUrl('../../src/tier3/resumable-state.ts')};
const directory = ${JSON.stringify(directory)}, boundary = ${JSON.stringify(boundary)};
const f = decodeStored(readFileSync(join(directory, 'child-input.json'), 'utf8'));
const registry = new CapabilityRegistry(); registry.declare(f.cap, { arity: 1, description: 'Observe the leased production record.' });
const host = await ProcessHost.open({ directory, module: f.module, manifest: f.manifest, registry, plan: f.plan, sealer: new CapabilitySealer(new Uint8Array(32).fill(19)), authorizeCheckpoint: () => true,
  onPhase: phase => { if (phase === boundary) process.kill(process.pid, 'SIGKILL'); } });
const effectFactory = ${factory};
const session = ProcessResumableSession.reopen({ host, module: f.module, runtime: { manifest: f.manifest, registry }, tokens: () => host.issueTokens(f.main), effects: effectFactory(f, directory, boundary === 'effect-receipt') }, f.id);
await session.run();
if (boundary.startsWith('checkpoint-control-')) {
  const snapshot = await host.readCheckpoint(f.id), control = { kind: 'rewind', operationId: 'child-rewind', expectedCheckpoint: checkpointDigest(snapshot), steps: snapshot.events.length - f.initialEvents };
  atomicWrite(join(directory, 'control-request.json'), JSON.stringify(control)); await session.rewind(control);
} else await session.commit();
throw new Error('expected controller death');
`);
      await host.close(); host = undefined;
      const killed = spawnSync(process.execPath, ['--experimental-strip-types', join(directory, 'controller.ts')], { encoding: 'utf8', timeout: 90000 });
      assert.equal(killed.signal, 'SIGKILL', `${boundary}: ${killed.stderr}`);
      host = await ProcessHost.open(f.options);
      const resumed = ProcessResumableSession.reopen({ ...sessionOptions(f, host), effects: effectFactory(f, directory) }, id);
      if (boundary !== 'checkpoint-committed') {
        assert.equal(host.checkpointStatus(id).state, 'active');
        assert.deepEqual(await host.snapshot(), input.before);
        await assert.rejects(host.call(f.read, [{ tag: 'ref', value: input.ref }], { operationId: 'blocked-after-kill', tokens: host.issueTokens(f.read) }), /checkpoint lease/);
        if (boundary.startsWith('checkpoint-control-')) {
          const request = JSON.parse(readFileSync(join(directory, 'control-request.json'), 'utf8'));
          const receipt = await resumed.rewind(request); assert.deepEqual(await resumed.rewind(request), receipt);
          const rewound = await host.readCheckpoint(id); assert.equal(rewound.core.effectCursor, '0'); assert.ok(rewound.core.frames.length > 1); assert.equal(rewound.core.tasks[0].state, 'pending');
          await assert.rejects(resumed.correct({ kind: 'record', operationId: 'after-death-correction', expectedCheckpoint: checkpointDigest(rewound), reference: input.mapped, field: 'value', value: integer(100) }), /replay debt/);
        } else if (boundary === 'checkpoint-saved') {
          const saved = await host.readCheckpoint(id); assert.ok(saved.core.frames.length > 1); assert.equal(saved.core.tasks[0].state, 'pending');
        } else await resumed.reconcile();
        assert.equal((await resumed.run()).state, 'completed');
      }
      const receipt = await resumed.commit(); assert.deepEqual(await resumed.commit(), receipt);
      const rows = JSON.parse(readFileSync(join(directory, 'sink.json'), 'utf8'));
      assert.deepEqual(rows.map((row: { value: string }) => row.value), ['7', '9'], boundary);
      assert.equal(new Set(rows.map((row: { id: string }) => row.id)).size, 2);
      const mapped = await resumed.publishedReference(input.mapped), result = await host.call(f.read, [{ tag: 'ref', value: mapped }], { operationId: 'after-kill', tokens: host.issueTokens(f.read) });
      assert.equal(result.state, 'completed');
      if (result.state === 'completed' && result.execution.ok) { assert.equal(result.execution.value.tag, 'int'); assert.equal((result.execution.value as { value: string }).value, '9'); } else assert.fail('production state was not recovered');
    } finally { await host?.close(); }
  }
});
