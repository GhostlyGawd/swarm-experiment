import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainDigest } from '../../src/fabric/identity.ts';
import * as b from '../../src/tier1/build.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import {
  VIRTUAL_FORWARD_DESCRIPTOR_FORMAT, VIRTUAL_FORWARD_EVENT_SCRIPT,
  checkVirtualForwardDescriptor, deriveVirtualForwardDescriptor,
  type VirtualForwardDescriptor,
} from '../../src/tier1/semantic-gc-virtual-forward.ts';
import type { Term } from '../../src/tier1/ast.ts';

type Module = Extract<Term, { kind: 'Module' }>;

function fixture() {
  const symbols = new SymbolSpace('virtual-forward-descriptor-test');
  const moduleSymbol = symbols.define('module'), wrapper = symbols.define('wrapper');
  const target = symbols.define('target'), entry = symbols.define('entry');
  const w = symbols.define('w'), x = symbols.define('x'), n = symbols.define('n');
  const targetDecl = b.fn({ symbol: target, params: [b.param(x, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.ret(b.add(b.v(x), b.int(1))) });
  const wrapperDecl = b.fn({ symbol: wrapper, params: [b.param(w, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.block(b.ret(b.call(target, b.v(w)))) });
  const entryDecl = (first: typeof wrapper) => b.fn({ symbol: entry,
    params: [b.param(n, b.Int)], returns: b.Int, contract: b.contract({}),
    body: b.block(b.exprStmt(b.call(first, b.v(n))), b.ret(b.call(target, b.v(n)))) });
  const source = b.module_({ symbol: moduleSymbol, symbolTable: symbols.table(),
    members: [targetDecl, wrapperDecl, entryDecl(wrapper)] }) as Module;
  const candidate = b.module_({ symbol: moduleSymbol, symbolTable: symbols.table(),
    members: [targetDecl, entryDecl(target)] }) as Module;
  return { source, candidate, wrapper, target, entry, targetDecl, wrapperDecl };
}

function reseal(value: VirtualForwardDescriptor): VirtualForwardDescriptor {
  const { id: _id, ...body } = value;
  return { ...body, id: domainDigest(VIRTUAL_FORWARD_DESCRIPTOR_FORMAT, body) };
}

test('descriptor binds only rewritten candidate Call objects and derives exact ordered event script', () => {
  const f = fixture();
  const descriptor = deriveVirtualForwardDescriptor(f.source, f.candidate, f.wrapper, f.target);
  const bindings = checkVirtualForwardDescriptor(descriptor, f.source, f.candidate);
  assert.equal(descriptor.sourceRoot, new GraphStore().intern(f.source));
  assert.equal(descriptor.candidateRoot, new GraphStore().intern(f.candidate));
  assert.deepEqual(descriptor.eventScript, VIRTUAL_FORWARD_EVENT_SCRIPT);
  assert.equal(descriptor.sites.length, 1);
  assert.equal(bindings.length, 1);
  const body = f.candidate.members[1];
  if (body.kind !== 'FunctionDecl' || body.body?.kind !== 'Block'
    || body.body.stmts[0].kind !== 'ExprStmt'
    || body.body.stmts[0].expr.kind !== 'Call'
    || body.body.stmts[1].kind !== 'Return'
    || body.body.stmts[1].value.kind !== 'Call') throw new Error('bad fixture');
  assert.strictEqual(bindings[0].candidateCall, body.body.stmts[0].expr);
  assert.notStrictEqual(bindings[0].candidateCall, body.body.stmts[1].value,
    'an existing direct target call must never gain a virtual wrapper');
  assert.strictEqual(bindings[0].wrapper, f.wrapperDecl);
  assert.equal(bindings[0].caller, f.entry);
  assert.equal(bindings[0].target, f.target);
  assert.deepEqual(bindings[0].sourcePath.slice(0, 2),
    [{ field: 'members', index: 2 }, { field: 'body', index: 0 }]);
  assert.deepEqual(bindings[0].candidatePath.slice(0, 2),
    [{ field: 'members', index: 1 }, { field: 'body', index: 0 }]);
  assert.equal(descriptor.sites[0].candidateCall, new GraphStore().intern(bindings[0].candidateCall));
  assert.deepEqual(deriveVirtualForwardDescriptor(f.source, f.candidate, f.wrapper, f.target), descriptor);
});

test('checker refuses tampered script, site, root and forged digest even when resealed', () => {
  const f = fixture();
  const descriptor = deriveVirtualForwardDescriptor(f.source, f.candidate, f.wrapper, f.target);
  const variants: VirtualForwardDescriptor[] = [
    { ...descriptor, eventScript: ['call:wrapper', 'call:target'] as VirtualForwardDescriptor['eventScript'] },
    { ...descriptor, sites: [{ ...descriptor.sites[0], candidatePath: [{ field: 'members', index: 0 }] }] },
    { ...descriptor, sourceRoot: descriptor.candidateRoot },
    { ...descriptor, sites: [] },
  ];
  for (const changed of variants) {
    assert.throws(() => checkVirtualForwardDescriptor(changed, f.source, f.candidate));
    assert.throws(() => checkVirtualForwardDescriptor(reseal(changed), f.source, f.candidate));
  }
  assert.throws(() => checkVirtualForwardDescriptor({ ...descriptor, extra: true }, f.source, f.candidate));
});

test('candidate Call object aliasing cannot turn an unrelated target call into a virtual site', () => {
  const f = fixture();
  const entry = f.candidate.members[1];
  if (entry.kind !== 'FunctionDecl' || entry.body?.kind !== 'Block'
    || entry.body.stmts[0].kind !== 'ExprStmt'
    || entry.body.stmts[0].expr.kind !== 'Call') throw new Error('bad fixture');
  const shared = entry.body.stmts[0].expr;
  const aliasedEntry: Term = { ...entry, body: { ...entry.body,
    stmts: [entry.body.stmts[0], { kind: 'Return', value: shared }] } };
  const aliased = { ...f.candidate, members: [f.candidate.members[0], aliasedEntry] } as Module;
  assert.equal(new GraphStore().intern(aliased), new GraphStore().intern(f.candidate),
    'the content root alone cannot distinguish host-language object aliasing');
  const descriptor = deriveVirtualForwardDescriptor(f.source, f.candidate, f.wrapper, f.target);
  assert.throws(() => checkVirtualForwardDescriptor(descriptor, f.source, aliased), /shares a Call object/);
});

test('changed candidate, nonempty contracts and nonforwarding wrapper fail closed', () => {
  const f = fixture();
  const descriptor = deriveVirtualForwardDescriptor(f.source, f.candidate, f.wrapper, f.target);
  const changedCandidate = { ...f.candidate, members: [f.targetDecl,
    { ...f.candidate.members[1], provenance: null, body: b.ret(b.int(99)) }] } as Module;
  assert.throws(() => checkVirtualForwardDescriptor(descriptor, f.source, changedCandidate));
  assert.throws(() => deriveVirtualForwardDescriptor(f.source, changedCandidate, f.wrapper, f.target));
  const alteredWrapper = (changes: Record<string, unknown>): Module => ({ ...f.source,
    members: f.source.members.map(member => member.kind === 'FunctionDecl' && member.symbol === f.wrapper
      ? { ...member, ...changes } as Term : member) });
  assert.throws(() => deriveVirtualForwardDescriptor(alteredWrapper({ contract: b.contract({
    requires: [b.clause(b.bool(true), 'seemingly harmless')],
  }) }), f.candidate, f.wrapper, f.target), /contract|signature/);
  assert.throws(() => deriveVirtualForwardDescriptor(alteredWrapper({
    body: b.block(b.exprStmt(b.int(0)), b.ret(b.call(f.target, b.v(f.wrapper)))),
  }), f.candidate, f.wrapper, f.target), /exact one-argument tail forwarder/);
});

test('dynamic calls, annotation calls and absent rewritten sites are unsupported', () => {
  const f = fixture();
  const sourceDynamic = { ...f.source, members: [...f.source.members,
    b.fn({ symbol: new SymbolSpace('dynamic').define('other'), returns: b.Int,
      contract: b.contract({}), body: b.ret(b.apply(b.lambda({ returns: b.Int,
        body: b.int(0) }))) })] } as Module;
  assert.throws(() => deriveVirtualForwardDescriptor(sourceDynamic, f.candidate, f.wrapper, f.target), /dynamic|concurrent/);
  const sourceAnnotated = { ...f.source, members: f.source.members.map(member =>
    member.kind === 'FunctionDecl' && member.symbol === f.entry
      ? { ...member, contract: b.contract({ requires: [b.clause(b.call(f.wrapper, b.int(1)), 'unsafe')] }) }
      : member) } as Module;
  assert.throws(() => deriveVirtualForwardDescriptor(sourceAnnotated, f.candidate, f.wrapper, f.target), /annotation/);
  const noSite = { ...f.source, members: f.source.members.map(member =>
    member.kind === 'FunctionDecl' && member.symbol === f.entry
      ? { ...member, body: b.ret(b.call(f.target, b.int(1))) } : member) } as Module;
  assert.throws(() => deriveVirtualForwardDescriptor(noSite, f.candidate, f.wrapper, f.target), /no rewritten call sites/);
});
