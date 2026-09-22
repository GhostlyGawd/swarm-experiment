import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import type { Ty } from '../../src/tier1/ast.ts';
import { typeName } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry, RevocationList } from '../../src/tier2/ocap.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import type { ProductionSnapshot } from '../../src/tier3/heap-state.ts';
import type { Ref, Value } from '../../src/tier3/values.ts';
import { ACCOUNT, buildLedgerExample, CAP_LEDGER_APPEND, ledgerTelemetry } from '../../src/examples/ledger.ts';
import { TopologyHost } from '../../src/tier4/host.ts';
import { DEFAULT_COST_MODEL, slice, type SliceOptions } from '../../src/tier4/topology.ts';

function ledger(options: SliceOptions = {}) {
  const ex = buildLedgerExample('migration');
  const plan = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms, shape: 'containers', ...options });
  const revocations = new RevocationList();
  const host = new TopologyHost(ex.module, plan, { registry: ex.capabilities, symbols: ex.syms, revocations });
  const alice = host.allocateRecord(ACCOUNT, { id: 'alice', balance: 100n });
  const bob = host.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
  return { ex, host, alice, bob, revocations };
}

test('V4-F01/G1: ledger state, aliases and future calls survive movement and source removal', () => {
  const { ex, host, alice, bob, revocations } = ledger();
  assert.equal(host.call(ex.symbols.transfer, [alice, bob, 10n]).ok, true);
  const oldUnits = host.unitRuntimeCount;
  const target = host.unitFor(ex.symbols.accrue)!;
  assert.notEqual(host.unitFor(ex.symbols.transfer), target);
  host.move(ex.symbols.transfer, target);
  assert.equal(host.generation, 1);
  assert.equal(host.readRecord(alice).get('balance'), 90n);
  assert.equal(host.readRecord(bob).get('balance'), 10n);
  assert.equal(host.call(ex.symbols.transfer, [alice, bob, 1n]).ok, true);
  assert.equal(host.readRecord(alice).get('balance'), 89n);
  assert.ok(host.unitRuntimeCount <= oldUnits);
  const later = host.allocateRecord(ACCOUNT, { id: 'later', balance: 7n });
  assert.equal(later.addr, 3);
  assert.equal(host.readRecord(later).get('balance'), 7n);
  assert.ok(host.plan.units.find(unit => unit.id === target)!.capabilities.includes(CAP_LEDGER_APPEND));
  assert.ok(host.collectTelemetry(1).functions.some(fn => fn.symbol === ex.symbols.transfer));
  revocations.revoke(CAP_LEDGER_APPEND, { by: 'test' });
  assert.equal(host.call(ex.symbols.transfer, [alice, bob, 1n]).ok, false);
});

test('V4-F01/G2: cross-unit nested calls observe the authoritative heap instead of stale duplicates', () => {
  const { ex, host, alice, bob } = ledger();
  assert.equal(host.call(ex.symbols.transfer, [alice, bob, 10n]).ok, true);
  // settle crosses feeFor and transfer boundaries; outer completion must not
  // overwrite the newer callee heap with its suspended copy.
  assert.equal(host.call(ex.symbols.settle, [alice, bob, 10n]).ok, true);
  assert.equal(host.readRecord(alice).get('balance'), 80n);
  assert.equal(host.readRecord(bob).get('balance'), 20n);
  host.move(ex.symbols.transfer, host.unitFor(ex.symbols.accrue)!);
  assert.equal(host.call(ex.symbols.settle, [alice, bob, 10n]).ok, true);
  assert.equal(host.readRecord(alice).get('balance'), 70n);
  assert.equal(host.readRecord(bob).get('balance'), 30n);
});

test('V4-F01/G2: runtime-created records across units use globally coordinated local addresses', () => {
  const syms = new SymbolSpace('allocations');
  const makeA = syms.define('makeA'), makeB = syms.define('makeB');
  const members = [makeA, makeB].map((symbol, i) => b.fn({
    symbol, returns: ACCOUNT, body: b.block(b.ret(b.record(ACCOUNT, { id: b.str(String(i)), balance: b.int(i + 10) }))),
  }));
  const module = b.module_({ symbol: syms.define('module'), members, symbolTable: syms.table() });
  const host = new TopologyHost(module, slice(module, { edges: [], functions: [] }, { shape: 'containers' }), { registry: new CapabilityRegistry() });
  const a = host.call(makeA, []), z = host.call(makeB, []);
  assert.ok(a.ok && z.ok);
  const ra = a.value as Ref, rz = z.value as Ref;
  assert.deepEqual([ra.addr, rz.addr], [1, 2]);
  host.move(makeA, host.unitFor(makeB)!);
  assert.equal(host.unitRuntimeCount, 1);
  assert.equal(host.readRecord(ra).get('balance'), 10n);
  assert.equal(host.readRecord(rz).get('balance'), 11n);
  assert.equal(host.allocateRecord(ACCOUNT, { id: 'external', balance: 0n }).addr, 3);
  const next = host.call(makeA, []);
  assert.ok(next.ok);
  assert.equal((next.value as Ref).addr, 4);
});

test('V4-F01/G2: snapshots preserve cyclic record references and isolate nested containers', () => {
  const ex = buildLedgerExample('snapshot');
  const make = () => ProductionRuntime.compile(ex.module, { registry: ex.capabilities });
  const runtime = make();
  const holder: Ty = { t: 'Record', name: typeName('type:test:holder'), fields: [['links', { t: 'Seq', element: ACCOUNT }], ['result', { t: 'Result', ok: ACCOUNT, err: b.Str }]] };
  runtime.allocateRecord(holder, { links: [{ addr: 1 }, { addr: 2 }, { addr: 2 }], result: { variant: 'ok', value: { addr: 2 } } });
  runtime.allocateRecord(holder, { links: [{ addr: 1 }], result: { variant: 'ok', value: { addr: 1 } } });
  const snapshot = runtime.exportSnapshot();
  const destination = make();
  destination.importSnapshot(snapshot);
  const links = snapshot.records[0].fields.find(([field]) => field === 'links')![1] as Value[];
  links.length = 0;
  assert.deepEqual(runtime.readRecord({ addr: 1 }).get('links'), [{ addr: 1 }, { addr: 2 }, { addr: 2 }]);
  assert.deepEqual(destination.readRecord({ addr: 1 }).get('links'), [{ addr: 1 }, { addr: 2 }, { addr: 2 }]);
  assert.deepEqual(destination.readRecord({ addr: 2 }).get('links'), [{ addr: 1 }]);
  assert.equal(destination.allocateRecord(ACCOUNT, { id: 'next', balance: 0n }).addr, 3);
  assert.throws(() => destination.readRecord({ addr: 0 }), /invalid record/);
});

test('V4-F01/G3: invalid snapshots fail atomically before replacing the current heap', () => {
  const ex = buildLedgerExample('bad-snapshot');
  const runtime = ProductionRuntime.compile(ex.module, { registry: ex.capabilities });
  const ref = runtime.allocateRecord(ACCOUNT, { id: 'kept', balance: 25n });
  const valid = runtime.exportSnapshot();
  const malformed = [
    { ...valid, nextAddress: 5 },
    { ...valid, records: [{ address: 0, fields: valid.records[0].fields }] },
    { ...valid, records: [{ address: 1, fields: [['id', 'a'], ['id', 'b']] }] },
    { ...valid, records: [{ address: 1, fields: [['bad', { addr: 99 }]] }] },
    { ...valid, records: [{ address: 1, fields: [['bad', { task: true, run: () => null }]] }] },
  ];
  for (const snapshot of malformed) {
    assert.throws(() => runtime.importSnapshot(snapshot as ProductionSnapshot));
    assert.equal(runtime.readRecord(ref).get('balance'), 25n);
  }
});

test('V4-F01/G3: no-op, stale generation, invalid target and prepare failures retain usable state', () => {
  const { ex, host, alice, bob } = ledger();
  const before = host.plan;
  const own = host.unitFor(ex.symbols.transfer)!;
  assert.equal(host.move(ex.symbols.transfer, own), before);
  assert.equal(host.generation, 0);
  assert.throws(() => host.move(ex.symbols.transfer, 'missing'), /unknown unit/);
  assert.throws(() => host.move(ex.symbols.transfer, own, 10), /stale/);
  for (const method of ['exportSnapshot', 'importSnapshot'] as const) {
    const original = ProductionRuntime.prototype[method];
    ProductionRuntime.prototype[method] = (() => { throw new Error(`injected ${method}`); }) as never;
    try { assert.throws(() => host.move(ex.symbols.transfer, host.unitFor(ex.symbols.accrue)!), /injected/); }
    finally { ProductionRuntime.prototype[method] = original as never; }
    assert.equal(host.plan, before);
    assert.equal(host.generation, 0);
    assert.equal(host.readRecord(alice).get('balance'), 100n);
    assert.equal(host.readRecord(bob).get('balance'), 0n);
  }
  const compile = ProductionRuntime.compile;
  ProductionRuntime.compile = () => { throw new Error('injected compilation'); };
  try { assert.throws(() => host.move(ex.symbols.transfer, host.unitFor(ex.symbols.accrue)!), /injected compilation/); }
  finally { ProductionRuntime.compile = compile; }
  assert.equal(host.plan, before);
  host.move(ex.symbols.transfer, host.unitFor(ex.symbols.accrue)!);
  assert.equal(host.call(ex.symbols.transfer, [alice, bob, 10n]).ok, true);
  assert.equal(host.readRecord(alice).get('balance'), 90n);
});

test('V4-F01/G3: a live effect cannot move an active state domain', () => {
  const ex = buildLedgerExample('active-move');
  let host: TopologyHost;
  let checked = false;
  const effects = new Map([[CAP_LEDGER_APPEND, () => {
    assert.throws(() => host.move(ex.symbols.accrue, host.unitFor(ex.symbols.transfer)!), /active calls/);
    checked = true;
    return null;
  }]]);
  host = new TopologyHost(ex.module, slice(ex.module, ledgerTelemetry(ex), { shape: 'containers' }), { registry: ex.capabilities, effects });
  const a = host.allocateRecord(ACCOUNT, { id: 'a', balance: 100n });
  const z = host.allocateRecord(ACCOUNT, { id: 'z', balance: 0n });
  assert.equal(host.call(ex.symbols.transfer, [a, z, 10n]).ok, true);
  assert.equal(checked, true);
  assert.equal(host.generation, 0);
});

test('V4-F01/G3: migration retains edge, isolation, memory and single-writer restrictions', () => {
  const edge = ledger({ shape: 'edge_workers' });
  assert.throws(() => edge.host.move(edge.ex.symbols.transfer, edge.host.unitFor(edge.ex.symbols.accrue)!), /edge/);
  const isolated = ledger({ isolate: [CAP_LEDGER_APPEND] });
  assert.throws(() => isolated.host.move(isolated.ex.symbols.accrue, isolated.host.unitFor(isolated.ex.symbols.transfer)!), /isolated/);
  const ex = buildLedgerExample('writer-group');
  const groupedPlan = slice(ex.module, ledgerTelemetry(ex), { shape: 'containers', concurrencyFindings: [{ symbols: [ex.symbols.transfer, ex.symbols.settle], reason: 'one writer' }] });
  const groupedHost = new TopologyHost(ex.module, groupedPlan, { registry: ex.capabilities });
  assert.throws(() => groupedHost.move(ex.symbols.transfer, groupedHost.unitFor(ex.symbols.accrue)!), /single-writer/);
  const limited = ledger({ cost: { ...DEFAULT_COST_MODEL, maxUnitMemoryMb: 128 } });
  const source = limited.host.plan.units.find(unit => unit.members.includes(limited.ex.symbols.transfer))!;
  const target = limited.host.plan.units.find(unit => unit.id !== source.id)!;
  // Retain a tightened operational limit in the plan used by this host.
  const strictPlan = { ...limited.host.plan, constraints: { ...limited.host.plan.constraints!, cost: { ...DEFAULT_COST_MODEL, maxUnitMemoryMb: 0 } } };
  const strictHost = new TopologyHost(limited.ex.module, strictPlan, { registry: limited.ex.capabilities });
  assert.throws(() => strictHost.move(limited.ex.symbols.transfer, target.id), /memory limit/);
});

test('V4-F01/G2: map and fold callbacks remain callable after their unit changes', () => {
  const syms = new SymbolSpace('callback-migration');
  const mapper = syms.define('mapper'), folder = syms.define('folder'), increment = syms.define('increment'), sum = syms.define('sum');
  const x = syms.define('x'), total = syms.define('total'), idle = syms.define('idle');
  const members = [
    b.fn({ symbol: increment, params: [b.param(x, b.Int)], returns: b.Int, body: b.block(b.ret(b.add(b.v(x), b.int(1)))) }),
    b.fn({ symbol: sum, params: [b.param(total, b.Int), b.param(x, b.Int)], returns: b.Int, body: b.block(b.ret(b.add(b.v(total), b.v(x)))) }),
    b.fn({ symbol: mapper, returns: { t: 'Seq', element: b.Int }, body: b.block(b.ret(b.map(b.seq(b.Int, b.int(1)), increment))) }),
    b.fn({ symbol: folder, returns: b.Int, body: b.block(b.ret(b.fold(b.seq(b.Int, b.int(1), b.int(2)), b.int(0), sum))) }),
    b.fn({ symbol: idle, returns: b.Int, body: b.block(b.ret(b.int(0))) }),
  ];
  const module = b.module_({ symbol: syms.define('module'), members, symbolTable: syms.table() });
  const telemetry = { functions: [], edges: [
    { from: mapper, to: increment, callsPerSecond: 10, payloadBytes: 8 },
    { from: folder, to: sum, callsPerSecond: 10, payloadBytes: 8 },
  ] };
  const host = new TopologyHost(module, slice(module, telemetry, { shape: 'containers' }), { registry: new CapabilityRegistry() });
  assert.equal(host.unitFor(mapper), host.unitFor(increment));
  assert.deepEqual(host.call(mapper, []), { ok: true, value: [2n], steps: 0 });
  assert.deepEqual(host.call(folder, []), { ok: true, value: 3n, steps: 0 });
  const target = host.unitFor(idle)!;
  host.move(increment, target);
  host.move(sum, target);
  assert.deepEqual(host.call(mapper, []), { ok: true, value: [2n], steps: 0 });
  assert.deepEqual(host.call(folder, []), { ok: true, value: 3n, steps: 0 });
  assert.equal(host.plan.units.find(unit => unit.id === target)!.memoryMb, 48);
  for (const edge of host.plan.crossEdges) assert.equal(edge.latencyMsPerSecond,
    edge.callsPerSecond * (2 * DEFAULT_COST_MODEL.hopLatencyMs + DEFAULT_COST_MODEL.serializationMs + edge.payloadBytes / (DEFAULT_COST_MODEL.bandwidthMbPerSecond * 1_000_000) * 1000));
});

test('V4-F01/G2/G3: cross-unit opaque continuations see current state and block unsafe migration', () => {
  for (const task of [false, true]) {
    const syms = new SymbolSpace(`continuations-${task}`);
    const make = syms.define('make'), use = syms.define('use'), account = syms.define('account'), callback = syms.define('callback');
    const callbackType: Ty = task ? { t: 'Task', result: b.Int } : { t: 'Fn', params: [], returns: b.Int, capabilities: [] };
    const read = b.field(b.v(account), 'balance');
    const members = [
      b.fn({ symbol: make, params: [b.param(account, ACCOUNT)], returns: callbackType,
        body: b.block(b.ret(task ? b.spawn(read) : b.lambda({ returns: b.Int, body: read }))) }),
      b.fn({ symbol: use, params: [b.param(account, ACCOUNT), b.param(callback, callbackType)], returns: b.Int,
        body: b.block(b.assign(b.place(account, 'balance'), b.int(30)), b.ret(task ? b.await_(b.v(callback)) : b.apply(b.v(callback)))) }),
    ];
    const module = b.module_({ symbol: syms.define('module'), members, symbolTable: syms.table() });
    const host = new TopologyHost(module, slice(module, { functions: [], edges: [] }, { shape: 'containers' }), { registry: new CapabilityRegistry() });
    const ref = host.allocateRecord(ACCOUNT, { id: 'a', balance: 10n });
    const produced = host.call(make, [ref]);
    assert.ok(produced.ok);
    assert.deepEqual(host.call(use, [ref, produced.value]), { ok: true, value: 30n, steps: 0 });
    assert.equal(host.readRecord(ref).get('balance'), 30n);
    const plan = host.plan;
    assert.equal(host.move(make, host.unitFor(make)!), plan); // no-op is safe even with opaque state
    assert.throws(() => host.move(make, host.unitFor(use)!), /live closures and tasks/);
    assert.equal(host.plan, plan);
    assert.equal(host.readRecord(ref).get('balance'), 30n);
  }
});

test('V4-F01/G2: host movement retains nested cyclic and aliased state used by other functions', () => {
  const { ex, host } = ledger();
  const holder: Ty = { t: 'Record', name: typeName('type:test:holder'), fields: [['links', { t: 'Seq', element: ACCOUNT }]] };
  const first = host.allocateRecord(holder, { links: [{ addr: 3 }, { addr: 4 }, { addr: 4 }] });
  const second = host.allocateRecord(holder, { links: [{ addr: 3 }] });
  host.move(ex.symbols.accrue, host.unitFor(ex.symbols.transfer)!);
  assert.deepEqual(host.readRecord(first).get('links'), [first, second, second]);
  assert.deepEqual(host.readRecord(second).get('links'), [first]);
  assert.equal(host.allocateRecord(ACCOUNT, { id: 'later', balance: 0n }).addr, 5);
});

test('F07 state transfer treats JavaScript prototype names as ordinary record fields', () => {
  const syms = new SymbolSpace('reserved-record-fields');
  const maker = syms.define('maker'), reader = syms.define('reader'), object = syms.define('object');
  const record: Ty = { t: 'Record', name: typeName('type:test:reserved'), fields: [['__proto__', b.Int], ['constructor', b.Int]] };
  const members = [
    b.fn({ symbol: maker, returns: record, body: b.block(b.ret(b.record(record, Object.fromEntries([['__proto__', b.int(7)], ['constructor', b.int(8)]])))) }),
    b.fn({ symbol: reader, params: [b.param(object, record)], returns: b.Int,
      body: b.block(b.ret(b.add(b.field(b.v(object), '__proto__'), b.field(b.v(object), 'constructor')))) }),
  ];
  const module = b.module_({ symbol: syms.define('module'), members, symbolTable: syms.table() });
  const registry = new CapabilityRegistry();
  for (const runtime of [new Runtime({ registry }).load(module), ProductionRuntime.compile(module, { registry })]) {
    const made = runtime.call(maker, []);
    assert.ok(made.ok);
    const result = runtime.call(reader, [made.value]);
    assert.equal(result.ok && result.value, 15n);
  }
  const host = new TopologyHost(module, slice(module, { functions: [], edges: [] }, { shape: 'containers' }), { registry });
  const made = host.call(maker, []); assert.ok(made.ok);
  host.move(maker, host.unitFor(reader)!);
  assert.equal(host.readRecord(made.value as Ref).get('__proto__'), 7n);
  assert.equal(host.call(reader, [made.value]).ok, true);
});
