import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSpec, parseSpec } from '../../src/tier2/spec.ts';
import { buildLedgerExample, ACCOUNT, CENTS } from '../../src/examples/ledger.ts';
import { verifyFunction } from '../../src/tier2/verify.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { TypeNames } from '../../src/projection/names.ts';
import type { Term } from '../../src/tier1/ast.ts';
import type { SymbolId } from '../../src/tier1/ids.ts';

const SOURCE = `
spec ledger {
  rule "A transfer may not overdraw the sender" on transfer {
    given sender.balance >= amount;
    given amount > 0n;
    then sender.balance >= 0n;
    changes sender.balance, receiver.balance;
    enforce client, gateway, persistence;
    because "An overdraft becomes an audited accounting discrepancy, not an error.";
    guard architectural;
  }
  rule "Transfers conserve money" on transfer {
    then sender.balance + receiver.balance === old(sender.balance) + old(receiver.balance);
    enforce gateway;
    rigor formal;
  }
}
`;

function context(ex: ReturnType<typeof buildLedgerExample>) {
  const table = (ex.module as Extract<Term, { kind: 'Module' }>).symbolTable;
  const bindings = new Map<string, SymbolId>();
  if (table.kind === 'SymbolTable') for (const [sym, name] of table.entries) bindings.set(name, sym);
  const types = new Map([['Account', ACCOUNT], ['Cents', CENTS]]);
  const typeNames = new TypeNames();
  typeNames.bind('Account', (ACCOUNT as { name: never }).name);
  typeNames.bind('Cents', (CENTS as { name: never }).name);
  return { symbols: ex.syms, bindings, types, typeNames };
}

test('FR-2.1: a business rule parses into mathematical relations', () => {
  const ex = buildLedgerExample();
  const spec = parseSpec(SOURCE, context(ex));
  assert.equal(spec.name, 'ledger');
  assert.equal(spec.rules.length, 2);

  const [overdraft, conservation] = spec.rules;
  assert.equal(overdraft.target, 'transfer');
  assert.equal(overdraft.given.length, 2);
  assert.equal(overdraft.then.length, 1);
  assert.deepEqual(overdraft.enforce, ['client', 'gateway', 'persistence']);
  assert.equal(overdraft.guard, 'architectural');
  assert.match(overdraft.invariant, /^inv:b3:[0-9a-f]{64}$/);

  // `old(...)` is available in a `then` clause, as in an ensures.
  const olds = [...JSON.stringify(conservation.then).matchAll(/"Old"/g)];
  assert.equal(olds.length, 2);
});

test('FR-2.1: one rule propagates to every layer it names', () => {
  const ex = buildLedgerExample();
  const compiled = compileSpec(parseSpec(SOURCE, context(ex)), context(ex), ex.ledger);
  const layers = compiled.artifacts.filter((a) => a.rule.startsWith('A transfer'));
  assert.deepEqual(layers.map((a) => a.layer), ['client', 'gateway', 'persistence']);

  const client = layers.find((a) => a.layer === 'client')!.code;
  const gateway = layers.find((a) => a.layer === 'gateway')!.code;
  const persistence = layers.find((a) => a.layer === 'persistence')!.code;

  // The same predicate, in three idioms.
  assert.match(client, /sender\.balance >= amount && amount > 0n/);
  assert.match(gateway, /check: \(args\) => sender\.balance >= amount && amount > 0n/);
  assert.match(gateway, /invariant: "inv:b3:[0-9a-f]{64}"/);
  assert.match(persistence, /CHECK \(sender\.balance >= amount AND amount > 0\)/);
  assert.match(persistence, /-- writes: sender\.balance, receiver\.balance/);
});

test('FR-2.1: compiled clauses are verifiable contracts, not documentation', () => {
  const ex = buildLedgerExample();
  const ctx = context(ex);
  const compiled = compileSpec(parseSpec(SOURCE, ctx), ctx);
  const contract = compiled.contracts.get('transfer')!;

  const transfer = (ex.module as Extract<Term, { kind: 'Module' }>).members.find(
    (m) => m.kind === 'FunctionDecl' && ex.syms.nameOf(m.symbol) === 'transfer',
  ) as Extract<Term, { kind: 'FunctionDecl' }>;

  const report = verifyFunction({ ...transfer, contract }, { symbols: ex.syms });
  assert.equal(report.verdict, 'proved', JSON.stringify(report.results.map((r) => [r.obligation.label, r.verdict])));
});

test('FR-1.3: changing a rule invalidates every subtree derived from it', () => {
  const ex = buildLedgerExample();
  const ctx = context(ex);
  const store = new GraphStore();
  const compiled = compileSpec(parseSpec(SOURCE, ctx), ctx, ex.ledger);

  const transfer = (ex.module as Extract<Term, { kind: 'Module' }>).members.find(
    (m) => m.kind === 'FunctionDecl' && ex.syms.nameOf(m.symbol) === 'transfer',
  )!;
  const moduleRef = store.intern(ex.module);
  const transferRef = store.intern(transfer);

  const provId = compiled.provenance.get('A transfer may not overdraw the sender')!;
  ex.ledger.bind(transferRef, provId as never);

  const clause = compiled.spec.rules[0].invariant;
  const report = ex.ledger.invalidateSpecClause(clause, store);

  assert.ok(report.affectedNodes.includes(transferRef), 'the derived function is flagged');
  assert.ok(report.affectedNodes.includes(moduleRef), 'invalidation propagates to the module');
  assert.ok(ex.ledger.isInvalidated(transferRef));
  assert.ok(report.reconciliationQueue.length > 0, 'agents are given something to reconcile');

  ex.ledger.reconcile(transferRef);
  assert.equal(ex.ledger.isInvalidated(transferRef), false);
});

test('an architectural guard from a spec blocks unexplained deletion', () => {
  const ex = buildLedgerExample();
  const ctx = context(ex);
  const store = new GraphStore();
  const compiled = compileSpec(parseSpec(SOURCE, ctx), ctx, ex.ledger);
  const transfer = (ex.module as Extract<Term, { kind: 'Module' }>).members[2];
  const ref = store.intern(transfer);
  ex.ledger.bind(ref, compiled.provenance.get('A transfer may not overdraw the sender')! as never);

  const verdict = ex.ledger.guardMutation(ref, []);
  assert.equal(verdict.allowed, false);
  if (!verdict.allowed) {
    assert.equal(verdict.blockedBy.priority, 'architectural');
    assert.match(verdict.explanation, /accounting discrepancy/);
    assert.match(verdict.explanation, /must be "proved", not fuzzed/);
  }
});

test('comments are ignored without shifting clause positions', () => {
  const ex = buildLedgerExample();
  const commented = `
// a leading comment
spec ledger {
  /* a block comment */
  rule "Transfers conserve money" on transfer {
    // and one inside a rule
    then sender.balance + receiver.balance === old(sender.balance) + old(receiver.balance);
    enforce gateway;
  }
}
`;
  const spec = parseSpec(commented, context(ex));
  assert.equal(spec.rules.length, 1);
  // The clause is recovered by slicing raw source, so a shifted offset would
  // corrupt the expression rather than merely fail to parse.
  const plain = parseSpec(
    'spec ledger {\n  rule "Transfers conserve money" on transfer {\n' +
      '    then sender.balance + receiver.balance === old(sender.balance) + old(receiver.balance);\n' +
      '    enforce gateway;\n  }\n}',
    context(ex),
  );
  assert.deepEqual(spec.rules[0].then, plain.rules[0].then);
  assert.equal(spec.rules[0].invariant, plain.rules[0].invariant);
});

test('a comment marker inside a string literal is not treated as a comment', () => {
  const ex = buildLedgerExample();
  const spec = parseSpec(
    'spec s {\n  rule "not // a comment" on transfer {\n    given amount > 0n;\n' +
      '    because "neither /* is this */";\n  }\n}',
    context(ex),
  );
  assert.equal(spec.rules[0].label, 'not // a comment');
  assert.equal(spec.rules[0].rationale, 'neither /* is this */');
  assert.equal(spec.rules[0].given.length, 1);
});

test('malformed specifications are rejected with a line number', () => {
  const ex = buildLedgerExample();
  const ctx = context(ex);
  assert.throws(
    () => parseSpec('spec x {\n  rule "r" on transfer {\n    enforce moon;\n  }\n}', ctx),
    /unknown layer moon at line 3/,
  );
  assert.throws(() => parseSpec('spec x {\n  rule "r" on t {\n    wobble;\n  }\n}', ctx),
    /unknown rule clause wobble/);
});
