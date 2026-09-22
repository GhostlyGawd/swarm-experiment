import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TypeScriptProjector, projectTypeScript } from '../../src/projection/typescript.ts';
import { parseTypeScript, parseExpression, ParseError } from '../../src/projection/parse.ts';
import { TypeNames } from '../../src/projection/names.ts';
import { buildLedgerExample, ACCOUNT, CENTS } from '../../src/examples/ledger.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { rng } from '../../src/util/rng.ts';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import type { SymbolId } from '../../src/tier1/ids.ts';

function bindingsOf(module: Term): Map<string, SymbolId> {
  const table = (module as Extract<Term, { kind: 'Module' }>).symbolTable;
  const out = new Map<string, SymbolId>();
  if (table.kind === 'SymbolTable') for (const [sym, name] of table.entries) out.set(name, sym);
  return out;
}

test('Risk R3: parse(project(x)) is the identical node, not merely an equivalent one', () => {
  const ex = buildLedgerExample();
  const projector = new TypeScriptProjector(ex.syms, {});
  const text = projector.decl(ex.module, 0);
  const back = parseTypeScript(text, {
    symbols: ex.syms,
    typeNames: projector.typeNames,
    bindings: bindingsOf(ex.module),
  });

  const store = new GraphStore();
  assert.equal(store.intern(back), store.intern(ex.module), 'same content address');
  assert.deepEqual(back, ex.module);
});

test('the round trip is idempotent under repetition', () => {
  const ex = buildLedgerExample();
  const bindings = bindingsOf(ex.module);
  let current = ex.module;
  for (let i = 0; i < 3; i++) {
    const projector = new TypeScriptProjector(ex.syms, {});
    const text = projector.decl(current, 0);
    current = parseTypeScript(text, {
      symbols: ex.syms,
      typeNames: projector.typeNames,
      bindings,
    });
  }
  assert.deepEqual(current, ex.module);
});

test('a human edit to the projection lands as a node mutation', () => {
  const ex = buildLedgerExample();
  const projector = new TypeScriptProjector(ex.syms, {});
  const text = projector.decl(ex.module, 0);

  // A human opens the projection and changes the fee divisor from 100 to 50.
  const edited = text.replace('return gross / 100n;', 'return gross / 50n;');
  assert.notEqual(edited, text, 'the edit applied to the projected text');

  const store = new GraphStore();
  const before = store.intern(ex.module);
  const after = store.intern(
    parseTypeScript(edited, {
      symbols: ex.syms,
      typeNames: projector.typeNames,
      bindings: bindingsOf(ex.module),
    }),
  );

  assert.notEqual(after, before);
  // Only the spine from the module root down to the literal was rewritten.
  const shared = [...store.reachable(before)].filter((r) => store.reachable(after).has(r));
  assert.ok(shared.length > 40, `${shared.length} nodes were reused unchanged`);
});

test('randomly generated expressions survive the round trip', () => {
  const syms = new SymbolSpace('fuzz-projection');
  const x = syms.define('x');
  const y = syms.define('y');
  const acct = syms.define('acct');
  const bindings = new Map<string, SymbolId>([['x', x], ['y', y], ['acct', acct]]);
  const types = new TypeNames();
  types.register(ACCOUNT.t === 'Record' ? ACCOUNT.name : ('type:x:y' as never));
  const random = rng('projection-fuzz');

  const leaves: Array<() => Term> = [
    () => b.int(random.bigint(-1000n, 1000n)),
    () => b.bool(random.bool()),
    () => b.v(x),
    () => b.v(y),
    () => b.field(b.v(acct), 'balance'),
  ];
  const gen = (depth: number): Term => {
    if (depth === 0) return random.pick(leaves)();
    switch (random.int(0, 5)) {
      case 0: return b.bin(random.pick(['add', 'sub', 'mul'] as const), gen(depth - 1), gen(depth - 1));
      case 1: return b.bin(random.pick(['lt', 'le', 'gt', 'ge', 'eq', 'ne'] as const), gen(depth - 1), gen(depth - 1));
      case 2: return b.and(b.bool(random.bool()), b.bin('lt', gen(depth - 1), gen(depth - 1)));
      case 3: return b.not(b.bin('lt', gen(depth - 1), gen(depth - 1)));
      case 4: return b.neg(gen(depth - 1));
      default: return b.cond(b.bool(random.bool()), gen(depth - 1), gen(depth - 1));
    }
  };

  for (let i = 0; i < 300; i++) {
    const term = gen(random.int(1, 4));
    const text = new TypeScriptProjector(syms, { typeNames: types }).expr(term);
    const back = parseExpression(text, { symbols: syms, typeNames: types, bindings });
    assert.deepEqual(back, term, `round trip failed for ${text}`);
  }
});

test('precedence is preserved without over-parenthesising', () => {
  const syms = new SymbolSpace('precedence');
  const x = syms.define('x');
  const y = syms.define('y');
  const z = syms.define('z');
  const bindings = new Map([['x', x], ['y', y], ['z', z]]);
  const p = new TypeScriptProjector(syms, {});

  // a - (b - c) must keep its parentheses; (a - b) - c must not gain any.
  const rightNested = b.sub(b.v(x), b.sub(b.v(y), b.v(z)));
  const leftNested = b.sub(b.sub(b.v(x), b.v(y)), b.v(z));
  assert.equal(p.expr(rightNested), 'x - (y - z)');
  assert.equal(p.expr(leftNested), 'x - y - z');
  for (const term of [rightNested, leftNested]) {
    assert.deepEqual(parseExpression(p.expr(term), { symbols: syms, bindings }), term);
  }

  // Mixed precedence drops the redundant parentheses a naive printer adds.
  assert.equal(p.expr(b.add(b.v(x), b.mul(b.v(y), b.v(z)))), 'x + y * z');
  assert.equal(p.expr(b.mul(b.add(b.v(x), b.v(y)), b.v(z))), '(x + y) * z');
});

test('an unsynthesized contract projects and parses as a body-less declaration', () => {
  const syms = new SymbolSpace('unsynth');
  const f = syms.define('needsBody');
  const n = syms.define('n');
  const decl = b.fn({
    symbol: f,
    params: [b.param(n, b.Int)],
    returns: b.Int,
    purity: 'pure',
    contract: b.contract({ ensures: [b.clause(b.ge(b.result(), b.v(n)), 'grows')] }),
    body: null,
  });
  const text = projectTypeScript(decl, syms, {});
  assert.match(text, /@unsynthesized/);
  const back = parseTypeScript(text, {
    symbols: syms,
    bindings: new Map([['needsBody', f], ['n', n]]),
  });
  const member = (back as Extract<Term, { kind: 'Module' }>).members[0];
  assert.deepEqual(member, decl);
});

test('out-of-scope identifiers are rejected rather than silently bound', () => {
  const syms = new SymbolSpace('scope');
  assert.throws(
    () => parseExpression('ghost + 1n', { symbols: syms }),
    (e: unknown) => e instanceof ParseError && /not in scope/.test((e as Error).message),
  );
});

test('result and old are only special inside an ensures clause', () => {
  const syms = new SymbolSpace('ctx');
  const result = syms.define('result');
  const parsed = parseExpression('result', {
    symbols: syms,
    bindings: new Map([['result', result]]),
  });
  assert.deepEqual(parsed, b.v(result), 'outside a contract it is an ordinary variable');
});

test('capabilities and provenance survive the projection', () => {
  const ex = buildLedgerExample();
  const text = projectTypeScript(ex.module, ex.syms, {});
  assert.match(text, /@capability cap:db:ledger_append/);
  assert.match(text, /@provenance prov:b3:[0-9a-f]{64}/);
  assert.match(text, /@modifies sender\.balance, receiver\.balance/);
  assert.match(text, /@surface batchSize: range\(1, 64, 1\) minimize_latency = 8/);
});

test('the auditor view adds causal lineage without changing the code', () => {
  const ex = buildLedgerExample();
  const plain = projectTypeScript(ex.module, ex.syms, {});
  const annotated = projectTypeScript(ex.module, ex.syms, { ledger: ex.ledger });
  assert.match(annotated, /Move funds between two accounts, atomically\./);
  assert.match(annotated, /@reasoning Guarded the debit/);
  assert.ok(annotated.length > plain.length);
  // The executable part is untouched: both parse to the same graph.
  const store = new GraphStore();
  const parse = (src: string) =>
    store.intern(parseTypeScript(src, {
      symbols: ex.syms,
      typeNames: new TypeScriptProjector(ex.syms, {}).typeNames,
      bindings: bindingsOf(ex.module),
    }));
  assert.equal(parse(plain), store.intern(ex.module));
});
