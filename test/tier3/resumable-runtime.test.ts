import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { children, type Term, type Ty } from '../../src/tier1/ast.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { typeName, type SymbolId } from '../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { checkpointDigest, machineClone, machineDigest, eventDigest, validateResumableSnapshot } from '../../src/tier3/resumable-state.ts';
import { ResumableRuntime, type ResumableRuntimeOptions, type ResumableRef } from '../../src/tier3/resumable-runtime.ts';
import { ResumableCheckpointStore } from '../../src/tier3/resumable-checkpoint.ts';
import { validateMachineTypeBindings } from '../../src/tier3/resumable-types.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { encodeStored } from '../../src/tier1/persistence.ts';

const directories: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), 'aether-resumable-')); directories.push(path); return path; }
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));
const digest = (name: string) => domainDigest('aether.resumable-test/1', name);
const fn = (spec: Parameters<typeof b.fn>[0]) => b.fn(spec) as Extract<Term, { kind: 'FunctionDecl' }>;
function fixture(members: Term[], symbols: SymbolSpace, executionId = 'execution') {
  const module = b.module_({ symbol: symbols.define('module'), members, symbolTable: symbols.table() }), store = new GraphStore();
  const declarations = new Map(members.filter((member): member is Extract<Term, { kind: 'FunctionDecl' }> => member.kind === 'FunctionDecl').map(member => [member.symbol, member]));
  const dependencies = new Set<SymbolId>();
  const scan = (node: Term): void => { if (node.kind === 'Call' || node.kind === 'SeqMap' || node.kind === 'SeqFold') dependencies.add(node.callee); children(node).forEach(scan); }; scan(module);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module), specRoot: digest('spec'), dependencies: [...dependencies].sort().map(symbol => ({ symbol, declaration: store.intern(declarations.get(symbol)!) })), semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'), target: { abiVersion: 'resumable/1', profileDigest: digest('target'), artifactDigest: digest('artifact') }, capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence') };
  const options: ResumableRuntimeOptions = { manifest, registry: new CapabilityRegistry(), executionId };
  return { module, options, runtime: () => new ResumableRuntime(module, options) };
}
function pendingFixture() {
  const symbols = new SymbolSpace('resumable-pending'), entry = symbols.define('entry'), callee = symbols.define('callee'), x = symbols.define('x'), task = symbols.define('task'), y = symbols.define('y');
  const target = fn({ symbol: callee, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.add(b.v(x), b.int(3))) });
  const main = fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, body: b.block(b.let_(task, { t: 'Task', result: b.Int }, b.spawn(b.call(callee, b.v(x)))), b.let_(y, b.Int, b.call(callee, b.v(x))), b.ret(b.add(b.v(y), b.await_(b.v(task))))) });
  return { ...fixture([target, main], symbols), entry, callee, symbols };
}

test('nonempty nested frames and a pending task resume from real durable checkpoints with identical state/events', () => {
  const f = pendingFixture(), interrupted = f.runtime(), uninterrupted = f.runtime();
  interrupted.start(f.entry, [4n]); uninterrupted.start(f.entry, [4n]);
  for (let step = 0; step < 50 && !(interrupted.inspect().frames.length === 2 && interrupted.inspect().tasks.some(task => task.state === 'pending')); step++) interrupted.step();
  const paused = interrupted.snapshot(); assert.equal(paused.core.frames.length, 2); assert.equal(paused.core.tasks[0].state, 'pending'); assert.ok(paused.core.environments.length > 2);
  const directory = temp(), store = new ResumableCheckpointStore({ directory, program: interrupted.program, executionId: 'execution' });
  const head = store.save(paused, null);
  const reopened = new ResumableCheckpointStore({ directory, program: interrupted.program, executionId: 'execution' });
  const resumed = f.runtime(); resumed.restore(reopened.load(head.id), head.snapshot);
  assert.equal(resumed.run().state, 'completed'); assert.equal(uninterrupted.run().state, 'completed');
  assert.deepEqual(resumed.snapshot(), uninterrupted.snapshot()); assert.equal(resumed.decodeValue(resumed.result().value!), 14n);
  assert.equal(resumed.inspect().tasks[0].state, 'completed');
});

test('rewind restores active frames and registers and deterministically reexecutes the same continuation', () => {
  const f = pendingFixture(), runtime = f.runtime(); runtime.start(f.entry, [5n]); runtime.run();
  const completed = runtime.snapshot(); runtime.rewind(8); const rewound = runtime.snapshot();
  assert.ok(rewound.core.frames.length > 0); assert.ok(rewound.core.steps < completed.core.steps);
  runtime.run(); assert.deepEqual(runtime.snapshot(), completed);
});

test('fresh process opens a mid-call checkpoint with pending task and completes the actual continuation', () => {
  const f = pendingFixture(), runtime = f.runtime(); runtime.start(f.entry, [6n]);
  while (!(runtime.inspect().frames.length === 2 && runtime.inspect().tasks.some(task => task.state === 'pending'))) runtime.step();
  const directory = temp(), metadata = join(directory, 'input.json');
  const store = new ResumableCheckpointStore({ directory: join(directory, 'checkpoints'), program: runtime.program, executionId: 'execution' }); store.save(runtime.snapshot(), null);
  writeFileSync(metadata, encodeStored({ module: f.module, manifest: f.options.manifest }));
  const source = `import{readFileSync}from'node:fs';import{decodeStored}from ${JSON.stringify(new URL('../../src/tier1/persistence.ts', import.meta.url).href)};import{CapabilityRegistry}from ${JSON.stringify(new URL('../../src/tier2/ocap.ts', import.meta.url).href)};import{ResumableRuntime}from ${JSON.stringify(new URL('../../src/tier3/resumable-runtime.ts', import.meta.url).href)};import{ResumableCheckpointStore}from ${JSON.stringify(new URL('../../src/tier3/resumable-checkpoint.ts', import.meta.url).href)};const input=decodeStored(readFileSync(${JSON.stringify(metadata)},'utf8'));const runtime=new ResumableRuntime(input.module,{manifest:input.manifest,registry:new CapabilityRegistry(),executionId:'execution'});const store=new ResumableCheckpointStore({directory:${JSON.stringify(join(directory, 'checkpoints'))},program:runtime.program,executionId:'execution'});const head=store.head();runtime.restore(store.load(),head.snapshot);console.log(JSON.stringify({beforeFrames:runtime.inspect().frames.length,beforeTasks:runtime.inspect().tasks.filter(t=>t.state==='pending').length,result:runtime.run()}));`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); const output = JSON.parse(child.stdout); assert.equal(output.beforeFrames, 2); assert.equal(output.beforeTasks, 1); assert.equal(output.result.value.value, '18');
});

test('closure captures retain capture-time scopes and shared sequence/result identity through resume', () => {
  const symbols = new SymbolSpace('resumable-captures'), entry = symbols.define('entry'), x = symbols.define('x'), closure = symbols.define('closure'), sequence = symbols.define('sequence'), a = symbols.define('a'), bSymbol = symbols.define('b');
  const fnType: Ty = { t: 'Fn', params: [], returns: b.Int, capabilities: [] };
  const main = fn({ symbol: entry, returns: b.Int, body: b.block(b.let_(x, b.Int, b.int(10)), b.let_(closure, fnType, b.lambda({ returns: b.Int, body: b.v(x) })), b.assign(b.place(x), b.int(99)), b.ret(b.apply(b.v(closure)))) });
  const equality = fn({ symbol: sequence, returns: b.Bool, body: b.block(b.let_(a, { t: 'Seq', element: b.Int }, b.seq(b.Int, b.int(1))), b.let_(bSymbol, { t: 'Seq', element: b.Int }, b.v(a)), b.ret(b.eq(b.v(a), b.v(bSymbol)))) });
  const f = fixture([main, equality], symbols), runtime = f.runtime(); runtime.start(entry, []);
  while (!runtime.inspect().closures.length) runtime.step(); const snapshot = runtime.snapshot(); const resumed = f.runtime(); resumed.restore(snapshot, checkpointDigest(snapshot)); resumed.run(); assert.equal(resumed.decodeValue(resumed.result().value!), 10n);
  const reference = new Runtime({ registry: f.options.registry }); reference.load(f.module); const value = reference.call(entry, []); assert.equal(value.ok, true); if (value.ok) assert.equal(value.value, 10n);
  const identity = f.runtime(); identity.start(sequence, []); identity.run(8); const saved = identity.snapshot(); const reopened = f.runtime(); reopened.restore(saved, checkpointDigest(saved)); reopened.run(); assert.equal(reopened.decodeValue(reopened.result().value!), true);
});

test('record aliases/cycles and native inspection survive rewind and restore', () => {
  const symbols = new SymbolSpace('resumable-heap'), entry = symbols.define('entry');
  const f = fixture([fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) })], symbols);
  const recordType: Ty = { t: 'Record', name: typeName('type:test:node'), fields: [['value', b.Int], ['next', b.Unit]] };
  const runtime = new ResumableRuntime(f.module, { ...f.options, authorizeCorrection: () => true });
  const reference = runtime.allocateRecord(recordType, { value: 7n, next: null }); runtime.correctRecord(reference, 'next', reference);
  const snapshot = runtime.snapshot(), resumed = new ResumableRuntime(f.module, { ...f.options, authorizeCorrection: () => true }); resumed.restore(snapshot, checkpointDigest(snapshot));
  assert.deepEqual(resumed.readRecord(reference).get('next'), reference);
  resumed.correctRecord(reference, 'value', 8n); assert.equal(resumed.readRecord(reference).get('value'), 8n); resumed.rewind(1); assert.equal(resumed.readRecord(reference).get('value'), 7n);
});

test('post-rewind externally held future references cannot alias divergent new allocations', () => {
  const symbols = new SymbolSpace('resumable-allocation'), entry = symbols.define('entry');
  const f = fixture([fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) })], symbols), runtime = f.runtime();
  const recordType: Ty = { t: 'Record', name: typeName('type:test:box'), fields: [['value', b.Int]] };
  const before = runtime.snapshot(), original = runtime.allocateRecord(recordType, { value: 1n }); runtime.rewind(1);
  const replayed = runtime.allocateRecord(recordType, { value: 1n }); assert.deepEqual(replayed, original); assert.equal(runtime.readRecord(original).get('value'), 1n);
  runtime.restore(before, checkpointDigest(before)); const divergent = runtime.allocateRecord(recordType, { value: 2n });
  assert.equal(divergent.addr, original.addr); assert.notEqual(divergent.ownerEpoch, original.ownerEpoch); assert.throws(() => runtime.readRecord(original), /stale/); assert.equal(runtime.readRecord(divergent).get('value'), 2n);
  assert.throws(() => runtime.readRecord({ addr: original.addr }), /requires heap/);
});

test('checkpoint validation rejects stale code/schema, corrupt frame PCs and altered inverse events', () => {
  const f = pendingFixture(), runtime = f.runtime(); runtime.start(f.entry, [1n]); runtime.run(4); const snapshot = runtime.snapshot();
  const cases = [
    { ...snapshot, format: 'aether.resumable-state/2' },
    { ...snapshot, core: { ...snapshot.core, programDigest: digest('other-code') } },
    { ...snapshot, eventCursor: '999' },
  ];
  for (const value of cases) assert.throws(() => validateResumableSnapshot(value, runtime.program));
  const pc = machineClone(snapshot); pc.core.frames[0].pc = 999999; assert.throws(() => validateResumableSnapshot(pc, runtime.program), /counter/);
  const event = machineClone(snapshot); event.events[0].delta[0].before = 'forged'; assert.throws(() => validateResumableSnapshot(event, runtime.program), /event|state/);
  assert.throws(() => runtime.restore(snapshot, digest('wrong-checkpoint')), /trusted checkpoint digest/);
});

test('durable checkpoint heads use generation CAS and verify separately persisted event bytes', () => {
  const f = pendingFixture(), runtime = f.runtime(), directory = temp(); runtime.start(f.entry, [1n]);
  const store = new ResumableCheckpointStore({ directory, program: runtime.program, executionId: 'execution' }), head = store.save(runtime.snapshot(), null);
  runtime.run(2); const next = store.save(runtime.snapshot(), head.id);
  assert.throws(() => store.save(runtime.snapshot(), head.id), /compare-and-swap/); assert.equal(store.load(next.id).eventCursor, '3');
  const snapshot = store.load(head.id), eventFile = join(directory, 'events', `${snapshot.eventHead.split(':').at(-1)}.json`);
  writeFileSync(eventFile, '{}'); assert.throws(() => store.load(head.id), /event prefix/);
});

test('failed host allocations/corrections and precommit exceptions leave no unjournaled state', () => {
  const f = pendingFixture(); let fail = true;
  const runtime = new ResumableRuntime(f.module, { ...f.options, authorizeCorrection: () => true, fault: point => { if (fail && point === 'before-instruction-commit') { fail = false; throw new Error('injected precommit failure'); } } });
  const type: Ty = { t: 'Record', name: typeName('type:test:atomic_input'), fields: [['items', { t: 'Seq', element: b.Int }], ['link', b.Unit]] };
  const before = runtime.snapshot();
  assert.throws(() => runtime.allocateRecord(type, { items: [1n, 2n], link: { addr: 999, heapId: runtime.inspect().heapId, ownerEpoch: '0' } as ResumableRef }), /stale/);
  assert.deepEqual(runtime.snapshot(), before);
  const reference = runtime.allocateRecord(type, { items: [1n], link: null }), allocated = runtime.snapshot();
  assert.throws(() => runtime.correctRecord(reference, 'items', [2n, { addr: 999, heapId: reference.heapId, ownerEpoch: '0' } as ResumableRef]), /stale/);
  assert.deepEqual(runtime.snapshot(), allocated);
  runtime.start(f.entry, [1n]); const started = runtime.snapshot();
  assert.throws(() => runtime.step(), /precommit failure/); assert.deepEqual(runtime.snapshot(), started);
  assert.equal(runtime.run().state, 'completed');
});

test('fresh-process replay preserves allocation identity while divergence rejects a held future handle', () => {
  const symbols = new SymbolSpace('resumable-fresh-identity'), entry = symbols.define('entry');
  const f = fixture([fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) })], symbols), runtime = f.runtime();
  const type: Ty = { t: 'Record', name: typeName('type:test:identity_box'), fields: [['value', b.Int]] };
  const directory = temp(), store = new ResumableCheckpointStore({ directory: join(directory, 'checkpoints'), program: runtime.program, executionId: 'execution' }); store.save(runtime.snapshot(), null);
  const future = runtime.allocateRecord(type, { value: 1n }), input = join(directory, 'input.json'); writeFileSync(input, encodeStored({ module: f.module, manifest: f.options.manifest, type, future }));
  const source = `import{readFileSync}from'node:fs';import{decodeStored}from ${JSON.stringify(new URL('../../src/tier1/persistence.ts', import.meta.url).href)};import{CapabilityRegistry}from ${JSON.stringify(new URL('../../src/tier2/ocap.ts', import.meta.url).href)};import{ResumableRuntime}from ${JSON.stringify(new URL('../../src/tier3/resumable-runtime.ts', import.meta.url).href)};import{ResumableCheckpointStore}from ${JSON.stringify(new URL('../../src/tier3/resumable-checkpoint.ts', import.meta.url).href)};const data=decodeStored(readFileSync(${JSON.stringify(input)},'utf8'));const runtime=new ResumableRuntime(data.module,{manifest:data.manifest,registry:new CapabilityRegistry(),executionId:'execution'});const store=new ResumableCheckpointStore({directory:${JSON.stringify(join(directory, 'checkpoints'))},program:runtime.program,executionId:'execution'});const head=store.head(),snapshot=store.load();runtime.restore(snapshot,head.snapshot);const same=runtime.allocateRecord(data.type,{value:1n});runtime.restore(snapshot,head.snapshot);const different=runtime.allocateRecord(data.type,{value:2n});let rejected=false;try{runtime.readRecord(data.future);}catch{rejected=true;}console.log(JSON.stringify({same:same.ownerEpoch===data.future.ownerEpoch,different:different.ownerEpoch!==data.future.ownerEpoch,rejected}));`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { same: true, different: true, rejected: true });
});

test('sequence callbacks, Result matching, fixed arithmetic, strings and quantifiers survive intermediate checkpoints', () => {
  const symbols = new SymbolSpace('resumable-operators'), entry = symbols.define('entry'), double = symbols.define('double'), sum = symbols.define('sum'), x = symbols.define('x'), y = symbols.define('y'), quantified = symbols.define('q'), resultOk = symbols.define('ok'), resultErr = symbols.define('err');
  const byte: Extract<Ty, { t: 'IntN' }> = { t: 'IntN', bits: 8, signed: false, overflow: 'wrap' };
  const resultType: Extract<Ty, { t: 'Result' }> = { t: 'Result', ok: b.Int, err: b.Int };
  const expression: Term = { kind: 'MatchResult', value: { kind: 'ResultValue', variant: 'ok', ty: resultType, value: b.fold(b.map(b.seq(b.Int, b.int(1), b.int(2), b.int(3)), double), b.int(0), sum) }, okSymbol: resultOk, ok: b.v(resultOk), errSymbol: resultErr, err: b.v(resultErr) };
  const members = [fn({ symbol: double, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.mul(b.v(x), b.int(2))) }), fn({ symbol: sum, params: [b.param(x, b.Int), b.param(y, b.Int)], returns: b.Int, body: b.ret(b.add(b.v(x), b.v(y))) }), fn({ symbol: entry, returns: b.Int, body: b.block(b.assert_(b.forall(quantified, b.int(0), b.int(3), b.lt(b.v(quantified), b.int(3))), 'forall'), b.assert_(b.eq(b.strlen(b.slice(b.str('A😀BC'), b.int(1), b.int(3))), b.int(2)), 'unicode'), b.assert_(b.eq(b.fixed('add', byte, b.typed(byte, 255n), b.typed(byte, 1n)), b.typed(byte, 0n)), 'wrap'), b.ret(expression)) })];
  const f = fixture(members, symbols), runtime = f.runtime(); runtime.start(entry, []); runtime.run(40); const snapshot = runtime.snapshot();
  const resumed = f.runtime(); resumed.restore(snapshot, checkpointDigest(snapshot)); assert.equal(resumed.run().state, 'completed'); assert.equal(resumed.decodeValue(resumed.result().value!), 12n);
  const reference = new Runtime({ registry: f.options.registry }); reference.load(f.module); const result = reference.call(entry, []); assert.equal(result.ok, true); if (result.ok) assert.equal(result.value, 12n);
});

test('Atomic preserves successful return and restores heap on faults while keeping snapshots valid', () => {
  const symbols = new SymbolSpace('resumable-atomic'), success = symbols.define('success'), failure = symbols.define('failure'), account = symbols.define('account');
  const type: Ty = { t: 'Record', name: typeName('type:test:atomic_box'), fields: [['value', b.Int]] };
  const update = b.assign(b.place(account, 'value'), b.int(11));
  const members = [fn({ symbol: success, params: [b.param(account, type)], returns: b.Int, body: b.block(b.atomic(b.block(update, b.ret(b.int(11)))), b.ret(b.int(0))) }), fn({ symbol: failure, params: [b.param(account, type)], returns: b.Int, body: b.block(b.atomic(b.block(b.assign(b.place(account, 'value'), b.int(99)), b.assert_(b.bool(false), 'failure'))), b.ret(b.int(1))) })];
  const f = fixture(members, symbols), runtime = f.runtime(), reference = runtime.allocateRecord(type, { value: 1n });
  runtime.start(success, [reference]); assert.equal(runtime.run().state, 'completed'); assert.equal(runtime.readRecord(reference).get('value'), 11n); runtime.snapshot();
  runtime.start(failure, [reference]); assert.equal(runtime.run().state, 'faulted'); assert.equal(runtime.readRecord(reference).get('value'), 11n); runtime.snapshot();
});


test('cumulative checkpoint byte refusal preserves the last complete rewindable safe point', () => {
  const f = pendingFixture(), runtime = new ResumableRuntime(f.module, { ...f.options, maxCheckpointBytes: 8192 });
  runtime.start(f.entry, [1n]); let prior = runtime.snapshot(), refused = false;
  for (let index = 0; index < 100 && runtime.result().state === 'running'; index++) {
    try { runtime.step(); prior = runtime.snapshot(); }
    catch (error) { assert.match(String(error), /byte limit/); assert.deepEqual(runtime.snapshot(), prior); refused = true; break; }
  }
  assert.equal(refused, true);
  runtime.rewind(1); assert.ok(runtime.snapshot().events.length < prior.events.length);
});


test('typed entry/allocation boundaries and serialized generic bindings reject incompatible values', () => {
  const symbols = new SymbolSpace('resumable-boundaries'), entry = symbols.define('entry'), generic = symbols.define('generic'), x = symbols.define('x');
  const members = [fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.v(x)) }), fn({ symbol: generic, typeParams: ['T'], params: [b.param(x, { t: 'TypeVar', name: 'T' })], returns: { t: 'TypeVar', name: 'T' }, body: b.ret(b.v(x)) })];
  const f = fixture(members, symbols), runtime = f.runtime(), before = runtime.snapshot();
  assert.throws(() => runtime.start(entry, ['wrong']), /expects Int/); assert.deepEqual(runtime.snapshot(), before);
  const box: Ty = { t: 'Record', name: typeName('type:test:typed_box'), fields: [['value', b.Int]] };
  assert.throws(() => runtime.allocateRecord(box, {})); assert.throws(() => runtime.allocateRecord(box, { value: 'wrong' }), /expects Int/); assert.deepEqual(runtime.snapshot(), before);
  const record = runtime.allocateRecord(box, { value: 3n }); runtime.start(generic, [record]); runtime.step();
  const snapshot = runtime.snapshot(); assert.equal(snapshot.core.frames[0].typeBindings[0][0], 'T');
  const restored = f.runtime(); restored.restore(snapshot, checkpointDigest(snapshot)); assert.equal(restored.run().state, 'completed'); assert.deepEqual(restored.decodeValue(restored.result().value!), record);
});

test('step quota options and every reconstructed inverse state are validated before restore', () => {
  const f = pendingFixture();
  for (const maxSteps of [NaN, Infinity, 0, -1, 1.5, 100001]) assert.throws(() => new ResumableRuntime(f.module, { ...f.options, maxSteps }), /step quota/);
  const source = f.runtime(); source.start(f.entry, [1n]); source.run(2); const current = source.snapshot();
  const tight = new ResumableRuntime(f.module, { ...f.options, maxSteps: 1 }); assert.throws(() => tight.restore(current, checkpointDigest(current)), /step quota/);
  const start = f.runtime(); start.start(f.entry, [1n]); const valid = start.snapshot(), bad = machineClone(valid), event = bad.events[0];
  const initial = machineClone(bad.core) as unknown as Record<string, unknown>; for (const delta of event.delta) initial[delta.section] = machineClone(delta.before);
  initial.nextEnvironment = '0'; event.delta.find(delta => delta.section === 'nextEnvironment')!.before = '0'; event.before = machineDigest(initial as never); bad.eventHead = eventDigest(event);
  assert.throws(() => validateResumableSnapshot(bad, source.program), /allocator/);
  const label = machineClone(valid); label.events[0].code = 'nonexistent-code'; label.eventHead = eventDigest(label.events[0]); assert.throws(() => validateResumableSnapshot(label, source.program), /start provenance/);
});


test('nullable generic and checkpoint fields accept only null or their declared value schema', () => {
  for (const value of [false, 0, '']) {
    assert.throws(() => validateMachineTypeBindings([['T', { kind: 'Seq', element: value }]]), /shape/);
    assert.throws(() => validateMachineTypeBindings([['T', { kind: 'Result', ok: value, err: null }]]), /shape/);
    assert.throws(() => validateMachineTypeBindings([['T', { kind: 'Result', ok: null, err: value }]]), /shape/);
  }
  validateMachineTypeBindings([['T', { kind: 'Seq', element: null }]]);
  const f = pendingFixture(), runtime = f.runtime(); runtime.start(f.entry, [1n]);
  while (!runtime.inspect().tasks.length) runtime.step(); const snapshot = runtime.snapshot();
  for (const value of [false, 0, '']) for (const field of ['result', 'fault', 'frameResult', 'taskResult', 'frameTask', 'eventEffect']) {
    const bad = machineClone(snapshot) as any;
    if (field === 'frameResult') bad.core.frames[0].result = value;
    else if (field === 'taskResult') bad.core.tasks[0].result = value;
    else if (field === 'frameTask') bad.core.frames[0].task = value;
    else if (field === 'eventEffect') bad.events[0].effect = value;
    else bad.core[field] = value;
    assert.throws(() => validateResumableSnapshot(bad, runtime.program), field);
  }
});
