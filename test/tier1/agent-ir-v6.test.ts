import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { encode, IrContext } from '../../src/tier1/agent-ir.ts';
import { AgentIrSessionV6 } from '../../src/tier1/agent-ir-v6.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { buildLedgerExample } from '../../src/examples/ledger.ts';
import { Runtime } from '../../src/tier3/runtime.ts';

const root = (term: Parameters<GraphStore['intern']>[0]) => new GraphStore().intern(term);

test('AE6 cold-bound references restore exact declaration and module roots without aliases', () => {
  const ex = buildLedgerExample('ae6-reference');
  if (ex.module.kind !== 'Module') throw new Error('module fixture');
  const cold = encode(ex.module, new IrContext()).text;
  const sender = new AgentIrSessionV6(cold), receiver = new AgentIrSessionV6(cold);
  assert.equal(sender.baseRoot, root(ex.module));
  let count = 0;
  for (const [index, member] of ex.module.members.entries()) if (member.kind === 'FunctionDecl') {
    const wire = sender.encode(index, member), decoded = receiver.decode(wire);
    assert.match(wire, /^R6:[0-9]+:[0-9]+$/);
    assert.equal(decoded.baseRoot, root(ex.module));
    assert.equal(decoded.declarationRoot, root(member));
    assert.equal(decoded.moduleRoot, root(ex.module));
    assert.equal(root(decoded.declaration), root(member));
    assert.equal(root(decoded.module), root(ex.module));
    (decoded.declaration as { body: unknown }).body = null;
    assert.equal(root(receiver.decode(wire).declaration), root(member));
    count++;
  }
  assert.equal(count, 4);
});

test('AE6 root-bound literal edits preserve contracts and execute both failed and repaired outputs', () => {
  const ex = buildLedgerExample('ae6-edits');
  if (ex.module.kind !== 'Module') throw new Error('module fixture');
  const index = ex.module.members.findIndex(member => member.kind === 'FunctionDecl' && member.symbol === ex.symbols.feeFor);
  const original = ex.module.members[index];
  if (original.kind !== 'FunctionDecl') throw new Error('feeFor fixture');
  const cold = encode(ex.module, new IrContext()).text;
  const sender = new AgentIrSessionV6(cold), receiver = new AgentIrSessionV6(cold);
  const wrong = sender.encode(index, original);
  const repair = { ...original, body: b.block(b.ret(b.div(b.v(original.params[0].symbol), b.int(200)))) };
  const corrected = sender.encode(index, repair);
  assert.match(wrong, /^R6:/);
  assert.match(corrected, /^E6:/);
  for (const [wire, expected] of [[wrong, 10n], [corrected, 5n]] as const) {
    const decoded = receiver.decode(wire);
    assert.equal(decoded.declarationRoot, root(expected === 10n ? original : repair));
    assert.equal(root(decoded.declaration.contract!), root(original.contract!));
    const runtime = new Runtime({ registry: ex.capabilities, symbols: ex.syms });
    runtime.load(decoded.module);
    const result = runtime.call(ex.symbols.feeFor, [1000n]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, expected);
  }
  assert.notEqual(receiver.decode(corrected).moduleRoot, receiver.decode(wrong).moduleRoot);
});

test('AE6 rejects stale, noncanonical, wrong-root, out-of-scope and malformed wires', () => {
  const ex = buildLedgerExample('ae6-refusals');
  if (ex.module.kind !== 'Module') throw new Error('module fixture');
  const cold = encode(ex.module, new IrContext()).text;
  const session = new AgentIrSessionV6(cold);
  const index = ex.module.members.findIndex(member => member.kind === 'FunctionDecl' && member.symbol === ex.symbols.feeFor);
  const original = ex.module.members[index];
  if (original.kind !== 'FunctionDecl') throw new Error('feeFor fixture');
  const wire = session.encode(index, original);
  const repair = { ...original, body: b.block(b.ret(b.div(b.v(original.params[0].symbol), b.int(200)))) };
  const edit = session.encode(index, repair);
  const other = buildLedgerExample('ae6-other');
  assert.throws(() => new AgentIrSessionV6(encode(other.module, new IrContext()).text).decode(wire), /stale base/);
  assert.throws(() => session.decode(wire + '\n'), /noncanonical index/);
  assert.throws(() => session.decode(wire.replace(/:[0-9]+$/, ':00')), /noncanonical index/);
  assert.throws(() => session.decode(wire.replace(/:[0-9]+$/, ':99999')), /index/);
  assert.throws(() => session.decode(wire.replace(/^R6:[0-9]+/, 'R6:00')), /noncanonical root/);
  assert.throws(() => session.decode(edit.replace(/:[0-9]+$/, ':201')), /root mismatch/);
  assert.throws(() => session.decode(edit.replace(/:[0-9]+$/, ':-0')), /noncanonical integer/);
  assert.throws(() => session.decode(edit.replace(/:0\.0\.1:/, ':0.0.01:')), /noncanonical child path/);
  assert.throws(() => session.decode(edit.replace(/:0\.0\.1:/, ':9.0.1:')), /child path/);
  assert.throws(() => session.decode('R6:' + '9'.repeat(80) + ':' + index), /noncanonical root/);
  assert.throws(() => session.encode(index, { ...original, contract: null }), /preserve declaration metadata/);
  assert.throws(() => session.encode(index, { ...original, body: b.block(b.ret(b.add(b.int(1), b.int(2)))) }), /shape|payload|exactly one/);
  assert.throws(() => session.encode(index, { ...original, body: b.block(b.ret(b.div(b.v(original.params[0].symbol), b.int(200))), b.ret(b.int(1))) }), /shape/);
  assert.throws(() => new AgentIrSessionV6(cold + '\n'), /canonical paid cold/);
});

test('AE6 edit is independently decoded in a fresh process from only the paid cold wire', () => {
  const ex = buildLedgerExample('ae6-process');
  if (ex.module.kind !== 'Module') throw new Error('module fixture');
  const index = ex.module.members.findIndex(member => member.kind === 'FunctionDecl' && member.symbol === ex.symbols.feeFor);
  const original = ex.module.members[index];
  if (original.kind !== 'FunctionDecl') throw new Error('feeFor fixture');
  const cold = encode(ex.module, new IrContext()).text;
  const repair = { ...original, body: b.block(b.ret(b.div(b.v(original.params[0].symbol), b.int(200)))) };
  const wire = new AgentIrSessionV6(cold).encode(index, repair);
  const script = `import {AgentIrSessionV6} from './src/tier1/agent-ir-v6.ts'; let text=''; for await(const chunk of process.stdin)text+=chunk; const {cold,wire}=JSON.parse(text); process.stdout.write(new AgentIrSessionV6(cold).decode(wire).moduleRoot+'\\n');`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
    { input: JSON.stringify({ cold, wire }), encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), new AgentIrSessionV6(cold).decode(wire).moduleRoot);
});
