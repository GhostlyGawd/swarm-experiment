import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { typeName } from '../../src/tier1/ids.ts';
import type { Ty } from '../../src/tier1/ast.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { atomicWrite, encodeStored } from '../../src/tier1/persistence.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { DurableEffectBroker, type EffectAdapter, type EffectEventV1 } from '../../src/fabric/effects.ts';
import { ResumableRuntime, type ResumableEffects } from '../../src/tier3/resumable-runtime.ts';
import { checkpointDigest, machineClone, machineDigest, eventDigest, MACHINE_LIMITS } from '../../src/tier3/resumable-state.ts';
import { ResumableCheckpointStore, type CheckpointPersistenceFault } from '../../src/tier3/resumable-checkpoint.ts';
const directories: string[] = [];
function temporary() { const directory = mkdtempSync(join(tmpdir(), 'aether-resumable-effects-')); directories.push(directory); return directory; }
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
const digest = (name: string) => domainDigest('aether.resumable-test/1', name);
function fixture() {
  const symbols = new SymbolSpace('checkpoint-effects'), entry = symbols.define('entry'), callee = symbols.define('callee'), x = symbols.define('x'), task = symbols.define('task'), y = symbols.define('y');
  const registry = new CapabilityRegistry(), cap = registry.declare('cap:test:emit', { arity: 1, description: 'append test output' }).name;
  const target = b.fn({ symbol: callee, params: [b.param(x, b.Int)], returns: b.Int, purity: 'effectful', capabilities: [cap], body: b.block(b.exprStmt(b.invoke(cap, b.v(x))), b.ret(b.add(b.v(x), b.int(3)))) });
  const main = b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, purity: 'effectful', capabilities: [cap], body: b.block(b.let_(task, { t: 'Task', result: b.Int }, b.spawn(b.call(callee, b.v(x)))), b.let_(y, b.Int, b.call(callee, b.v(x))), b.ret(b.add(b.v(y), b.await_(b.v(task))))) });
  const module = b.module_({ symbol: symbols.define('module'), members: [target, main], symbolTable: symbols.table() }), store = new GraphStore();
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module), specRoot: digest('spec'), dependencies: [{ symbol: callee, declaration: store.intern(target) }], semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'), target: { abiVersion: 'resumable/1', profileDigest: digest('target'), artifactDigest: digest('artifact') }, capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence') };
  return { module, manifest, registry, cap, entry };
}
function sink(directory: string): EffectAdapter {
  const file = join(directory, 'sink.json');
  return { id: 'durable-test-sink', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true },
    execute: request => { const key = `${request.executionId}:${request.effectId}`, values: string[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []; if (!values.includes(key)) { values.push(key); atomicWrite(file, JSON.stringify(values)); } return { tag: 'null' }; },
    reconcile: request => { const values: string[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []; return values.includes(`${request.executionId}:${request.effectId}`) ? { state: 'committed', value: { tag: 'null' } } : { state: 'not_committed' }; },
  };
}
function setup(f: ReturnType<typeof fixture>, directory = temporary(), mode: 'live' | 'replay' | 'shadow' | 'speculative' = 'live', trace: readonly EffectEventV1[] = [], branchId: string | null = null) {
  const adapter = sink(directory);
  const broker = new DurableEffectBroker({ directory: join(directory, 'broker'), mode, clockDomain: 'test', clock: () => 1n, authorize: () => true, authorizeReconciliation: () => true, replayEvents: trace });
  const effects: ResumableEffects = { broker, adapters: new Map([[f.cap, adapter]]), policyEpoch: '0', deadline: '100', grant: () => 'grant' };
  const runtime = new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: 'execution', capabilities: () => [f.cap], effects, mode, branchId });
  return { runtime, directory, broker, adapter, effects };
}
function pauseBeforeEffect(runtime: ResumableRuntime): void {
  for (let count = 0; count < 100; count++) {
    const frame = runtime.inspect().frames.at(-1); if (frame && runtime.program.codes.find(code => code.id === frame.code)!.instructions[frame.pc].op === 'effect') return;
    runtime.step();
  }
  throw new Error('effect safe point not reached');
}
const path = (relative: string) => new URL(`../../src/${relative}`, import.meta.url).href;
function childSource(metadata: string, directory: string, fault: string, checkpointFault = false): string {
  return `import{readFileSync,existsSync}from'node:fs';import{join}from'node:path';import{decodeStored,atomicWrite}from ${JSON.stringify(path('tier1/persistence.ts'))};import{CapabilityRegistry}from ${JSON.stringify(path('tier2/ocap.ts'))};import{DurableEffectBroker}from ${JSON.stringify(path('fabric/effects.ts'))};import{ResumableRuntime}from ${JSON.stringify(path('tier3/resumable-runtime.ts'))};import{ResumableCheckpointStore}from ${JSON.stringify(path('tier3/resumable-checkpoint.ts'))};const input=decodeStored(readFileSync(${JSON.stringify(metadata)},'utf8'));const registry=new CapabilityRegistry();const cap=registry.declare('cap:test:emit',{arity:1,description:'append test output'}).name;const sinkFile=join(${JSON.stringify(directory)},'sink.json');const adapter={id:'durable-test-sink',semantics:{readOnly:false,atomicIdempotency:true,transactional:false,reconciliation:true},execute:r=>{const values=existsSync(sinkFile)?JSON.parse(readFileSync(sinkFile,'utf8')):[];const key=r.executionId+':'+r.effectId;if(!values.includes(key)){values.push(key);atomicWrite(sinkFile,JSON.stringify(values));}return{tag:'null'};},reconcile:r=>({state:'committed',value:{tag:'null'}})};const broker=new DurableEffectBroker({directory:join(${JSON.stringify(directory)},'broker'),clockDomain:'test',clock:()=>1n,authorize:()=>true,authorizeReconciliation:()=>true,beforePersist:event=>{if(${JSON.stringify(fault)}==='after-sink-before-receipt'&&event.state==='committed')process.kill(process.pid,'SIGKILL');}});const effects={broker,adapters:new Map([[cap,adapter]]),policyEpoch:'0',deadline:'100',grant:()=>'grant'};const runtime=new ResumableRuntime(input.module,{manifest:input.manifest,registry,executionId:'execution',capabilities:()=>[cap],effects,fault:point=>{if(!${checkpointFault}&&point===${JSON.stringify(fault)})process.kill(process.pid,'SIGKILL');}});const store=new ResumableCheckpointStore({directory:join(${JSON.stringify(directory)},'checkpoints'),program:runtime.program,executionId:'execution',fault:point=>{if(${checkpointFault}&&point===${JSON.stringify(fault)})process.kill(process.pid,'SIGKILL');}});const head=store.head();runtime.restore(store.load(),head.snapshot);runtime.step();${checkpointFault ? 'store.save(runtime.snapshot(),head.id);' : ''}`;
}

test('live rewind across committed effects consumes stable broker receipts and never redispatches the sink', () => {
  const f = fixture(), world = setup(f); world.runtime.start(f.entry, [4n]); pauseBeforeEffect(world.runtime); const before = world.runtime.snapshot();
  assert.equal(before.core.frames.length, 2); assert.equal(before.core.tasks[0].state, 'pending');
  world.runtime.run(); const completed = world.runtime.snapshot(); assert.equal(world.runtime.decodeValue(world.runtime.result().value!), 14n);
  assert.equal(JSON.parse(readFileSync(join(world.directory, 'sink.json'), 'utf8')).length, 2);
  world.runtime.restore(before, checkpointDigest(before)); world.runtime.run(); assert.deepEqual(world.runtime.snapshot(), completed);
  assert.equal(JSON.parse(readFileSync(join(world.directory, 'sink.json'), 'utf8')).length, 2);
});

test('replay and shadow checkpoints restore the recorded effect prefix without any live adapter invocation', () => {
  const f = fixture(), live = setup(f); live.runtime.start(f.entry, [5n]); live.runtime.run(); const events = live.broker.events();
  for (const mode of ['replay', 'shadow'] as const) {
    const replay = setup(f, temporary(), mode, events);
    replay.runtime.start(f.entry, [5n]); while (replay.runtime.inspect().effectCursor !== '1') replay.runtime.step();
    const snapshot = replay.runtime.snapshot(), reopened = setup(f, temporary(), mode, events);
    reopened.runtime.restore(snapshot, checkpointDigest(snapshot)); assert.equal(reopened.broker.replayRemaining, 1); reopened.runtime.run(); assert.equal(reopened.runtime.decodeValue(reopened.runtime.result().value!), 16n); reopened.broker.assertReplayComplete();
    assert.equal(existsSync(join(reopened.directory, 'sink.json')), false); assert.equal(existsSync(join(replay.directory, 'sink.json')), false);
    reopened.runtime.rewind(10); reopened.runtime.run(); reopened.broker.assertReplayComplete(); assert.equal(existsSync(join(reopened.directory, 'sink.json')), false);
  }
});

for (const fault of ['before-effect', 'after-effect', 'after-sink-before-receipt']) test(`actual process death ${fault} resumes nested frames/tasks without duplicate effects`, () => {
  const f = fixture(), world = setup(f); world.runtime.start(f.entry, [7n]); pauseBeforeEffect(world.runtime);
  const store = new ResumableCheckpointStore({ directory: join(world.directory, 'checkpoints'), program: world.runtime.program, executionId: 'execution' }); store.save(world.runtime.snapshot(), null);
  const metadata = join(world.directory, 'program.json'); writeFileSync(metadata, encodeStored({ module: f.module, manifest: f.manifest }));
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childSource(metadata, world.directory, fault)], { encoding: 'utf8' }); assert.equal(child.signal, 'SIGKILL', child.stderr);
  const resumed = setup(f, world.directory), head = store.head()!; resumed.broker.recoverDeadWriter(); resumed.runtime.restore(store.load(), head.snapshot);
  if (fault === 'after-sink-before-receipt') {
    assert.equal(resumed.runtime.step().state, 'blocked'); const blocked = resumed.runtime.snapshot(); assert.equal(blocked.core.effectCursor, '0');
    const event = resumed.broker.events()[0]; assert.equal(resumed.broker.reconcile(event.request, resumed.adapter).state, 'committed'); resumed.runtime.retryBlocked();
  }
  assert.equal(resumed.runtime.run().state, 'completed'); assert.equal(resumed.runtime.decodeValue(resumed.runtime.result().value!), 20n);
  assert.equal(JSON.parse(readFileSync(join(world.directory, 'sink.json'), 'utf8')).length, 2);
});

for (const fault of ['before-event-publish', 'after-event-publish', 'before-checkpoint-publish', 'after-checkpoint-publish', 'before-head-publish', 'after-head-publish'] satisfies CheckpointPersistenceFault[]) test(`actual process death ${fault} leaves a complete prior or next durable checkpoint`, () => {
  const f = fixture(), world = setup(f); world.runtime.start(f.entry, [2n]); pauseBeforeEffect(world.runtime);
  const store = new ResumableCheckpointStore({ directory: join(world.directory, 'checkpoints'), program: world.runtime.program, executionId: 'execution' }); const previous = store.save(world.runtime.snapshot(), null);
  const metadata = join(world.directory, 'program.json'); writeFileSync(metadata, encodeStored({ module: f.module, manifest: f.manifest }));
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childSource(metadata, world.directory, fault, true)], { encoding: 'utf8' }); assert.equal(child.signal, 'SIGKILL', child.stderr);
  const reopened = new ResumableCheckpointStore({ directory: join(world.directory, 'checkpoints'), program: world.runtime.program, executionId: 'execution' }), head = reopened.head()!;
  assert.equal(head.generation, fault === 'after-head-publish' ? 2 : 1); if (fault !== 'after-head-publish') assert.equal(head.id, previous.id);
  const resumed = setup(f, world.directory); resumed.runtime.restore(reopened.load(), head.snapshot); assert.equal(resumed.runtime.run().state, 'completed');
  assert.equal(JSON.parse(readFileSync(join(world.directory, 'sink.json'), 'utf8')).length, 2);
});


test('precommit exception after sink success rolls back machine state and safely retries the durable receipt', () => {
  const f = fixture(), world = setup(f); let armed = true;
  const runtime = new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: 'execution', capabilities: () => [f.cap], effects: world.effects, fault: point => {
    if (armed && point === 'before-instruction-commit' && runtime.inspect().effectCursor === '1') { armed = false; throw new Error('precommit exception after receipt'); }
  } });
  runtime.start(f.entry, [3n]); pauseBeforeEffect(runtime); const before = runtime.snapshot();
  assert.throws(() => runtime.step(), /precommit exception/); assert.deepEqual(runtime.snapshot(), before);
  assert.equal(JSON.parse(readFileSync(join(world.directory, 'sink.json'), 'utf8')).length, 1);
  assert.equal(runtime.run().state, 'completed'); assert.equal(JSON.parse(readFileSync(join(world.directory, 'sink.json'), 'utf8')).length, 2);
});

test('multiple record allocations keep replay identity after reconciled effects and across live/replay modes', () => {
  const symbols = new SymbolSpace('effect-allocation-parity'), entry = symbols.define('entry'), first = symbols.define('first'), second = symbols.define('second');
  const registry = new CapabilityRegistry(), cap = registry.declare('cap:test:emit', { arity: 1, description: 'append test output' }).name;
  const box: Ty = { t: 'Record', name: typeName('type:test:effect_box'), fields: [['value', b.Int]] };
  const module = b.module_({ symbol: symbols.define('module'), members: [b.fn({ symbol: entry, returns: b.Int, purity: 'effectful', capabilities: [cap], body: b.block(b.let_(first, box, b.record(box, { value: b.int(1) })), b.exprStmt(b.invoke(cap, b.v(first))), b.let_(second, box, b.record(box, { value: b.int(2) })), b.exprStmt(b.invoke(cap, b.v(second))), b.ret(b.int(0))) })], symbolTable: symbols.table() });
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: new GraphStore().intern(module), specRoot: digest('allocation-spec'), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: digest('allocation-compiler'), target: { abiVersion: 'resumable/1', profileDigest: digest('target'), artifactDigest: digest('allocation-artifact') }, capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence') };
  const f = { module, manifest, registry, cap, entry }, baseline = setup(f); baseline.runtime.start(entry, []); baseline.runtime.run();
  const expected = baseline.broker.events().map(event => event.request.payload);
  const directory = temporary(), adapter = sink(directory); let fail = true, clock = 1n;
  const broker = new DurableEffectBroker({ directory: join(directory, 'broker'), clockDomain: 'test', clock: () => clock, authorize: () => true, authorizeReconciliation: () => true, beforePersist: event => { if (fail && event.state === 'committed') { fail = false; throw new Error('receipt storage interrupted'); } } });
  const effects: ResumableEffects = { broker, adapters: new Map([[cap, adapter]]), policyEpoch: '0', deadline: '100', grant: () => 'grant' };
  const recovered = new ResumableRuntime(module, { manifest, registry, executionId: 'execution', capabilities: () => [cap], effects }); recovered.start(entry, []); assert.equal(recovered.run().state, 'blocked');
  clock = 5n; assert.equal(broker.reconcile(broker.events()[0].request, adapter).state, 'committed'); recovered.retryBlocked(); assert.equal(recovered.run().state, 'completed');
  assert.deepEqual(broker.events().map(event => event.request.payload), expected, 'recovery bookkeeping cannot change later reference epochs');
  assert.deepEqual(recovered.inspect().records.map(record => record.epoch), baseline.runtime.inspect().records.map(record => record.epoch));
  const replay = setup(f, temporary(), 'replay', broker.events()); replay.runtime.start(entry, []); assert.equal(replay.runtime.run().state, 'completed'); replay.broker.assertReplayComplete();
  assert.deepEqual(replay.runtime.inspect().records.map(record => record.epoch), recovered.inspect().records.map(record => record.epoch));
  assert.equal(existsSync(join(replay.directory, 'sink.json')), false);
});


test('resume rechecks trusted host authority and rejects a forged machine effect prefix before moving broker cursor', () => {
  const f = fixture(), live = setup(f); live.runtime.start(f.entry, [1n]); while (live.runtime.inspect().effectCursor !== '1') live.runtime.step();
  const snapshot = live.runtime.snapshot();
  const denied = new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: 'execution', capabilities: () => [], effects: live.effects });
  const unchanged = denied.snapshot(); assert.throws(() => denied.restore(snapshot, checkpointDigest(snapshot)), /grant current/); assert.deepEqual(denied.snapshot(), unchanged);
  live.runtime.run();
  const replay = setup(f, temporary(), 'replay', live.broker.events());
  const running = setup(f, temporary(), 'replay', live.broker.events()); running.runtime.start(f.entry, [1n]); while (running.runtime.inspect().effectCursor !== '1') running.runtime.step();
  const bad = machineClone(running.runtime.snapshot());
  bad.core.effectPrefix[0] = { ...bad.core.effectPrefix[0], outcomeDigest: domainDigest('aether.effect-replay-outcome/1', 'forged') };
  const last = bad.events.at(-1)!; last.delta.find(delta => delta.section === 'effectPrefix')!.after = machineClone(bad.core.effectPrefix); last.after = machineDigest(bad.core); bad.eventHead = eventDigest(last);
  assert.throws(() => replay.runtime.restore(bad, checkpointDigest(bad)), /effect prefix/); assert.equal(replay.broker.replayRemaining, 2);
});


test('malformed string and duplicate-array capability providers cannot authorize checkpoint execution', () => {
  const f = fixture(), world = setup(f);
  for (const capabilities of [() => f.cap as unknown as readonly typeof f.cap[], () => [f.cap, f.cap]]) {
    const runtime = new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: 'execution', effects: world.effects, capabilities });
    const before = runtime.snapshot(); assert.throws(() => runtime.start(f.entry, [1n]), /canonical array|unique canonical/); assert.deepEqual(runtime.snapshot(), before);
  }
  assert.equal(existsSync(join(world.directory, 'sink.json')), false);
});


test('byte quota refusal after a committed effect preserves a reloadable checkpoint and its reusable receipt', () => {
  const f = fixture(), world = setup(f); world.runtime.start(f.entry, [2n]); pauseBeforeEffect(world.runtime); const snapshot = world.runtime.snapshot();
  const maxCheckpointBytes = Math.max(4096, encodeCanonical(snapshot, MACHINE_LIMITS).byteLength + 16);
  const tight = new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: 'execution', capabilities: () => [f.cap], effects: world.effects, maxCheckpointBytes });
  tight.restore(snapshot, checkpointDigest(snapshot)); assert.throws(() => tight.step(), /byte limit/); assert.deepEqual(tight.snapshot(), snapshot);
  assert.equal(JSON.parse(readFileSync(join(world.directory, 'sink.json'), 'utf8')).length, 1);
  world.runtime.restore(tight.snapshot(), checkpointDigest(snapshot)); assert.equal(world.runtime.run().state, 'completed');
  assert.equal(JSON.parse(readFileSync(join(world.directory, 'sink.json'), 'utf8')).length, 2);
});


test('fresh isolated runtimes restore buffered intent outcomes and rewind their active buffers without dispatch', () => {
  const f = fixture();
  for (const mode of ['shadow', 'speculative'] as const) {
    const original = setup(f, temporary(), mode, [], 'branch'); original.runtime.start(f.entry, [1n]); pauseBeforeEffect(original.runtime); const before = original.runtime.snapshot();
    assert.equal(original.runtime.run().state, 'faulted'); const snapshot = original.runtime.snapshot();
    assert.equal(snapshot.core.effectCursor, '1'); assert.equal(snapshot.core.effectPrefix.length, 0); assert.equal(snapshot.core.isolatedEffects.length, 1);
    assert.equal(original.broker.intents().length, 1); assert.equal(existsSync(join(original.directory, 'sink.json')), false);
    const resumed = setup(f, temporary(), mode, [], 'branch'); resumed.runtime.restore(snapshot, checkpointDigest(snapshot)); assert.deepEqual(resumed.runtime.snapshot(), snapshot); assert.deepEqual(resumed.broker.intents(), original.broker.intents());
    resumed.runtime.restore(before, checkpointDigest(before)); assert.equal(resumed.broker.intents().length, 0); resumed.runtime.run(); assert.equal(resumed.broker.intents().length, 1); assert.equal(existsSync(join(resumed.directory, 'sink.json')), false);
  }
});

test('grant and broker callbacks cannot revoke the host envelope and still reach a live sink', () => {
  const f = fixture();
  for (const point of ['grant', 'broker'] as const) {
    let allowed = true, writes = 0;
    const adapter: EffectAdapter = { id: 'guarded', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true }, execute: () => { writes++; return { tag: 'null' }; }, reconcile: () => ({ state: 'not_committed' }) };
    const broker = new DurableEffectBroker({ directory: temporary(), clockDomain: 'test', clock: () => 1n, authorize: () => { if (point === 'broker') allowed = false; return true; }, authorizeReconciliation: () => true });
    const runtime = new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: 'execution', capabilities: () => allowed ? [f.cap] : [], effects: { broker, adapters: new Map([[f.cap, adapter]]), policyEpoch: '0', deadline: '100', grant: () => { if (point === 'grant') allowed = false; return 'grant'; } } });
    runtime.start(f.entry, [1n]); const result = runtime.run(); assert.ok(result.state === 'faulted' || result.state === 'blocked'); assert.equal(writes, 0); runtime.snapshot();
  }
});

test('non-Unit effect values cannot violate the language Invoke return contract', () => {
  const f = fixture(); let writes = 0;
  const adapter: EffectAdapter = { id: 'wrong-output', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: false }, execute: () => { writes++; return { tag: 'string', value: 'wrong' }; } };
  const broker = new DurableEffectBroker({ directory: temporary(), clockDomain: 'test', clock: () => 1n, authorize: () => true });
  const runtime = new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: 'execution', capabilities: () => [f.cap], effects: { broker, adapters: new Map([[f.cap, adapter]]), policyEpoch: '0', deadline: '100', grant: () => 'grant' } });
  runtime.start(f.entry, [1n]); assert.equal(runtime.run().state, 'faulted'); assert.equal(runtime.result().fault?.kind, 'type_error'); assert.equal(runtime.snapshot().core.effectPrefix.length, 1); assert.equal(writes, 1);
});
