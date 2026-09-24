import assert from 'node:assert/strict';
import test from 'node:test';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { capability } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { deriveVirtualForwardDescriptor } from '../../src/tier1/semantic-gc-virtual-forward.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { Runtime } from '../../src/tier3/runtime.ts';

type Module = Extract<Term, { kind: 'Module' }>;

function fixture(targetBody?: (symbol: ReturnType<SymbolSpace['define']>) => Term) {
  const symbols = new SymbolSpace('semantic-gc-virtual-runtime');
  const target = symbols.define('target'), wrapper = symbols.define('wrapper');
  const entry = symbols.define('entry'), direct = symbols.define('direct');
  const x = symbols.define('x'), w = symbols.define('w');
  const n = symbols.define('n'), y = symbols.define('y');
  const append = capability('cap:test:append');
  const registry = new CapabilityRegistry();
  registry.declare(append, { arity: 1, description: 'Observed sink', effectful: true });
  const targetDecl = b.fn({ symbol: target, params: [b.param(x, b.Int)],
    returns: b.Int, contract: b.contract({}), body: b.ret(targetBody?.(x) ?? b.add(b.v(x), b.int(1))) });
  const wrapperDecl = b.fn({ symbol: wrapper, params: [b.param(w, b.Int)],
    returns: b.Int, contract: b.contract({}), body: b.block(b.ret(b.call(target, b.v(w)))) });
  const entryDecl = (callee: typeof target) => b.fn({ symbol: entry,
    params: [b.param(n, b.Int)], returns: b.Int,
    capabilities: [append], purity: 'effectful', contract: b.contract({}),
    body: b.block(b.let_(y, b.Int, b.call(callee, b.v(n))),
      b.exprStmt(b.invoke(append, b.v(y))), b.ret(b.v(y))) });
  const directDecl = b.fn({ symbol: direct, params: [b.param(n, b.Int)],
    returns: b.Int, contract: b.contract({}), body: b.ret(b.call(target, b.v(n))) });
  const source = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(),
    members: [targetDecl, wrapperDecl, entryDecl(wrapper), directDecl] }) as Module;
  const candidate: Module = { ...source, members: [targetDecl, entryDecl(target), directDecl] };
  const descriptor = deriveVirtualForwardDescriptor(source, candidate, wrapper, target);
  return { source, candidate, descriptor, symbols, registry, append, entry, direct };
}

test('checked virtual forwarding preserves exact finite-fuel faults, frames, callbacks and effects', () => {
  const f = fixture();
  const run = (module: Module, input: bigint, maxSteps: number, virtual: boolean) => {
    const sink: string[] = [], callbacks: unknown[] = [];
    let runtime: Runtime;
    runtime = new Runtime({ registry: f.registry, symbols: f.symbols, maxSteps,
      trace: true, onStep: event => callbacks.push({ event, inspect: runtime.inspect() }),
      effects: new Map([[f.append, args => { sink.push(String(args[0])); return null; }]]),
      ...(virtual ? { virtualForward: { source: f.source, descriptor: f.descriptor } } : {}) });
    runtime.load(module);
    const result = runtime.call(f.entry, [input]);
    return { result, sink, trace: runtime.trace, effects: runtime.effects, callbacks };
  };
  for (const input of [-1n, 0n, 3n]) for (let budget = 1; budget <= 64; budget++) {
    assert.deepEqual(run(f.candidate, input, budget, true), run(f.source, input, budget, false),
      `input ${input}, budget ${budget}`);
  }
  assert.notDeepEqual(run(f.candidate, 0n, 11, false), run(f.source, 0n, 11, false),
    'an ordinary direct redirect must remain a failing counterexample');
});

test('virtual forwarding is bound to the exact candidate and leaves original direct calls alone', () => {
  const f = fixture();
  const runtime = new Runtime({ registry: f.registry, symbols: f.symbols,
    virtualForward: { source: f.source, descriptor: f.descriptor }, maxSteps: 64, trace: true });
  const changed: Module = { ...f.candidate, members: f.candidate.members.slice(1) };
  assert.throws(() => runtime.load(changed), /virtual|candidate|source|root|descriptor|rewrite/i);
  runtime.load(f.candidate);
  assert.deepEqual(runtime.call(f.direct, [2n]), { ok: true, value: 3n, steps: 7 });
  assert.equal(runtime.trace.some(event => event.detail.startsWith('wrapper(')), false);
});

test('loaded virtual forwarding retains checked AST bytes after caller mutation', () => {
  const f = fixture();
  const runtime = new Runtime({ registry: f.registry, symbols: f.symbols,
    virtualForward: { source: f.source, descriptor: f.descriptor }, maxSteps: 64,
    effects: new Map([[f.append, () => null]]) }).load(f.candidate);
  const before = runtime.call(f.entry, [2n]);
  (f.source.members[1] as { body: Term }).body = b.ret(b.int(100));
  (f.candidate.members[1] as { body: Term }).body = b.ret(b.int(101));
  assert.deepEqual(runtime.call(f.entry, [2n]), before);
});

test('a target fault retains the archived wrapper frame and fault bindings', () => {
  const f = fixture(x => b.div(b.int(1), b.v(x)));
  const run = (module: Module, virtual: boolean, maxSteps: number) => {
    const runtime = new Runtime({ registry: f.registry, symbols: f.symbols, maxSteps,
      trace: true, effects: new Map([[f.append, () => null]]),
      ...(virtual ? { virtualForward: { source: f.source, descriptor: f.descriptor } } : {}) });
    runtime.load(module);
    return { result: runtime.call(f.entry, [0n]), trace: runtime.trace, effects: runtime.effects };
  };
  for (let budget = 1; budget <= 32; budget++)
    assert.deepEqual(run(f.candidate, true, budget), run(f.source, false, budget));
  const result = run(f.candidate, true, 32);
  assert.equal(result.result.ok, false);
  if (!result.result.ok) assert.equal(result.result.fault.kind, 'division_by_zero');
});
