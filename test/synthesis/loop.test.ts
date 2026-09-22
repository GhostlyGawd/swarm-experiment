import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOutcome, purgeBody, synthesize, type Synthesizer } from '../../src/synthesis/loop.ts';
import { EnumerativeSynthesizer } from '../../src/synthesis/enumerative.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { ProvenanceLedger } from '../../src/tier1/provenance.ts';
import { buildLedgerExample, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';

const registry = new CapabilityRegistry();
registry.declare('cap:db:ledger_append', { arity: 3, description: 'append a ledger entry' });

function maxSpec(syms: SymbolSpace) {
  const max = syms.define('max');
  const a = syms.define('a');
  const c = syms.define('b');
  return b.fn({
    symbol: max,
    params: [b.param(a, b.Int), b.param(c, b.Int)],
    returns: b.Int,
    purity: 'pure',
    contract: b.contract({
      ensures: [
        b.clause(b.ge(b.result(), b.v(a)), 'at_least_a'),
        b.clause(b.ge(b.result(), b.v(c)), 'at_least_b'),
        b.clause(b.or(b.eq(b.result(), b.v(a)), b.eq(b.result(), b.v(c))), 'is_one_of'),
      ],
    }),
    body: null,
  }) as Extract<Term, { kind: 'FunctionDecl' }>;
}

test('FR-2.2: a body is synthesized from a contract alone and formally proved', () => {
  const syms = new SymbolSpace('synth-max');
  const outcome = synthesize(
    maxSpec(syms),
    new EnumerativeSynthesizer({ registry, seed: 'max' }),
    { registry, symbols: syms, seed: 'max', microWorldCases: 60 },
  );
  assert.equal(outcome.status, 'synthesized');
  if (outcome.status !== 'synthesized') return;
  assert.equal(outcome.provenFormally, true);
  assert.equal(outcome.verification.verdict, 'proved');
  assert.equal(outcome.simulation.accepted, true);
  assert.ok(outcome.declaration.body, 'the contract now has an implementation');
});

test('Risk R4: an unsatisfiable contract stalls and escalates to a human', () => {
  const syms = new SymbolSpace('impossible');
  const y = syms.define('y');
  const spec = b.fn({
    symbol: syms.define('impossible'),
    params: [b.param(y, b.Int)],
    returns: b.Int,
    purity: 'pure',
    contract: b.contract({
      ensures: [
        b.clause(b.gt(b.result(), b.v(y)), 'greater'),
        b.clause(b.lt(b.result(), b.v(y)), 'lesser'),
      ],
    }),
    body: null,
  });
  const outcome = synthesize(
    spec,
    new EnumerativeSynthesizer({ registry, seed: 'nope', maxDepth: 1, maxCandidates: 400 }),
    { registry, symbols: syms, maxIterations: 5 },
  );
  assert.equal(outcome.status, 'stalled');
  if (outcome.status !== 'stalled') return;
  assert.equal(outcome.reason, 'SynthesisStall');
  assert.match(outcome.escalation, /SynthesisStall: enumerative-cegis failed/);
  assert.match(outcome.escalation, /budget gate, not a solver limit/);
  assert.match(outcome.escalation, /Next step for a human/);
});

test('Risk R4: the iteration budget is a hard ceiling', () => {
  const syms = new SymbolSpace('budget');
  const spec = maxSpec(syms);
  let calls = 0;
  // A synthesizer that always returns a wrong body, forever.
  const stubborn: Synthesizer = {
    name: 'stubborn',
    propose: () => {
      calls++;
      return b.block(b.ret(b.int(calls)));
    },
  };
  const outcome = synthesize(spec, stubborn, {
    registry, symbols: syms, maxIterations: 3, microWorldCases: 20,
  });
  assert.equal(outcome.status, 'stalled');
  assert.equal(calls, 3, 'the loop stopped asking after three attempts');
  assert.equal(outcome.attempts.length, 3);
});

test('feedback from each stage is structured, not prose', () => {
  const syms = new SymbolSpace('feedback');
  const spec = maxSpec(syms);
  const seen: string[] = [];
  const observer: Synthesizer = {
    name: 'observer',
    propose: (_spec, feedback) => {
      for (const f of feedback) seen.push(f.stage);
      // First a capability violation, then a wrong answer, then nothing.
      if (seen.length === 0) {
        return b.block(b.exprStmt(b.invoke(CAP_LEDGER_APPEND, b.str('a'), b.str('b'), b.int(1))), b.ret(b.int(0)));
      }
      if (seen.filter((s) => s === 'typecheck').length === 1 && !seen.includes('verification')) {
        return b.block(b.ret(b.int(0)));
      }
      return null;
    },
  };
  const outcome = synthesize(spec, observer, {
    registry, symbols: syms, maxIterations: 4, microWorldCases: 20,
  });
  assert.equal(outcome.status, 'stalled');
  const stages = outcome.attempts.map((a) => a.stage);
  assert.deepEqual(stages.slice(0, 2), ['typecheck', 'verification']);

  const typeFeedback = outcome.attempts[0].feedback!;
  assert.equal(typeFeedback.stage, 'typecheck');
  if (typeFeedback.stage === 'typecheck') {
    assert.equal(typeFeedback.diagnostics[0].code, 'capability_not_granted');
  }
  const verifyFeedback = outcome.attempts[1].feedback!;
  assert.equal(verifyFeedback.stage, 'verification');
  if (verifyFeedback.stage === 'verification') {
    assert.ok(verifyFeedback.refuted.length > 0);
    // Counterexamples read like source, not like SMT internals.
    const keys = Object.keys(verifyFeedback.refuted[0].counterexample);
    assert.ok(keys.every((k) => !k.includes('#') && !k.includes('!')), keys.join(', '));
    assert.match(verifyFeedback.refuted[0].smtLib, /\(check-sat\)/);
  }
});

test('the search prefers a provable body over a merely-passing one', () => {
  const syms = new SymbolSpace('prefer');
  const x = syms.define('x');
  const spec = b.fn({
    symbol: syms.define('abs'),
    params: [b.param(x, b.Int)],
    returns: b.Int,
    purity: 'pure',
    contract: b.contract({
      ensures: [
        b.clause(b.ge(b.result(), b.int(0)), 'non_negative'),
        b.clause(b.or(b.eq(b.result(), b.v(x)), b.eq(b.result(), b.neg(b.v(x)))), 'magnitude'),
      ],
    }),
    body: null,
  });

  // Both bodies are correct. The first multiplies by a conditional, which
  // leaves the linear fragment and is only property-checkable; the second
  // stays inside it and can be proved.
  const unprovable = b.block(b.ret(b.mul(b.v(x), b.cond(b.lt(b.v(x), b.int(0)), b.int(-1), b.int(1)))));
  const provable = b.block(b.ret(b.cond(b.lt(b.v(x), b.int(0)), b.neg(b.v(x)), b.v(x))));
  const inOrder = (): Synthesizer => {
    let n = 0;
    return { name: 'two-candidates', propose: () => (n++ === 0 ? unprovable : provable) };
  };

  const eager = synthesize(spec, inOrder(), {
    registry, symbols: syms, seed: 'abs', preferProved: false, microWorldCases: 40,
  });
  assert.equal(eager.status, 'synthesized');
  if (eager.status !== 'synthesized') return;
  assert.equal(eager.provenFormally, false, 'took the first passing candidate');
  assert.deepEqual(eager.declaration.body, unprovable);
  assert.ok(eager.verification.unprovenFormalContracts.length > 0);
  assert.match(formatOutcome(eager, syms), /UnprovenFormalContract/);

  const patient = synthesize(spec, inOrder(), {
    registry, symbols: syms, seed: 'abs', preferProved: true, microWorldCases: 40,
  });
  assert.equal(patient.status, 'synthesized');
  if (patient.status !== 'synthesized') return;
  assert.equal(patient.provenFormally, true, 'kept looking and found the provable body');
  assert.deepEqual(patient.declaration.body, provable);
  assert.equal(patient.verification.verdict, 'proved');
  assert.ok(patient.attempts.length > eager.attempts.length, 'it paid an extra cycle for the proof');
});

test('an unprovable body is still shipped when nothing better exists', () => {
  const syms = new SymbolSpace('fallback');
  const x = syms.define('x');
  const spec = b.fn({
    symbol: syms.define('abs'),
    params: [b.param(x, b.Int)],
    returns: b.Int,
    purity: 'pure',
    contract: b.contract({
      ensures: [b.clause(b.ge(b.result(), b.int(0)), 'non_negative')],
    }),
    body: null,
  });
  const unprovable = b.block(b.ret(b.mul(b.v(x), b.cond(b.lt(b.v(x), b.int(0)), b.int(-1), b.int(1)))));
  const onlyOne: Synthesizer = {
    name: 'one-candidate',
    propose: (_s, _f, attempt) => (attempt === 1 ? unprovable : null),
  };
  const outcome = synthesize(spec, onlyOne, {
    registry, symbols: syms, preferProved: true, maxIterations: 3, microWorldCases: 40,
  });
  assert.equal(outcome.status, 'synthesized', 'tiered rigor accepts property evidence');
  if (outcome.status !== 'synthesized') return;
  assert.equal(outcome.provenFormally, false);
  assert.deepEqual(outcome.declaration.body, unprovable);
});

test('a capability-using body still has to pass the capability checker', () => {
  const ex = buildLedgerExample();
  const syms = ex.syms;
  const spec = b.fn({
    symbol: syms.define('logOnly'),
    returns: b.Unit,
    purity: 'effectful',
    capabilities: [], // declares nothing
    body: null,
  });
  const sneaky: Synthesizer = {
    name: 'sneaky',
    propose: () => b.block(
      b.exprStmt(b.invoke(CAP_LEDGER_APPEND, b.str('a'), b.str('b'), b.int(1))),
      b.ret(b.unit()),
    ),
  };
  const outcome = synthesize(spec, sneaky, {
    registry: ex.capabilities, symbols: syms, maxIterations: 2,
  });
  assert.equal(outcome.status, 'stalled');
  for (const attempt of outcome.attempts) assert.equal(attempt.stage, 'typecheck');
});

test('FR-2.2: a body that breaks its contract is purged, not patched', () => {
  const ex = buildLedgerExample();
  const store = new GraphStore();
  const ledger = new ProvenanceLedger(() => 42);
  const root = store.intern(ex.module);

  const purged = purgeBody(store, root, ex.symbols.feeFor, ledger, 'postcondition fee_within_gross');
  assert.equal(purged.purged, true);
  assert.notEqual(purged.root, root);

  const after = store.hydrate(purged.root) as Extract<Term, { kind: 'Module' }>;
  const feeFor = after.members.find(
    (m) => m.kind === 'FunctionDecl' && m.symbol === ex.symbols.feeFor,
  ) as Extract<Term, { kind: 'FunctionDecl' }>;
  assert.equal(feeFor.body, null, 'the implementation is gone');
  assert.ok(feeFor.contract, 'the contract is untouched');

  // The original module is unchanged: purging produced a new version.
  const before = store.hydrate(root) as Extract<Term, { kind: 'Module' }>;
  const original = before.members.find(
    (m) => m.kind === 'FunctionDecl' && m.symbol === ex.symbols.feeFor,
  ) as Extract<Term, { kind: 'FunctionDecl' }>;
  assert.ok(original.body, 'history is immutable');

  // Purging twice is a no-op.
  assert.equal(purgeBody(store, purged.root, ex.symbols.feeFor, ledger).purged, false);
});

test('a purge records why the implementation was removed', () => {
  const ex = buildLedgerExample();
  const store = new GraphStore();
  const ledger = new ProvenanceLedger(() => 7);
  const root = store.intern(ex.module);
  const { root: next } = purgeBody(store, root, ex.symbols.feeFor, ledger, 'overflow on large inputs');

  const after = store.findPath(next, (n) => n.kind === 'FunctionDecl' && n.symbol === ex.symbols.feeFor)!;
  const ref = store.resolvePath(next, after).at(-1)!;
  const explanation = ledger.explain(ref);
  assert.match(explanation, /Implementation purged: overflow on large inputs/);
  assert.match(explanation, /The contract stands; a new body is owed/);
  assert.match(explanation, /synthesis_repair/);
});

test('counterexamples accumulate across attempts', () => {
  const syms = new SymbolSpace('cegis');
  const synthesizer = new EnumerativeSynthesizer({ registry, seed: 'cegis' });
  synthesize(maxSpec(syms), synthesizer, {
    registry, symbols: syms, maxIterations: 3, microWorldCases: 30,
  });
  assert.ok(synthesizer.exampleCount >= 12, `only ${synthesizer.exampleCount} examples retained`);
});
