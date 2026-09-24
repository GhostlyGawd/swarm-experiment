import assert from 'node:assert/strict';
import test from 'node:test';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { capability } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { deriveVirtualForwardDescriptor } from '../../src/tier1/semantic-gc-virtual-forward.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';

type Module = Extract<Term, { kind: 'Module' }>;

function fixture() {
  const symbols = new SymbolSpace('semantic-gc-virtual-compiled');
  const target = symbols.define('target'), wrapper = symbols.define('wrapper');
  const entry = symbols.define('entry'), direct = symbols.define('direct');
  const x = symbols.define('x'), w = symbols.define('w');
  const n = symbols.define('n'), y = symbols.define('y');
  const append = capability('cap:test:append');
  const registry = new CapabilityRegistry();
  registry.declare(append, { arity: 1, description: 'Observed sink', effectful: true });
  const targetDecl = b.fn({ symbol: target, params: [b.param(x, b.Int)],
    returns: b.Int, contract: b.contract({}), body: b.ret(b.add(b.v(x), b.int(1))) });
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
  return { source, candidate, descriptor, registry, append, target, entry, direct };
}

test('compiled virtual forwarding retains wrapper and target guard denial timing before effects', () => {
  const f = fixture();
  const run = (candidate: boolean, allowed: number) => {
    const sink: string[] = [];
    let guards = 0;
    const runtime = ProductionRuntime.compile(candidate ? f.candidate : f.source, {
      registry: f.registry, policy: 'enforce',
      executionGuard: () => ++guards <= allowed,
      effects: new Map([[f.append, args => { sink.push(String(args[0])); return null; }]]),
      ...(candidate ? { virtualForward: { source: f.source, descriptor: f.descriptor } } : {}),
    });
    return { result: runtime.call(f.entry, [2n]), guards, sink };
  };
  for (const allowed of [0, 1, 2, 3, 4]) {
    assert.deepEqual(run(true, allowed), run(false, allowed), `guard allowance ${allowed}`);
  }
  assert.deepEqual(run(true, 1).sink, [], 'the effect must not run after wrapper guard denial');
  assert.deepEqual(run(true, 2).sink, [], 'the effect must not run after target guard denial');
  assert.deepEqual(run(true, 3).sink, ['3'], 'the effect runs only after both entries succeed');
  assert.equal(run(true, 1).result.ok, false);
  assert.equal(run(true, 2).result.ok, false);
});

test('existing direct target calls do not acquire a virtual wrapper guard', () => {
  const f = fixture();
  for (const symbol of [f.direct, f.target]) for (const allowed of [0, 1, 2, 3]) {
    const run = (candidate: boolean) => {
      let guards = 0;
      const runtime = ProductionRuntime.compile(candidate ? f.candidate : f.source, {
        registry: f.registry, policy: 'enforce', executionGuard: () => ++guards <= allowed,
        ...(candidate ? { virtualForward: { source: f.source, descriptor: f.descriptor } } : {}),
      });
      return { result: runtime.call(symbol, [2n]), guards };
    };
    assert.deepEqual(run(true), run(false), `symbol ${symbol}, guard allowance ${allowed}`);
  }
});

test('compiled consumer rejects a tampered descriptor and a changed candidate', () => {
  const f = fixture();
  assert.throws(() => ProductionRuntime.compile(f.candidate, { registry: f.registry,
    virtualForward: { source: f.source, descriptor: { ...f.descriptor, sites: [] } },
  }), /virtual forwarder descriptor/);
  const changed = { ...f.candidate, members: f.candidate.members.slice(1) } as Module;
  assert.throws(() => ProductionRuntime.compile(changed, { registry: f.registry,
    virtualForward: { source: f.source, descriptor: f.descriptor },
  }), /virtual|candidate|source|rewrite/);
});

test('virtual target must be compiled locally, even when a remote call handler exists', () => {
  const f = fixture();
  let remoteCalls = 0;
  assert.throws(() => ProductionRuntime.compile(f.candidate, { registry: f.registry,
    includeSymbols: [f.entry], callHandler: () => { remoteCalls++; return { ok: true, value: 99n, steps: 0 }; },
    virtualForward: { source: f.source, descriptor: f.descriptor },
  }), /target compiled locally/);
  assert.equal(remoteCalls, 0);
});

test('virtual forwarding cannot reuse v4 vetted admission for the candidate alone', () => {
  const f = fixture();
  assert.throws(() => ProductionRuntime.compile(f.candidate, { registry: f.registry,
    virtualForward: { source: f.source, descriptor: f.descriptor },
    // Rejection must precede evidence validation: no manifest version binds
    // this sidecar to the exact execution subject yet.
    evidence: { vetted: null as never, expectedManifest: null as never },
  }), /virtual forwarding is not covered by a versioned admission manifest/);
});

test('virtual forwarding cannot bind an effect router to the candidate root alone', () => {
  const f = fixture();
  let binds = 0;
  assert.throws(() => ProductionRuntime.compile(f.candidate, { registry: f.registry,
    virtualForward: { source: f.source, descriptor: f.descriptor },
    effectRouter: { mode: 'live', bind: () => { binds++; }, invoke: () => null,
      fork: () => { throw new Error('unexpected router fork'); } },
  }), /virtual forwarding is not covered by a versioned admission manifest/);
  assert.equal(binds, 0, 'rejection must precede broker root binding');
});

test('compiled virtual calls retain the checked candidate after caller mutation', () => {
  const f = fixture();
  const runtime = ProductionRuntime.compile(f.candidate, { registry: f.registry,
    policy: 'enforce', effects: new Map([[f.append, () => null]]),
    virtualForward: { source: f.source, descriptor: f.descriptor },
  });
  const before = runtime.call(f.entry, [2n]);
  (f.source.members[1] as { body: Term }).body = b.ret(b.int(99));
  (f.candidate.members[1] as { body: Term }).body = b.ret(b.int(100));
  assert.deepEqual(runtime.call(f.entry, [2n]), before);
});
