import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ACCOUNT, CAP_LEDGER_APPEND, buildLedgerExample, ledgerTelemetry } from '../../src/examples/ledger.ts';
import { TopologyHost, TOPOLOGY_INVOKE } from '../../src/tier4/host.ts';
import { slice } from '../../src/tier4/topology.ts';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { DurableGrantEpochs } from '../../src/tier2/grant-epochs.ts';
import type { RuntimeEffectRouter } from '../../src/tier3/effects.ts';

const grantDirectories: string[] = [];
after(() => grantDirectories.forEach(path => rmSync(path, { recursive: true, force: true })));

const setup = () => {
  const ex = buildLedgerExample('distributed-host');
  const plan = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms });
  const sealer = new CapabilitySealer(new Uint8Array(32).fill(7), () => 100);
  const host = new TopologyHost(ex.module, plan, {
    registry: ex.capabilities, symbols: ex.syms, sealer, clock: () => 100,
  });
  return { ex, host, sealer };
};

test('D1: the topology host executes functions through their planned unit', () => {
  const { ex, host } = setup();
  const result = host.call(ex.symbols.feeFor, [100n]);
  assert.equal(result.ok && result.value, 1n);
  assert.ok(host.unitFor(ex.symbols.feeFor));
});

test('D2/D3: wire calls require sealed authority and expose partition semantics', () => {
  const { ex, host } = setup();
  const alice = host.allocateRecord(ACCOUNT, { id: 'alice', balance: 100n });
  const bob = host.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
  const request = {
    id: 'req-1', from: ex.symbols.settle, to: ex.symbols.transfer,
    args: [alice, bob, 10n], capabilities: [],
  } as const;
  const denied = host.dispatch(request);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.fault.kind, 'authority');

  const authorized = host.dispatch({ ...request, capabilities: host.issueTokens(ex.symbols.transfer) });
  assert.equal(authorized.ok, true);
  const unit = host.unitFor(ex.symbols.transfer)!;
  host.setPartition(unit, true);
  const partitioned = host.dispatch({ ...request, capabilities: host.issueTokens(ex.symbols.transfer) });
  assert.equal(partitioned.ok, false);
  if (!partitioned.ok) {
    assert.equal(partitioned.fault.kind, 'partition');
    assert.equal(partitioned.fault.retryable, true);
    assert.equal(partitioned.fault.committed, false);
  }
});

test('v2 topology dispatch binds grants to target function, generation and current epoch', () => {
  const ex = buildLedgerExample('distributed-v2-grants'), plan = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms });
  let epoch = '0', revoked = false;
  const scopedGrants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(17), repositoryId: 'repository',
    clock: () => 100, policyEpoch: () => '0', revocationEpoch: () => epoch, isRevoked: () => revoked,
    authorizeIssue: () => true, authorizeDelegate: () => true });
  const host = new TopologyHost(ex.module, plan, { registry: ex.capabilities, symbols: ex.syms, scopedGrants, clock: () => 100 });
  const alice = host.allocateRecord(ACCOUNT, { id: 'alice', balance: 100n });
  const bob = host.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
  const request = { id: 'v2-transfer', from: ex.symbols.settle, to: ex.symbols.transfer, args: [alice, bob, 10n] } as const;
  assert.throws(() => host.call(ex.symbols.transfer, request.args), /strict topology calls require grant-checked dispatch/);
  assert.equal(host.readRecord(alice).get('balance'), 100n);
  const wrongAudience = host.dispatch({ ...request, capabilities: host.issueTokens(ex.symbols.settle) });
  assert.equal(wrongAudience.ok, false); if (!wrongAudience.ok) assert.equal(wrongAudience.fault.kind, 'authority');
  const malformed = host.dispatch({ ...request, capabilities: null } as unknown as Parameters<typeof host.dispatch>[0]);
  assert.equal(malformed.ok, false); if (!malformed.ok) assert.equal(malformed.fault.kind, 'authority');
  const tokens = host.issueTokens(ex.symbols.transfer);
  const authorized = host.dispatch({ ...request, capabilities: tokens });
  assert.equal(authorized.ok, true);
  host.move(ex.symbols.accrue, host.unitFor(ex.symbols.settle)!);
  const oldGeneration = host.dispatch({ ...request, id: 'v2-old-generation', capabilities: tokens });
  assert.equal(oldGeneration.ok, false); if (!oldGeneration.ok) assert.equal(oldGeneration.fault.kind, 'authority');
  const currentGeneration = host.issueTokens(ex.symbols.transfer);
  epoch = '1';
  const stale = host.dispatch({ ...request, id: 'v2-stale', capabilities: currentGeneration });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.fault.kind, 'authority');
  const renewed = host.issueTokens(ex.symbols.transfer);
  revoked = true;
  const denied = host.dispatch({ ...request, id: 'v2-revoked', capabilities: renewed });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.fault.kind, 'authority');
});

test('strict topology dispatch rechecks a grant after the initial boundary check', () => {
  const ex = buildLedgerExample('topology-grant-race'), plan = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms });
  let epoch = '0', changeBeforeExecution = false;
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(19), repositoryId: 'repository',
    clock: () => 100, policyEpoch: () => '0', revocationEpoch: () => epoch, isRevoked: () => false,
    authorizeIssue: () => true, authorizeDelegate: () => true });
  const host = new TopologyHost(ex.module, plan, { registry: ex.capabilities, symbols: ex.syms, scopedGrants: grants,
    clock: () => { if (changeBeforeExecution) { changeBeforeExecution = false; epoch = '1'; } return 100; } });
  const alice = host.allocateRecord(ACCOUNT, { id: 'alice', balance: 100n }), bob = host.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
  const capabilities = host.issueTokens(ex.symbols.transfer);
  changeBeforeExecution = true;
  const result = host.dispatch({ id: 'changed-at-boundary', from: null, to: ex.symbols.transfer, args: [alice, bob, 10n], capabilities });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.fault.kind, 'authority');
  assert.equal(host.readRecord(alice).get('balance'), 100n);
  assert.equal(host.readRecord(bob).get('balance'), 0n);
});

test('pure state-changing strict topology entry requires a current audience-bound invocation grant', () => {
  const symbols = new SymbolSpace('pure-topology-invoke'), setter = symbols.define('setter'), other = symbols.define('other'), account = symbols.define('account');
  const registry = new CapabilityRegistry();
  const module = b.module_({ symbol: symbols.define('module'), members: [
    b.fn({ symbol: setter, params: [b.param(account, ACCOUNT)], returns: b.Unit, body: b.block(b.assign(b.place(account, 'balance'), b.int(99)), b.ret(b.unit())) }),
    b.fn({ symbol: other, returns: b.Int, body: b.ret(b.int(0)) }),
  ], symbolTable: symbols.table() });
  const plan = { shape: 'containers' as const, units: [{ id: 'worker', members: [setter, other], capabilities: [], placement: 'container' as const, memoryMb: 16 }],
    crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  let now = 100, revoked = false, epoch = '0';
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(59), repositoryId: 'repository', clock: () => now,
    policyEpoch: () => '0', revocationEpoch: () => epoch, isRevoked: () => revoked,
    authorizeIssue: () => true, authorizeDelegate: () => true });
  const host = new TopologyHost(module, plan, { registry, symbols, scopedGrants: grants });
  const first = host.allocateRecord(ACCOUNT, { id: 'alice', balance: 0n });
  const request = { id: 'pure-set', from: null, to: setter, args: [first] } as const;
  assert.equal(host.dispatch({ ...request, capabilities: [] }).ok, false);
  assert.equal(host.readRecord(first).get('balance'), 0n);
  assert.equal(host.dispatch({ ...request, id: 'wrong-audience', capabilities: host.issueTokens(other) }).ok, false);
  const tokens = host.issueTokens(setter); assert.equal(tokens.length, 1);
  assert.equal((tokens[0] as { body: { capability: string } }).body.capability, TOPOLOGY_INVOKE);
  assert.equal(host.dispatch({ ...request, id: 'authorized', capabilities: tokens }).ok, true);
  assert.equal(host.readRecord(first).get('balance'), 99n);
  const second = host.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
  revoked = true;
  assert.equal(host.dispatch({ ...request, id: 'revoked', args: [second], capabilities: tokens }).ok, false);
  revoked = false; epoch = '1';
  assert.equal(host.dispatch({ ...request, id: 'stale', args: [second], capabilities: tokens }).ok, false);
  const fresh = host.issueTokens(setter); now = 60_100;
  assert.equal(host.dispatch({ ...request, id: 'expired', args: [second], capabilities: fresh }).ok, false);
  assert.equal(host.readRecord(second).get('balance'), 0n);
});

test('strict topology effect callbacks recheck revocation before each sink', () => {
  const symbols = new SymbolSpace('topology-effect-recheck'), main = symbols.define('main');
  const registry = new CapabilityRegistry();
  const first = registry.declare('cap:test:first', { arity: 0, description: 'First effect.' }).name;
  const second = registry.declare('cap:test:second', { arity: 0, description: 'Second effect.' }).name;
  const entry = b.fn({ symbol: main, returns: b.Unit, capabilities: [first, second], body: b.block(
    b.exprStmt(b.invoke(first)), b.exprStmt(b.invoke(second)), b.ret(b.unit())) });
  const module = b.module_({ symbol: symbols.define('module'), members: [entry], symbolTable: symbols.table() });
  const plan = { shape: 'containers' as const, units: [{ id: 'worker', members: [main], capabilities: [first, second], placement: 'container' as const, memoryMb: 16 }],
    crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  let epoch = '0', firstCalls = 0, secondCalls = 0;
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(41), repositoryId: 'repository', clock: () => 100,
    policyEpoch: () => '0', revocationEpoch: () => epoch, isRevoked: () => false,
    authorizeIssue: () => true, authorizeDelegate: () => true });
  const host = new TopologyHost(module, plan, { registry, symbols, scopedGrants: grants,
    effects: new Map([[first, () => { firstCalls++; epoch = '1'; return null; }], [second, () => { secondCalls++; return null; }]]) });
  const result = host.dispatch({ id: 'two-effects', from: null, to: main, args: [], capabilities: host.issueTokens(main) });
  assert.equal(result.ok, false); assert.equal(firstCalls, 1); assert.equal(secondCalls, 0);
});

test('strict topology closure entry rechecks authority after revocation', () => {
  const symbols = new SymbolSpace('topology-closure-recheck'), main = symbols.define('main'), callback = symbols.define('callback');
  const registry = new CapabilityRegistry();
  const first = registry.declare('cap:test:first', { arity: 0, description: 'Revoke on first effect.' }).name;
  const second = registry.declare('cap:test:second', { arity: 0, description: 'Closure effect.' }).name;
  const closureType = { t: 'Fn' as const, params: [], returns: b.Unit, capabilities: [second] };
  const entry = b.fn({ symbol: main, returns: b.Unit, capabilities: [first, second], body: b.block(
    b.let_(callback, closureType, b.lambda({ returns: b.Unit, capabilities: [second], body: b.invoke(second) })),
    b.exprStmt(b.invoke(first)), b.exprStmt(b.apply(b.v(callback))), b.ret(b.unit())) });
  const module = b.module_({ symbol: symbols.define('module'), members: [entry], symbolTable: symbols.table() });
  const plan = { shape: 'containers' as const, units: [{ id: 'worker', members: [main], capabilities: [first, second], placement: 'container' as const, memoryMb: 16 }],
    crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  let epoch = '0', secondCalls = 0;
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(43), repositoryId: 'repository', clock: () => 100,
    policyEpoch: () => '0', revocationEpoch: () => epoch, isRevoked: () => false,
    authorizeIssue: () => true, authorizeDelegate: () => true });
  const host = new TopologyHost(module, plan, { registry, symbols, scopedGrants: grants,
    effects: new Map([[first, () => { epoch = '1'; return null; }], [second, () => { secondCalls++; return null; }]]) });
  const result = host.dispatch({ id: 'closure-after-revocation', from: null, to: main, args: [], capabilities: host.issueTokens(main) });
  assert.equal(result.ok, false); assert.equal(secondCalls, 0);
  if (!result.ok) assert.match(result.fault.message, /authority_denied: strict topology continuation/);
});

test('strict topology router boundary rechecks revocation before the next live adapter', () => {
  const symbols = new SymbolSpace('topology-router-recheck'), main = symbols.define('main');
  const registry = new CapabilityRegistry();
  const first = registry.declare('cap:test:first', { arity: 0, description: 'First router effect.' }).name;
  const second = registry.declare('cap:test:second', { arity: 0, description: 'Second router effect.' }).name;
  const entry = b.fn({ symbol: main, returns: b.Unit, capabilities: [first, second], body: b.block(
    b.exprStmt(b.invoke(first)), b.exprStmt(b.invoke(second)), b.ret(b.unit())) });
  const module = b.module_({ symbol: symbols.define('module'), members: [entry], symbolTable: symbols.table() });
  const plan = { shape: 'containers' as const, units: [{ id: 'worker', members: [main], capabilities: [first, second], placement: 'container' as const, memoryMb: 16 }],
    crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  let epoch = '0', firstCalls = 0, secondCalls = 0;
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(47), repositoryId: 'repository', clock: () => 100,
    policyEpoch: () => '0', revocationEpoch: () => epoch, isRevoked: () => false,
    authorizeIssue: () => true, authorizeDelegate: () => true });
  const router: RuntimeEffectRouter = { mode: 'live', bind() {}, fork() { throw new Error('no speculative router in this fixture'); },
    invoke(capability) { if (capability === first) { firstCalls++; epoch = '1'; return null; } secondCalls++; return null; } };
  const host = new TopologyHost(module, plan, { registry, symbols, scopedGrants: grants, effectRouter: router });
  const result = host.dispatch({ id: 'router-effects', from: null, to: main, args: [], capabilities: host.issueTokens(main) });
  assert.equal(result.ok, false); assert.equal(firstCalls, 1); assert.equal(secondCalls, 0);
});

test('durable grant revocation survives restart at a real topology dispatch boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-topology-grants-')); grantDirectories.push(directory);
  const epochs = new DurableGrantEpochs({ directory, repositoryId: 'repository' });
  const ex = buildLedgerExample('durable-topology-grants'), plan = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms });
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(23), repositoryId: 'repository', clock: () => 100,
    policyEpoch: () => epochs.policyEpoch, revocationEpoch: () => epochs.epoch,
    isRevoked: (cap, path) => epochs.isRevoked(cap, path), authorizeIssue: () => true, authorizeDelegate: () => true });
  const host = new TopologyHost(ex.module, plan, { registry: ex.capabilities, symbols: ex.syms, scopedGrants: grants, clock: () => 100 });
  const alice = host.allocateRecord(ACCOUNT, { id: 'alice', balance: 100n });
  const bob = host.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
  const request = { id: 'durable-grant', from: ex.symbols.settle, to: ex.symbols.transfer, args: [alice, bob, 10n] } as const;
  const original = host.issueTokens(ex.symbols.transfer);
  assert.equal(host.dispatch({ ...request, capabilities: original }).ok, true);
  epochs.revoke(CAP_LEDGER_APPEND, []);
  const reopened = new DurableGrantEpochs({ directory, repositoryId: 'repository' });
  assert.equal(reopened.epoch, '1');
  const denied = host.dispatch({ ...request, id: 'revoked', capabilities: original });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.fault.kind, 'authority');
  epochs.restore(CAP_LEDGER_APPEND, []);
  const stale = host.dispatch({ ...request, id: 'restored-stale', capabilities: original });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.fault.kind, 'authority');
  assert.equal(host.dispatch({ ...request, id: 'restored-new', capabilities: host.issueTokens(ex.symbols.transfer) }).ok, true);
});

test('D4/D5: a quiescent function moves live and host traffic becomes slicer telemetry', () => {
  const { ex, host } = setup();
  const target = host.unitFor(ex.symbols.settle)!;
  host.move(ex.symbols.accrue, target);
  assert.equal(host.unitFor(ex.symbols.accrue), target);
  host.call(ex.symbols.feeFor, [100n], ex.symbols.settle);
  host.call(ex.symbols.feeFor, [200n], ex.symbols.settle);
  const telemetry = host.collectTelemetry(2);
  const edge = telemetry.edges.find((candidate) =>
    candidate.from === ex.symbols.settle && candidate.to === ex.symbols.feeFor);
  assert.equal(edge?.callsPerSecond, 1);
  assert.equal(telemetry.functions.find((fn) => fn.symbol === ex.symbols.feeFor)?.selfMs, 0);
});

test('J4: cross-unit calls execute through isolated per-unit runtimes', () => {
  const symbols = new SymbolSpace('isolated-units');
  const calleeSymbol = symbols.define('callee');
  const callerSymbol = symbols.define('caller');
  const callee = b.fn({ symbol: calleeSymbol, returns: b.Int, body: b.block(b.ret(b.int(41))) });
  const caller = b.fn({
    symbol: callerSymbol, returns: b.Int,
    body: b.block(b.ret(b.add(b.call(calleeSymbol), b.int(1)))),
  });
  const module = b.module_({
    symbol: symbols.define('isolated'), members: [callee, caller], symbolTable: symbols.table(),
  });
  const plan = slice(module, {
    edges: [],
    functions: [
      { symbol: calleeSymbol, selfMs: 1, memoryMb: 16 },
      { symbol: callerSymbol, selfMs: 1, memoryMb: 16 },
    ],
  }, { symbols, shape: 'containers' });
  const host = new TopologyHost(module, plan, { registry: new CapabilityRegistry(), symbols });
  assert.equal(host.unitRuntimeCount, 2);
  const result = host.call(callerSymbol, []);
  assert.equal(result.ok && result.value, 42n);
});
