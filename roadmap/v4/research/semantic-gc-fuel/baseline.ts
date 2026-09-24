/** Exact reference-runtime observation schedule for one live forwarding call.
 * Research fixture only: neither candidate is an admitted semantic-GC rewrite. */
import * as b from '../../../../src/tier1/build.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { capability } from '../../../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { Runtime } from '../../../../src/tier3/runtime.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';

const symbols = new SymbolSpace('semantic-gc-fuel-baseline');
const target = symbols.define('target'), wrapper = symbols.define('wrapper');
const entry = symbols.define('entry'), x = symbols.define('x');
const w = symbols.define('w'), n = symbols.define('n'), y = symbols.define('y');
const append = capability('cap:test:append');
const registry = new CapabilityRegistry();
registry.declare(append, { arity: 1, description: 'One observed sink', effectful: true });
const targetDecl = b.fn({ symbol: target, params: [b.param(x, b.Int)],
  returns: b.Int, contract: b.contract({}), body: b.ret(b.add(b.v(x), b.int(1))) });
const wrapperDecl = b.fn({ symbol: wrapper, params: [b.param(w, b.Int)],
  returns: b.Int, contract: b.contract({}), body: b.block(b.ret(b.call(target, b.v(w)))) });
const entryDecl = (callee: typeof target) => b.fn({ symbol: entry,
  params: [b.param(n, b.Int)], returns: b.Int,
  capabilities: [append], purity: 'effectful', contract: b.contract({}),
  body: b.block(b.let_(y, b.Int, b.call(callee, b.v(n))),
    b.exprStmt(b.invoke(append, b.v(y))), b.ret(b.v(y))) });
const source = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(),
  members: [targetDecl, wrapperDecl, entryDecl(wrapper)] });
const candidate = { ...source, members: [targetDecl, entryDecl(target)] };
const sourceRoot = new GraphStore().intern(source);
const candidateRoot = new GraphStore().intern(candidate);
const json = (value: unknown) => JSON.stringify(value,
  (_key, item: unknown) => typeof item === 'bigint' ? `bigint:${item}` : item);
function run(module: typeof source, maxSteps: number) {
  const effects: string[] = [];
  const runtime = new Runtime({ registry, maxSteps, trace: true,
    effects: new Map([[append, args => { effects.push(String(args[0])); return null; }]]) });
  runtime.load(module);
  const result = runtime.call(entry, [3n]);
  return { result, effects,
    trace: runtime.trace.map(event => ({ step: event.step, kind: event.kind,
      node: event.node, detail: event.detail, depth: event.depth })) };
}
const budgets = Array.from({ length: 32 }, (_, index) => index + 1);
const observations = budgets.map(maxSteps => {
  const before = run(source, maxSteps), after = run(candidate, maxSteps);
  return { maxSteps,
    source: { ok: before.result.ok, fault: before.result.ok ? null : before.result.fault.kind,
      effects: before.effects, steps: before.result.steps },
    redirected: { ok: after.result.ok, fault: after.result.ok ? null : after.result.fault.kind,
      effects: after.effects, steps: after.result.steps },
    same: json(before) === json(after) };
});
const fullSource = run(source, 100), fullRedirected = run(candidate, 100);
process.stdout.write(JSON.stringify({ format: 'aether.gc-fuel-baseline/1',
  sourceRoot, candidateRoot, observations,
  sourceTrace: fullSource.trace, redirectedTrace: fullRedirected.trace },
(_key, item: unknown) => typeof item === 'bigint' ? `bigint:${item}` : item, 2) + '\n');
