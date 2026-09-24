import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildLedgerExample } from '../../src/examples/ledger.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { IrContext, decode, encode } from '../../src/tier1/agent-ir.ts';
import { AgentIrWarmReferenceV5 } from '../../src/tier1/agent-ir-v5.ts';
import { countTokens } from '../../src/util/tokens.ts';

test('AE5 exact-base warm references reconstruct every paid cold declaration', () => {
  const ex = buildLedgerExample('ae5-warm-reference');
  if (ex.module.kind !== 'Module') throw new Error('ledger module');
  const cold = encode(ex.module, new IrContext()).text;
  const received = decode(cold, new IrContext());
  const sender = new AgentIrWarmReferenceV5(ex.module), receiver = new AgentIrWarmReferenceV5(received);
  assert.equal(sender.baseRoot, receiver.baseRoot);
  const store = new GraphStore(), wires: string[] = [];
  for (const [index, member] of ex.module.members.entries()) if (member.kind === 'FunctionDecl') {
    const wire = sender.encode(index, member), restored = receiver.decode(wire);
    assert.equal(store.intern(restored), store.intern(member));
    assert.equal(restored.contract === null, member.contract === null);
    if (restored.contract && member.contract)
      assert.equal(store.intern(restored.contract), store.intern(member.contract));
    wires.push(wire);
    (restored as { body: unknown }).body = null;
    assert.equal(store.intern(receiver.decode(wire)), store.intern(member));
  }
  assert.equal(wires.length, 4);
  assert.ok(wires.every(wire => wire.length <= 80));
  assert.ok(wires.every(wire => countTokens(wire, 'cl100k_base') > 0));
});

test('AE5 refuses changed, stale, wrong-index, noncanonical and oversized references', () => {
  const ex = buildLedgerExample('ae5-refusals');
  if (ex.module.kind !== 'Module') throw new Error('ledger module');
  const sender = new AgentIrWarmReferenceV5(ex.module);
  const index = ex.module.members.findIndex(member => member.kind === 'FunctionDecl');
  const member = ex.module.members[index];
  if (member.kind !== 'FunctionDecl') throw new Error('function missing');
  const wire = sender.encode(index, member);
  assert.throws(() => sender.encode(index, { ...member, body: null }), /changed/);
  assert.throws(() => sender.decode(wire + '\n'), /malformed/);
  assert.throws(() => sender.decode(wire.replace(/:[0-9]+$/, ':9999')), /index/);
  assert.throws(() => sender.decode(wire.replace(/:[0-9]+$/, ':01')), /malformed/);
  assert.throws(() => sender.decode(wire + 'x'.repeat(100)), /bound/);
  const changed = { ...ex.module, members: ex.module.members.map((row, position) => position === index
    ? { ...member, body: null } : row) };
  assert.throws(() => new AgentIrWarmReferenceV5(changed).decode(wire), /base mismatch/);
  assert.throws(() => sender.encode(0, member), /changed|nonfunction/);
});

test('a fresh receiver process reconstructs the referenced declaration from the paid cold wire', () => {
  const ex = buildLedgerExample('ae5-process');
  if (ex.module.kind !== 'Module') throw new Error('ledger module');
  const index = ex.module.members.findIndex(member => member.kind === 'FunctionDecl');
  const member = ex.module.members[index];
  if (member.kind !== 'FunctionDecl') throw new Error('function missing');
  const cold = encode(ex.module, new IrContext()).text;
  const wire = new AgentIrWarmReferenceV5(ex.module).encode(index, member);
  const script = `import {IrContext,decode} from './src/tier1/agent-ir.ts';import {AgentIrWarmReferenceV5} from './src/tier1/agent-ir-v5.ts';import {GraphStore} from './src/tier1/store.ts';let text='';for await(const chunk of process.stdin)text+=chunk;const {cold,wire}=JSON.parse(text);const base=decode(cold,new IrContext());const member=new AgentIrWarmReferenceV5(base).decode(wire);process.stdout.write(new GraphStore().intern(member)+'\\n');`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
    { encoding: 'utf8', input: JSON.stringify({ cold, wire }), timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), new GraphStore().intern(member));
});
