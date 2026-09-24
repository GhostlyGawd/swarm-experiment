import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import type { Ty } from '../../src/tier1/ast.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { typecheck } from '../../src/tier2/typecheck.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { executableBundle, parseExecutableBundle } from '../../src/projection/executable.ts';

const closure: Ty = { t: 'Fn', params: [], returns: b.Int, capabilities: [] };

test('V15 checks both direct branch-return closure factory arms', () => {
  const symbols = new SymbolSpace('projection-v15-branch-audit');
  const factory = symbols.define('factory'), entry = symbols.define('entry');
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: factory, returns: closure,
      body: b.if_(b.bool(true),
        b.ret(b.lambda({ returns: b.Int, body: b.int(7) })),
        b.ret(b.lambda({ returns: b.Int, body: b.int(8) }))) }),
    b.fn({ symbol: entry, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.call(factory)), b.int(0)), 'branch factory')] }),
      body: b.ret(b.int(1)) }),
  ] });
  assert.equal(typecheck(module, { registry: new CapabilityRegistry() }).ok, true);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(module).call(entry, []);
  assert.equal(reference.ok, true); if (reference.ok) assert.equal(reference.value, 1n);
  const store=new GraphStore(),root=store.intern(module);
  for (const target of ['typescript', 'python', 'rust'] as const){
    const bundle=executableBundle(module,symbols,target);
    assert.match(bundle.source,/@aether-projection\/15/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module),root);
    const first=bundle.source.split('\n')[0];
    assert.equal(JSON.parse(first.slice(first.indexOf('{'))).closureCertificates.length,2);
  }
});

test('valid branch-local capture remains outside the straight-line factory profile', () => {
  const symbols = new SymbolSpace('projection-v15-branch-local-audit');
  const factory = symbols.define('factory'), entry = symbols.define('entry');
  const localA = symbols.define('localA'), localB = symbols.define('localB');
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: factory, returns: closure,
      body: b.if_(b.bool(true),
        b.block(b.let_(localA, b.Int, b.int(7)), b.ret(b.lambda({ returns: b.Int, body: b.v(localA) }))),
        b.block(b.let_(localB, b.Int, b.int(8)), b.ret(b.lambda({ returns: b.Int, body: b.v(localB) })))) }),
    b.fn({ symbol: entry, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.call(factory)), b.int(0)), 'branch local')] }),
      body: b.ret(b.int(1)) }),
  ] });
  assert.equal(typecheck(module, { registry: new CapabilityRegistry() }).ok, true);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(module).call(entry, []);
  assert.equal(reference.ok, true); if (reference.ok) assert.equal(reference.value, 1n);
  for (const target of ['typescript', 'python', 'rust'] as const)
    assert.throws(() => executableBundle(module, symbols, target), /visible direct lambda/);
});

test('valid quantifier binder inside a closure is a documented projection gap', () => {
  const symbols = new SymbolSpace('projection-v15-quantifier-audit');
  const entry = symbols.define('entry'), iterator = symbols.define('iterator');
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: entry, returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.apply(b.lambda({ returns: b.Bool,
        body: b.forall(iterator, b.int(0), b.int(3), b.ge(b.v(iterator), b.int(0))) })), 'binder closure')] }),
      body: b.ret(b.int(1)) }),
  ] });
  assert.equal(typecheck(module, { registry: new CapabilityRegistry() }).ok, true);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(module).call(entry, []);
  assert.equal(reference.ok, true); if (reference.ok) assert.equal(reference.value, 1n);
  for (const target of ['typescript', 'python', 'rust'] as const)
    assert.throws(() => executableBundle(module, symbols, target), /unproved binding/);
});

test('pure direct call inside a passed closure round-trips but has no V15 native certificate', () => {
  const symbols = new SymbolSpace('projection-v15-direct-call-audit');
  const helper = symbols.define('helper'), entry = symbols.define('entry');
  const fn = symbols.define('fn'), wrapper = symbols.define('wrapper');
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: helper, returns: b.Int, body: b.ret(b.int(7)) }),
    b.fn({ symbol: entry, params: [b.param(fn, closure)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.v(fn)), b.int(0)), 'pure helper')] }),
      body: b.ret(b.apply(b.v(fn))) }),
    b.fn({ symbol: wrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int, body: b.call(helper) }))) }),
  ] });
  assert.equal(typecheck(module, { registry: new CapabilityRegistry() }).ok, true);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(module).call(wrapper, []);
  assert.equal(reference.ok, true); if (reference.ok) assert.equal(reference.value, 7n);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target);
    assert.match(bundle.source, /@aether-projection\/15/);
    assert.doesNotMatch(bundle.source, /ae_certified_lambda!?\(ctx/);
    assert.equal(parseExecutableBundle(bundle).module.kind, 'Module');
    const first = bundle.source.split('\n')[0];
    const header = JSON.parse(first.slice(first.indexOf('{')));
    assert.deepEqual(header.closureCertificates, []);
  }
});
