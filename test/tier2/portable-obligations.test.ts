import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as b from '../../src/tier1/build.ts';
import { children, type Term } from '../../src/tier1/ast.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import type { SymbolId } from '../../src/tier1/ids.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { derivePortableObligations, PORTABLE_DERIVATION_PROFILE_DIGEST, type PortableObligationSet, type ResolvedPortableDependency } from '../../src/tier2/portable-obligations.ts';
import { generateFormulaCertificate } from '../../src/tier2/portable-formula-producer.ts';
import { checkFormulaCertificate } from '../../src/tier2/portable-formula-checker.ts';
import { declarations, evaluate } from '../../src/tier2/smt.ts';

const functionDecl = (spec: Parameters<typeof b.fn>[0]): Extract<Term, { kind: 'FunctionDecl' }> => b.fn(spec) as Extract<Term, { kind: 'FunctionDecl' }>;
const digest = (name: string) => domainDigest('aether.test/1', name);
function setup(members: readonly Term[], symbols: SymbolSpace, dependencies: readonly ResolvedPortableDependency[] = []) {
  const module = b.module_({ symbol: symbols.define('module'), members, symbolTable: symbols.table() });
  const store = new GraphStore(), functions = new Map<SymbolId, Term>();
  for (const member of members) if (member.kind === 'FunctionDecl') functions.set(member.symbol, member);
  dependencies.forEach(item => functions.set(item.symbol, item.declaration));
  const calls = (node: Term): SymbolId[] => [...(node.kind === 'Call' ? [node.callee] : []), ...children(node).flatMap(calls)];
  const closure = new Set<SymbolId>(), pending = members.flatMap(calls);
  while (pending.length) { const symbol = pending.pop()!; if (closure.has(symbol)) continue; closure.add(symbol); const declaration = functions.get(symbol); if (!declaration) throw new Error('fixture dependency missing'); pending.push(...calls(declaration)); }
  const specification = 'Pure scalar executable contracts are the formal specification.';
  const manifest: ExecutionManifestV1 = {
    format: 'aether.execution/1', astRoot: store.intern(module), specRoot: domainDigest('aether.specification/1', specification),
    dependencies: [...closure].sort().map(symbol => ({ symbol, declaration: store.intern(functions.get(symbol)!) })),
    semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'), target: { abiVersion: 'scalar-test/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') }, capabilityPolicyDigest: digest('pure-policy'), evidencePolicyDigest: digest('portable-policy'),
  };
  const options = { manifest, expectedManifest: manifest, specification, dependencies };
  return { module, options, derive: () => derivePortableObligations(module, options) };
}
function certify(set: PortableObligationSet): void {
  assert.deepEqual(set.unsupported, []);
  assert.ok(set.obligations.length > 0);
  for (const obligation of set.obligations) {
    const proof = generateFormulaCertificate(obligation.formula, set.manifestDigest);
    assert.ok(proof, `failed to generate ${obligation.kind}`);
    assert.doesNotThrow(() => checkFormulaCertificate(obligation.formula, proof, set.manifestDigest), obligation.kind);
  }
}
const contract = (post: Term, pre: Term[] = []) => b.contract({ requires: pre.map((p, index) => b.clause(p, `pre-${index}`)), ensures: [b.clause(post, 'post')] });


test('independent derivation binds full AST/spec/manifest and produces deterministic checked increment obligations', () => {
  const symbols = new SymbolSpace('portable-increment'), fn = symbols.define('increment'), x = symbols.define('x');
  const fixture = setup([functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.eq(b.result(), b.add(b.old(b.v(x)), b.int(1)))), body: b.block(b.ret(b.add(b.v(x), b.int(1)))) })], symbols);
  const first = fixture.derive(); certify(first);
  assert.deepEqual(fixture.derive(), first); assert.equal(first.profileDigest, PORTABLE_DERIVATION_PROFILE_DIGEST);
  assert.ok(Object.isFrozen(first.obligations));
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, specification: 'changed' }), /specification root/);
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, manifest: { ...fixture.options.manifest, compilerDigest: digest('changed') } }), /trusted execution manifest/);
  const changed = { ...fixture.options.manifest, astRoot: new GraphStore().intern(b.int(1)) };
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, manifest: changed, expectedManifest: changed }), /AST root/);
});

test('false postconditions remain false under concrete counterexamples and cannot receive certificates', () => {
  const symbols = new SymbolSpace('portable-false'), fn = symbols.define('bad'), x = symbols.define('x');
  const result = setup([functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.eq(b.result(), b.add(b.v(x), b.int(2)))), body: b.block(b.ret(b.add(b.v(x), b.int(1)))) })], symbols).derive();
  assert.deepEqual(result.unsupported, []);
  const post = result.obligations.find(item => item.kind === 'postcondition')!;
  const assignment = Object.fromEntries(declarations(post.formula).ints.map(name => [name, 0n]));
  assert.equal(evaluate(post.formula, assignment), false);
  assert.equal(generateFormulaCertificate(post.formula, result.manifestDigest), null);
});

test('both if branches and missing-return paths are represented', () => {
  const symbols = new SymbolSpace('portable-branches'), fn = symbols.define('abs'), x = symbols.define('x');
  const body = b.if_(b.ge(b.v(x), b.int(0)), b.ret(b.v(x)), b.ret(b.neg(b.v(x))));
  const result = setup([functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.ge(b.result(), b.int(0))), body })], symbols).derive();
  certify(result); assert.equal(result.obligations.filter(item => item.kind === 'postcondition').length, 2);
  const missing = setup([functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, body: b.if_(b.ge(b.v(x), b.int(0)), b.ret(b.v(x))) })], symbols).derive();
  const obligation = missing.obligations.find(item => item.kind === 'missing-return')!;
  assert.ok(obligation); assert.equal(generateFormulaCertificate(obligation.formula, missing.manifestDigest), null);
});

test('short-circuit evaluation guards call preconditions on only the evaluated path', () => {
  const symbols = new SymbolSpace('portable-shortcircuit'), entry = symbols.define('entry'), callee = symbols.define('positive'), x = symbols.define('x');
  const target = functionDecl({ symbol: callee, params: [b.param(x, b.Int)], returns: b.Bool, contract: contract(b.eq(b.result(), b.bool(true)), [b.gt(b.v(x), b.int(0))]), body: b.ret(b.bool(true)) });
  const caller = functionDecl({ symbol: entry, returns: b.Bool, contract: contract(b.eq(b.result(), b.bool(false))), body: b.ret(b.and(b.bool(false), b.call(callee, b.int(0)))) });
  const result = setup([target, caller], symbols).derive(); certify(result);
  assert.ok(result.obligations.some(item => item.kind === 'call-precondition'));
  const invalid = { ...caller, body: b.ret(b.call(callee, b.int(0))) };
  const rejected = setup([target, invalid], symbols).derive();
  assert.ok(rejected.obligations.some(item => item.kind === 'call-precondition' && generateFormulaCertificate(item.formula, rejected.manifestDigest) === null));
});

test('modular calls bind old input separately from mutable callee post-state parameters', () => {
  const symbols = new SymbolSpace('portable-post-params'), callee = symbols.define('callee'), caller = symbols.define('caller'), x = symbols.define('x'), y = symbols.define('y');
  const target = functionDecl({ symbol: callee, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.eq(b.result(), b.v(x))), body: b.block(b.assign(b.place(x), b.int(999)), b.ret(b.v(x))) });
  const entry = functionDecl({ symbol: caller, params: [b.param(y, b.Int)], returns: b.Int, contract: contract(b.eq(b.result(), b.old(b.v(y)))), body: b.ret(b.call(callee, b.v(y))) });
  const result = setup([target, entry], symbols).derive(); assert.deepEqual(result.unsupported, []);
  const falseClaim = result.obligations.find(item => item.symbol === caller && item.kind === 'postcondition')!;
  assert.equal(generateFormulaCertificate(falseClaim.formula, result.manifestDigest), null, 'callee post x cannot become caller entry y');
  const increment = { ...target, contract: contract(b.eq(b.result(), b.add(b.old(b.v(x)), b.int(1)))), body: b.block(b.assign(b.place(x), b.add(b.v(x), b.int(1))), b.ret(b.v(x))) };
  const correct = { ...entry, contract: contract(b.eq(b.result(), b.add(b.old(b.v(y)), b.int(1)))) };
  certify(setup([increment, correct], symbols).derive());
});

test('loop induction derives initialization, preservation, ranking and postcondition proofs without unrolling', () => {
  const symbols = new SymbolSpace('portable-loop'), fn = symbols.define('countdown'), x = symbols.define('x');
  const loop = b.while_(b.gt(b.v(x), b.int(0)), b.block(b.assign(b.place(x), b.sub(b.v(x), b.int(1)))), { invariants: [b.ge(b.v(x), b.int(0))], variant: b.v(x) });
  const decl = functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.eq(b.result(), b.int(0)), [b.ge(b.v(x), b.int(0))]), body: b.block(loop, b.ret(b.v(x))) });
  const result = setup([decl], symbols).derive(); certify(result);
  for (const kind of ['loop-invariant-init', 'loop-invariant-preservation', 'loop-variant-nonnegative', 'loop-variant-decrease', 'postcondition']) assert.ok(result.obligations.some(item => item.kind === kind), kind);
  const wrong = b.while_(b.gt(b.v(x), b.int(0)), b.block(b.assign(b.place(x), b.add(b.v(x), b.int(1)))), { invariants: [b.ge(b.v(x), b.int(0))], variant: b.v(x) });
  const rejected = setup([{ ...decl, body: b.block(wrong, b.ret(b.v(x))) }], symbols).derive();
  assert.ok(rejected.obligations.some(item => item.kind === 'loop-variant-decrease' && generateFormulaCertificate(item.formula, rejected.manifestDigest) === null));
});

test('loop havoc prevents proving exit values from stale pre-loop mutable bindings', () => {
  const symbols = new SymbolSpace('portable-loop-stale'), fn = symbols.define('countdown'), x = symbols.define('x');
  const decl = functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.eq(b.result(), b.old(b.v(x))), [b.gt(b.v(x), b.int(0))]), body: b.block(b.while_(b.gt(b.v(x), b.int(0)), b.assign(b.place(x), b.sub(b.v(x), b.int(1))), { invariants: [b.ge(b.v(x), b.int(0))], variant: b.v(x) }), b.ret(b.v(x))) });
  const result = setup([decl], symbols).derive();
  assert.ok(result.obligations.some(item => item.kind === 'postcondition' && generateFormulaCertificate(item.formula, result.manifestDigest) === null));
});

test('external declarations are hashed and complete transitive local/external closure is mandatory', () => {
  const symbols = new SymbolSpace('portable-dependency'), entry = symbols.define('entry'), remote = symbols.define('remote');
  const dependency = functionDecl({ symbol: remote, returns: b.Int, contract: contract(b.eq(b.result(), b.int(7))), body: b.ret(b.int(7)) });
  const root = functionDecl({ symbol: entry, returns: b.Int, contract: contract(b.eq(b.result(), b.int(7))), body: b.ret(b.call(remote)) });
  const fixture = setup([root], symbols, [{ symbol: remote, declaration: dependency }]); certify(fixture.derive());
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, dependencies: [] }), /unresolved/);
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, dependencies: [{ symbol: remote, declaration: { ...dependency, body: b.ret(b.int(8)) } }] }), /changed portable dependency closure/);
  const omitted = { ...fixture.options.manifest, dependencies: [] };
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, manifest: omitted, expectedManifest: omitted }), /dependency closure/);
});

test('property clauses, recursion, missing ranking and unsupported heap/fixed-width types stay unproved', () => {
  const symbols = new SymbolSpace('portable-unsupported'), fn = symbols.define('fn'), x = symbols.define('x');
  const base = functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.v(x)) });
  const cases: Term[] = [
    { ...base, contract: b.contract({ ensures: [b.clause(b.bool(true), 'sampled', 'property')] }) },
    { ...base, body: b.ret(b.call(fn, b.v(x))) },
    { ...base, body: b.block(b.while_(b.bool(true), b.block()), b.ret(b.v(x))) },
    { ...base, returns: { t: 'IntN', bits: 64, signed: true, overflow: 'wrap' } },
    { ...base, body: b.block(b.ret(b.v(x)), { kind: 'Invoke', capability: 'cap:test:effect' as never, args: [] }) },
    { ...base, body: b.ret(b.mul(b.v(x), b.v(x))) },
    { ...base, body: b.ret(b.old(b.v(x))) },
  ];
  for (const decl of cases) { const result = setup([decl], symbols).derive(); assert.ok(result.unsupported.length > 0, JSON.stringify(decl, (_, value) => typeof value === 'bigint' ? String(value) : value)); }
});

test('lexical locals do not escape their block and malformed scalar bindings cannot hide behind certificates', () => {
  const symbols = new SymbolSpace('portable-scope'), fn = symbols.define('fn'), local = symbols.define('local');
  const fixture = setup([functionDecl({ symbol: fn, returns: b.Int, body: b.block(b.block(b.let_(local, b.Int, b.int(1))), b.ret(b.v(local))) })], symbols);
  assert.ok(fixture.derive().unsupported.some(item => item.reason.includes('unbound')));
});

test('resource limits tighten only and independent source has no verifier/solver/evidence dependency', () => {
  const symbols = new SymbolSpace('portable-limits'), fn = symbols.define('fn');
  const fixture = setup([functionDecl({ symbol: fn, returns: b.Int, body: b.ret(b.int(1)) })], symbols);
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, limits: { maxPaths: 9999 } }), /only tighten/);
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, limits: { maxAstNodes: 1 } }), /limit/);
  const text = readFileSync(new URL('../../src/tier2/portable-obligations.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /from ['"][^'"]*(?:verify|solver|evidence|producer)[^'"]*['"]/);
});

test('an assertion is a required proof obligation before its condition may be assumed', () => {
  const symbols = new SymbolSpace('portable-assertion'), fn = symbols.define('fn'), x = symbols.define('x');
  const decl = functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.gt(b.result(), b.int(0))), body: b.block(b.assert_(b.gt(b.v(x), b.int(0)), 'must-positive'), b.ret(b.v(x))) });
  const result = setup([decl], symbols).derive();
  const assertion = result.obligations.find(item => item.kind === 'assertion')!;
  assert.equal(generateFormulaCertificate(assertion.formula, result.manifestDigest), null);
  const postcondition = result.obligations.find(item => item.kind === 'postcondition')!;
  assert.ok(generateFormulaCertificate(postcondition.formula, result.manifestDigest), 'later proof relies on an independently required assertion obligation');
});

test('input accessors, path explosion and aggregate formula budgets reject deterministically', () => {
  const symbols = new SymbolSpace('portable-input'), fn = symbols.define('fn'), condition = symbols.define('condition');
  const fixture = setup([functionDecl({ symbol: fn, params: [b.param(condition, b.Bool)], returns: b.Int, body: b.ret(b.cond(b.v(condition), b.int(1), b.int(2))) })], symbols);
  let invoked = 0;
  const malicious = { ...fixture.module };
  Object.defineProperty(malicious, 'kind', { get() { invoked++; return 'Module'; }, enumerable: true });
  assert.throws(() => derivePortableObligations(malicious, fixture.options), /accessor/); assert.equal(invoked, 0);
  const proxy = new Proxy(fixture.module, { ownKeys(target) { invoked++; return Reflect.ownKeys(target); } });
  assert.throws(() => derivePortableObligations(proxy, fixture.options), /proxy/); assert.equal(invoked, 0);
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, limits: { maxPaths: 1 } }), /path limit/);
  assert.throws(() => derivePortableObligations(fixture.module, { ...fixture.options, limits: { maxFormulaNodes: 1 } }), /formula limit/);
});

test('certified arithmetic, branching, scoped mutation and loop programs agree with actual reference execution', async () => {
  const { Runtime } = await import('../../src/tier3/runtime.ts');
  const { CapabilityRegistry } = await import('../../src/tier2/ocap.ts');
  const symbols = new SymbolSpace('portable-runtime'), abs = symbols.define('abs'), affine = symbols.define('affine'), loop = symbols.define('loop'), x = symbols.define('x'), local = symbols.define('local');
  const members = [
    functionDecl({ symbol: abs, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.ge(b.result(), b.int(0))), body: b.ret(b.cond(b.ge(b.v(x), b.int(0)), b.v(x), b.neg(b.v(x)))) }),
    functionDecl({ symbol: affine, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.eq(b.result(), b.add(b.mul(b.old(b.v(x)), b.int(3)), b.int(4)))), body: b.block(b.let_(local, b.Int, b.mul(b.v(x), b.int(3))), b.block(b.assign(b.place(local), b.add(b.v(local), b.int(4)))), b.ret(b.v(local))) }),
    functionDecl({ symbol: loop, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.eq(b.result(), b.int(0)), [b.ge(b.v(x), b.int(0))]), body: b.block(b.while_(b.gt(b.v(x), b.int(0)), b.assign(b.place(x), b.sub(b.v(x), b.int(1))), { invariants: [b.ge(b.v(x), b.int(0))], variant: b.v(x) }), b.ret(b.v(x))) }),
  ];
  const fixture = setup(members, symbols); certify(fixture.derive());
  const runtime = new Runtime({ registry: new CapabilityRegistry(), symbols }); runtime.load(fixture.module);
  for (let value = -8n; value <= 8n; value++) {
    const absolute = runtime.call(abs, [value]); assert.equal(absolute.ok, true); if (absolute.ok) assert.equal(absolute.value, value < 0n ? -value : value);
    const transformed = runtime.call(affine, [value]); assert.equal(transformed.ok, true); if (transformed.ok) assert.equal(transformed.value, value * 3n + 4n);
    if (value >= 0n) { const counted = runtime.call(loop, [value]); assert.equal(counted.ok, true); if (counted.ok) assert.equal(counted.value, 0n); }
  }
});


test('unreachable statements still require lexical binding, scalar sorts and valid assignment targets', () => {
  const symbols = new SymbolSpace('portable-dead-static'), fn = symbols.define('fn'), missing = symbols.define('missing'), local = symbols.define('local');
  const tails: Term[] = [
    b.exprStmt(b.v(missing)),
    b.let_(local, b.Int, b.bool(true)),
    b.assign(b.place(missing), b.int(1)),
    b.assign(b.int(1), b.int(2)),
    b.ret(b.bool(true)),
    b.if_(b.int(1), b.ret(b.int(1))),
    b.exprStmt(b.add(b.bool(true), b.int(1))),
    b.exprStmt(b.mul(b.v(missing), b.v(missing))),
  ];
  for (const tail of tails) {
    const fixture = setup([functionDecl({ symbol: fn, returns: b.Int, contract: contract(b.eq(b.result(), b.int(1))), body: b.block(b.ret(b.int(1)), tail) })], symbols);
    assert.ok(fixture.derive().unsupported.length > 0, `unreachable ${tail.kind} must still be checked`);
  }
});


test('malformed declaration arrays and unknown AST fields cannot receive portable certificates', () => {
  const symbols = new SymbolSpace('portable-shape'), fn = symbols.define('fn');
  const base = functionDecl({ symbol: fn, returns: b.Int, contract: contract(b.eq(b.result(), b.int(1))), body: b.ret(b.int(1)) });
  for (const patch of [{ capabilities: 0 }, { typeParams: 0 }, { trust: true }]) {
    const fixture = setup([{ ...base, ...patch } as unknown as Term], symbols);
    assert.throws(() => fixture.derive(), /malformed|unknown/);
  }
});


test('dead nonlinear arithmetic remains unsupported while constant-factor arithmetic is certified', () => {
  const symbols = new SymbolSpace('portable-dead-theory'), fn = symbols.define('fn'), x = symbols.define('x');
  const dead = setup([functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, body: b.block(b.ret(b.int(1)), b.exprStmt(b.mul(b.v(x), b.v(x)))) })], symbols).derive();
  assert.ok(dead.unsupported.some(item => item.reason.includes('multiplication')));
  const linear = setup([functionDecl({ symbol: fn, params: [b.param(x, b.Int)], returns: b.Int, contract: contract(b.eq(b.result(), b.mul(b.v(x), b.int(5)))), body: b.ret(b.mul(b.v(x), b.add(b.int(2), b.int(3)))) })], symbols).derive();
  certify(linear);
});
