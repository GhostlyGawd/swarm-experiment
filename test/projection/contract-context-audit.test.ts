import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import type { Term, Ty } from '../../src/tier1/ast.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { typecheck } from '../../src/tier2/typecheck.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { executableBundle, parseExecutableBundle, projectTypeScriptV15, projectPythonV15, projectRustV15 } from '../../src/projection/executable.ts';

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

test('V16 checks both branch-local captures while V15 retains its refusal', () => {
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
  const old={typescript:projectTypeScriptV15,python:projectPythonV15,rust:projectRustV15};
  const store=new GraphStore(),root=store.intern(module);
  for (const target of ['typescript', 'python', 'rust'] as const){
    assert.throws(()=>old[target](module,symbols),/visible direct lambda/);
    const bundle=executableBundle(module,symbols,target);
    assert.match(bundle.source,/@aether-projection\/16/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module),root);
    const first=bundle.source.split('\n')[0];
    assert.equal(JSON.parse(first.slice(first.indexOf('{'))).closureCertificates.length,2);
  }
});

test('V16 checks the quantifier binder inside a closure while V15 refuses it', () => {
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
  const old={typescript:projectTypeScriptV15,python:projectPythonV15,rust:projectRustV15};
  const store=new GraphStore(),root=store.intern(module);
  for (const target of ['typescript', 'python', 'rust'] as const){
    assert.throws(()=>old[target](module,symbols),/unproved binding/);
    const bundle=executableBundle(module,symbols,target);
    assert.match(bundle.source,/@aether-projection\/16/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module),root);
  }
});

test('V16 binds the exact pure helper into a passed closure certificate', () => {
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
  const store=new GraphStore(),root=store.intern(module);
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target);
    assert.match(bundle.source, /@aether-projection\/16/);
    assert.match(bundle.source, /ae_certified_lambda!?\(ctx/);
    assert.equal(store.intern(parseExecutableBundle(bundle).module),root);
    const first = bundle.source.split('\n')[0];
    const header = JSON.parse(first.slice(first.indexOf('{')));
    assert.equal(header.closureCertificates.length,1);
    const changed={...module,members:(module as Extract<Term,{kind:'Module'}>).members.map(member=>member.kind==='FunctionDecl'&&member.symbol===helper
      ?{...member,body:b.ret(b.int(8))}:member)};
    const rebound=executableBundle(changed,symbols,target);
    const nextFirst=rebound.source.split('\n')[0];
    const nextHeader=JSON.parse(nextFirst.slice(nextFirst.indexOf('{')));
    assert.notDeepEqual(nextHeader.closureCertificates,header.closureCertificates);
  }
});

test('V16 binds an imported pure helper address and body into the closure certificate', () => {
  const symbols = new SymbolSpace('projection-v16-imported-helper');
  const helper = symbols.define('helper'), entry = symbols.define('entry');
  const fn = symbols.define('fn'), wrapper = symbols.define('wrapper');
  const library = b.module_({ symbol: symbols.define('library'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: helper, returns: b.Int, body: b.ret(b.int(7)) }),
  ] });
  const store = new GraphStore(), libraryRoot = store.intern(library);
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.import_(libraryRoot, [helper]),
    b.fn({ symbol: entry, params: [b.param(fn, closure)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.gt(b.apply(b.v(fn)), b.int(0)), 'imported helper')] }),
      body: b.ret(b.apply(b.v(fn))) }),
    b.fn({ symbol: wrapper, returns: b.Int,
      body: b.ret(b.call(entry, b.lambda({ returns: b.Int, body: b.call(helper) }))) }),
  ] });
  const root = store.intern(module), options = { modules: new Map([[libraryRoot, library]]) };
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(module, symbols, target, options);
    assert.equal(bundle.dependencies?.size, 1);
    const parsed = parseExecutableBundle(bundle);
    assert.equal(store.intern(parsed.module), root);
    assert.equal(store.intern(parsed.modules.get(libraryRoot)!), libraryRoot);
    const first = bundle.source.split('\n')[0], header = JSON.parse(first.slice(first.indexOf('{')));
    assert.equal(header.closureCertificates.length, 1);
  }
});
