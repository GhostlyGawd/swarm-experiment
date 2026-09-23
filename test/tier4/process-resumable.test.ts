import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { ProcessHost, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { ProcessResumableSession, type ProcessResumableOptions } from '../../src/tier4/process-resumable.ts';
import { seedProcessCheckpoint, seededProcessReference } from '../../src/tier4/process-checkpoint-contract.ts';
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

test('fresh controllers recover SIGKILL at checkpoint, effect receipt and publication boundaries', async () => {
  for (const boundary of ['checkpoint-saved', 'effect-receipt', 'checkpoint-committed']) {
    const f = fixture(false, true); let host: ProcessHost | undefined;
    try {
      host = await ProcessHost.open(f.options); const input = await source(f, host);
      const session = await ProcessResumableSession.begin({ ...sessionOptions(f, host), effects: effectFactory(f, f.options.directory) }, input.base, input.initial, { operationId: boundary, symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
      const id = session.binding.id, directory = f.options.directory;
      writeFileSync(join(directory, 'child-input.json'), encodeStored({ module: f.module, manifest: f.manifest, plan: f.options.plan, main: f.main, cap: f.cap, id }));
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
const directory = ${JSON.stringify(directory)}, boundary = ${JSON.stringify(boundary)};
const f = decodeStored(readFileSync(join(directory, 'child-input.json'), 'utf8'));
const registry = new CapabilityRegistry(); registry.declare(f.cap, { arity: 1, description: 'Observe the leased production record.' });
const host = await ProcessHost.open({ directory, module: f.module, manifest: f.manifest, registry, plan: f.plan, sealer: new CapabilitySealer(new Uint8Array(32).fill(19)), authorizeCheckpoint: () => true,
  onPhase: phase => { if (phase === boundary) process.kill(process.pid, 'SIGKILL'); } });
const effectFactory = ${factory};
const session = ProcessResumableSession.reopen({ host, module: f.module, runtime: { manifest: f.manifest, registry }, tokens: () => host.issueTokens(f.main), effects: effectFactory(f, directory, boundary === 'effect-receipt') }, f.id);
await session.run(); await session.commit();
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
        if (boundary === 'checkpoint-saved') {
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
