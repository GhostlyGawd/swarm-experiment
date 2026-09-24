/** Research-only M01 revision-2 virtual-frame experiment.
 * It patches private Runtime methods in this isolated process. Production AST,
 * compiler, typechecker, broker and checkpoint paths are not modified here. */
import assert from 'node:assert/strict';
import * as b from '../../../../src/tier1/build.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { capability } from '../../../../src/tier1/ids.ts';
import { CapabilityEnvelope, CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { Runtime } from '../../../../src/tier3/runtime.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';

const symbols = new SymbolSpace('semantic-gc-fuel-prototype');
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
if (source.kind !== 'Module') throw new Error('module builder returned a non-module');
const sourceMembers = source.members;
const candidate = { ...source, members: [targetDecl, entryDecl(target)] };
const sourceRoot = new GraphStore().intern(source);
const candidateRoot = new GraphStore().intern(candidate);

/** Only an exact empty-frame, one-argument, pure tail forwarder is admitted by
 * this research descriptor. It is derived from archived AST, not caller text. */
function derivePrelude() {
  const declaration = sourceMembers.find(item => item.kind === 'FunctionDecl'
    && item.symbol === wrapper);
  if (!declaration || declaration.kind !== 'FunctionDecl'
    || declaration.purity !== 'pure' || declaration.capabilities.length
    || declaration.typeParams.length || declaration.surfaces.length
    || declaration.params.length !== 1 || declaration.params[0].symbol !== w
    || declaration.contract?.kind !== 'Contract'
    || declaration.contract.requires.length || declaration.contract.modifies.length
    || declaration.contract.ensures.length || declaration.body?.kind !== 'Block'
    || declaration.body.stmts.length !== 1)
    throw new Error('unsupported virtual forwarder archive');
  const returned = declaration.body.stmts[0];
  if (returned.kind !== 'Return' || returned.value.kind !== 'Call'
    || returned.value.callee !== target || returned.value.args.length !== 1
    || returned.value.args[0].kind !== 'Var'
    || returned.value.args[0].symbol !== w)
    throw new Error('archived wrapper is not an exact tail forwarder');
  return ['Block', 'Return', 'Call', 'Var'] as const;
}
const wrapperPrelude = derivePrelude();
const descriptor = { format: 'aether.gc-virtual-forward-script/1',
  sourceRoot, candidateRoot, wrapper, target, prelude: wrapperPrelude };
const descriptorDigest = domainDigest(descriptor.format, descriptor);
function assertDescriptor(value: typeof descriptor, digest: string): void {
  assert.deepEqual(value, { ...descriptor, prelude: derivePrelude() });
  assert.equal(digest, domainDigest(value.format, value));
}
assertDescriptor(descriptor, descriptorDigest);
assert.throws(() => assertDescriptor({ ...descriptor,
  prelude: ['Block', 'Return', 'Call'] as unknown as typeof wrapperPrelude },
descriptorDigest));
function installVirtualForwarder(runtime: Runtime): void {
  const machine = runtime as unknown as Record<string, any>;
  const ordinaryEval = machine.eval as (...args: unknown[]) => unknown;
  machine.eval = function(expr: { kind: string; callee?: string; args?: unknown[] },
    caller: { decl: { symbol: string } }, result: unknown, old = false): unknown {
    if (expr.kind !== 'Call' || expr.callee !== target || caller.decl.symbol !== entry)
      return ordinaryEval.call(this, expr, caller, result, old);
    // Source Call(wrapper) and candidate Call(target) both tick, check the
    // empty capability envelope, then evaluate each original argument once.
    this.tick();
    const callee = this.functions.get(target);
    if (!callee || callee.capabilities.length) throw new Error('unsupported prototype target');
    const args = expr.args!.map(arg => ordinaryEval.call(this, arg, caller, result, old));
    const scope = new Map([[w, args[0] ?? null]]);
    const beforeHeap = new Map([...this.heap].map(([addr, record]) => [addr, new Map(record)]));
    const virtualFrame = { decl: wrapperDecl, scopes: [scope],
      envelope: CapabilityEnvelope.of(), preHeap: beforeHeap, preScope: new Map(scope) };
    this.frames.push(virtualFrame);
    this.emit('call', 'FunctionDecl', `${this.name(wrapper)}(${String(args[0])})`);
    try {
      for (const _sourceNode of wrapperPrelude) this.tick();
      const value = this.enter(callee, args);
      this.emit('return', 'Return', String(value));
      return value;
    } finally { this.frames.pop(); }
  };
}
function run(module: typeof source, input: bigint, maxSteps: number,
  virtual: boolean, captureSteps = false) {
  const sink: string[] = [], callbacks: unknown[] = [];
  const runtime = new Runtime({ registry, maxSteps, trace: true,
    ...(captureSteps ? { onStep: (event: unknown) => { callbacks.push(event); } } : {}),
    effects: new Map([[append, args => { sink.push(String(args[0])); return null; }]]) });
  runtime.load(module);
  if (virtual) installVirtualForwarder(runtime);
  const result = runtime.call(entry, [input]);
  return { result, sink, trace: runtime.trace, effects: runtime.effects, callbacks };
}
const inputs = [-1n, 0n, 3n], budgets = Array.from({ length: 64 }, (_, index) => index + 1);
let equal = 0;
const failures: Array<{ input: string; maxSteps: number; reason: string }> = [];
for (const input of inputs) for (const maxSteps of budgets) {
  const sourceRun = run(source, input, maxSteps, false, true);
  const candidateRun = run(candidate, input, maxSteps, true, true);
  try { assert.deepEqual(candidateRun, sourceRun); equal++; }
  catch (error) { failures.push({ input: String(input), maxSteps, reason: String(error) }); }
}
const summary = { format: 'aether.gc-virtual-forwarder-prototype/1',
  sourceRoot, candidateRoot, descriptorDigest,
  wrapperArchived: !candidate.members.includes(wrapperDecl),
  inputs: inputs.map(String), budgets: [1, 64], compared: inputs.length * budgets.length,
  equal, failures: failures.slice(0, 10), fullFailureCount: failures.length };
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
if (failures.length) process.exitCode = 1;
