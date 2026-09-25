import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import { encodeAgentIrColdV7, decodeAgentIrColdV7, AgentIrSessionV7 } from '../../src/tier1/agent-ir-v7.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { buildLedgerExample } from '../../src/examples/ledger.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { countTokens } from '../../src/util/tokens.ts';
import { encode, IrContext } from '../../src/tier1/agent-ir.ts';

test('AE7 checked seed preserves all identities, contracts and native runtime behavior', () => {
  const ex = buildLedgerExample();
  if (ex.module.kind !== 'Module') throw new Error('module fixture');
  const wire = encodeAgentIrColdV7(ex.module, 'ledger-example');
  const cold = decodeAgentIrColdV7(wire);
  const root = new GraphStore().intern(ex.module);
  assert.equal(cold.root, root);
  assert.deepEqual(cold.module, ex.module);
  assert.equal(cold.ae1, encode(ex.module, new IrContext()).text);
  for (const encoding of ['cl100k_base', 'o200k_base'] as const)
    assert.ok(countTokens(wire, encoding) < countTokens(cold.ae1, encoding));
  const sender = new AgentIrSessionV7(wire), receiver = new AgentIrSessionV7(wire);
  const index = ex.module.members.findIndex(member => member.kind === 'FunctionDecl' && member.symbol === ex.symbols.feeFor);
  const original = ex.module.members[index];
  if (original.kind !== 'FunctionDecl') throw new Error('feeFor fixture');
  const edited = { ...original, body: b.block(b.ret(b.div(b.v(original.params[0].symbol), b.int(200)))) };
  const unchanged = sender.encode(index, original), repair = sender.encode(index, edited);
  assert.match(unchanged, /^R7:/);
  assert.match(repair, /^E7:/);
  for (const [message, expected] of [[unchanged, 10n], [repair, 5n]] as const) {
    const decoded = receiver.decode(message);
    assert.equal(decoded.baseRoot, root);
    assert.equal(decoded.moduleRoot, new GraphStore().intern(decoded.module));
    assert.equal(new GraphStore().intern(decoded.declaration.contract!), new GraphStore().intern(original.contract!));
    const runtime = new Runtime({ registry: ex.capabilities, symbols: ex.syms });
    runtime.load(decoded.module);
    const result = runtime.call(ex.symbols.feeFor, [1000n]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, expected);
  }
});

test('AE7 refuses false seed, stale edit, noncanonical indexes, provenance and framing', () => {
  const ex = buildLedgerExample();
  if (ex.module.kind !== 'Module') throw new Error('module fixture');
  assert.throws(() => encodeAgentIrColdV7(ex.module, 'wrong-seed'), /seed does not reconstruct/);
  const wire = encodeAgentIrColdV7(ex.module, 'ledger-example');
  const explicit = encodeAgentIrColdV7(ex.module);
  assert.deepEqual(decodeAgentIrColdV7(explicit).module, ex.module);
  assert.throws(() => decodeAgentIrColdV7(wire.replace('§g "ledger-example"', '§g "other"')), /canonical|symbol|seed/);
  assert.throws(() => decodeAgentIrColdV7(wire.replace(/§v ([0-9]+)/, '§v 00')), /noncanonical symbol index/);
  assert.throws(() => decodeAgentIrColdV7(wire.replace(/§p ([0-9]+)/, '§p 00')), /noncanonical provenance/);
  assert.throws(() => decodeAgentIrColdV7(wire + '\n'), /canonical complete Module/);
  const member = ex.module.members.findIndex(t => t.kind === 'FunctionDecl');
  const original = ex.module.members[member];
  const session = new AgentIrSessionV7(wire);
  const reference = session.encode(member, original);
  assert.throws(() => new AgentIrSessionV7(encodeAgentIrColdV7(buildLedgerExample('other').module as never, 'other')).decode(reference), /stale base root/);
  assert.throws(() => session.decode(reference.replace(/^R7:/, 'R6:')), /warm prefix/);
});
