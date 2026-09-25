import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import { buildLedgerExample } from '../../src/examples/ledger.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { encodeAgentIrColdV7 } from '../../src/tier1/agent-ir-v7.ts';
import { AgentIrGraphSliceSessionV8 } from '../../src/tier1/agent-ir-v8.ts';
import { Runtime } from '../../src/tier3/runtime.ts';

test('AE8 retrieves a checked graph slice and reconstructs complete edited module', () => {
  const ex = buildLedgerExample();
  if (ex.module.kind !== 'Module') throw new Error('ledger module');
  const cold = encodeAgentIrColdV7(ex.module, 'ledger-example');
  const sender = new AgentIrGraphSliceSessionV8(cold), receiver = new AgentIrGraphSliceSessionV8(cold);
  const index = ex.module.members.findIndex(term => term.kind === 'FunctionDecl' && term.symbol === ex.symbols.feeFor);
  const original = ex.module.members[index];
  if (original.kind !== 'FunctionDecl') throw new Error('feeFor declaration');
  const selection = sender.select(index), retrieval = sender.retrieve(selection);
  const refused = new AgentIrGraphSliceSessionV8(cold);
  assert.throws(() => refused.acceptRetrieval(retrieval.replace(/^D8;[0-9]+/, 'D8;0')), /stale base/);
  assert.throws(() => refused.decode(sender.encode(index, original)), /missing selected slice/);
  const slice = receiver.acceptRetrieval(retrieval);
  assert.equal(slice.declarationRoot, new GraphStore().intern(original));
  assert.equal(slice.contractRoot, new GraphStore().intern(original.contract!));
  assert.deepEqual(slice.effects, []);
  const edited = { ...original, body: b.block(b.ret(b.div(b.v(original.params[0].symbol), b.int(200)))) };
  const unchanged = sender.encode(index, original), repair = sender.encode(index, edited);
  assert.match(unchanged, /^R8:/);
  assert.match(repair, /^E8:/);
  for (const [wire, expected] of [[unchanged, 10n], [repair, 5n]] as const) {
    const complete = receiver.decode(wire).module;
    const runtime = new Runtime({ registry: ex.capabilities, symbols: ex.syms });
    runtime.load(complete);
    const result = runtime.call(ex.symbols.feeFor, [1000n]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, expected);
  }
  assert.throws(() => receiver.acceptRetrieval(retrieval.replace(/;[0-9]+;/, ';00;')), /root|index|canonical/);
  assert.throws(() => receiver.acceptRetrieval(retrieval.replace(/;[0-9]+;[0-9]+;[0-9]+;/, ';1;1;1;')), /root|contract|declaration/);
  assert.throws(() => receiver.decode('R8:0:0'), /stale base|root/);
});

test('AE8 refuses missing imported dependency, stale selection and missing retrieval', () => {
  const syms = new SymbolSpace('v8-imports');
  const helper = syms.define('helper'), entry = syms.define('entry');
  const leaf = b.module_({ symbol: syms.define('leaf'), symbolTable: syms.table(), members: [
    b.fn({ symbol: helper, returns: b.Int, body: b.ret(b.int(3)) }),
  ] });
  const leafRoot = new GraphStore().intern(leaf);
  const module = b.module_({ symbol: syms.define('module'), symbolTable: syms.table(), members: [
    b.import_(leafRoot, [helper]), b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.call(helper)) }),
  ] });
  if (module.kind !== 'Module') throw new Error('entry module');
  const cold = encodeAgentIrColdV7(module, 'v8-imports');
  const sender = new AgentIrGraphSliceSessionV8(cold);
  assert.throws(() => sender.select(1), /missing imported dependency/);
  sender.loadDependency(encodeAgentIrColdV7(leaf, 'v8-imports'));
  const selection = sender.select(1), retrieval = sender.retrieve(selection);
  assert.throws(() => sender.retrieve(selection.replace(/:[0-9]+:/, ':0:')), /stale base/);
  const receiver = new AgentIrGraphSliceSessionV8(cold);
  assert.throws(() => receiver.decode('R8:0:1'), /missing selected slice/);
  assert.throws(() => receiver.acceptRetrieval(retrieval), /missing imported dependency/);
  receiver.loadDependency(encodeAgentIrColdV7(leaf, 'v8-imports'));
  const slice = receiver.acceptRetrieval(retrieval);
  assert.deepEqual(slice.dependencies, [{ memberIndex: null, root: leafRoot }]);
  assert.throws(() => receiver.acceptRetrieval(retrieval.replace(/;i@[0-9]+;/, ';i@1;')), /dependency/);
  assert.equal(new GraphStore().intern(receiver.decode(sender.encode(1, module.members[1])).module), new GraphStore().intern(module));
});

test('AE8 retrieval binds derived effect summary to the exact declaration', () => {
  const ex = buildLedgerExample();
  if (ex.module.kind !== 'Module') throw new Error('module');
  const cold = encodeAgentIrColdV7(ex.module, 'ledger-example');
  const sender = new AgentIrGraphSliceSessionV8(cold);
  const index = ex.module.members.findIndex(member => member.kind === 'FunctionDecl' && member.symbol === ex.symbols.transfer);
  const retrieval = sender.retrieve(sender.select(index));
  const receiver = new AgentIrGraphSliceSessionV8(cold);
  const slice = receiver.acceptRetrieval(retrieval);
  assert.deepEqual(slice.effects, ['cap:db:ledger_append']);
  assert.throws(() => new AgentIrGraphSliceSessionV8(cold).acceptRetrieval(
    retrieval.replace('cap:db:ledger_append', 'cap:db:ledger_remove')), /dependency\/effect\/canonical/);
});
