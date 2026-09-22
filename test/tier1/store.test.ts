import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphStore, hashNode } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { canonicalText } from '../../src/tier1/canonical.ts';
import { size, walk, type Term } from '../../src/tier1/ast.ts';
import * as b from '../../src/tier1/build.ts';
import { typeName, type NodeRef } from '../../src/tier1/ids.ts';

const CENTS = typeName('type:currency:cents');

/** `fn double(x) { return x + x; }` — small but has every interesting feature. */
function fixture(seed = 'fixture') {
  const syms = new SymbolSpace(seed);
  const double = syms.define('double');
  const x = syms.define('x');
  const decl = b.fn({
    symbol: double,
    params: [b.param(x, b.Int)],
    returns: b.Int,
    contract: b.contract({
      requires: [b.clause(b.ge(b.v(x), b.int(0)), 'non_negative')],
      ensures: [b.clause(b.eq(b.result(), b.mul(b.old(b.v(x)), b.int(2))), 'doubles')],
    }),
    body: b.block(b.ret(b.add(b.v(x), b.v(x)))),
  });
  const mod = b.module_({ symbol: syms.define('m'), members: [decl], symbolTable: syms.table() });
  return { syms, double, x, decl, mod };
}

test('canonical encoding is order-independent and unambiguous', () => {
  assert.equal(canonicalText({ b: 1, a: 2 }), canonicalText({ a: 2, b: 1 }));
  // An absent optional field and an explicit `undefined` must agree...
  assert.equal(canonicalText({ a: 1 }), canonicalText({ a: 1, b: undefined }));
  // ...but `null` is a real value and must not collide with absence.
  assert.notEqual(canonicalText({ a: 1 }), canonicalText({ a: 1, b: null }));
  // Type tags keep these apart where naive concatenation would not.
  assert.notEqual(canonicalText('1'), canonicalText(1));
  assert.notEqual(canonicalText(['a', 'b']), canonicalText(['ab']));
  assert.notEqual(canonicalText({ ab: 1 }), canonicalText({ a: 'b1' }));
});

test('hashing is deterministic and content-derived', () => {
  const a = new GraphStore();
  const c = new GraphStore();
  const f1 = fixture();
  const f2 = fixture();
  assert.equal(a.intern(f1.mod), c.intern(f2.mod), 'identical trees hash identically');

  const store = new GraphStore();
  const ref = store.intern(f1.decl);
  assert.equal(hashNode(store.get(ref)), ref, 'stored node re-hashes to its address');
});

test('grouped child hashing keeps ambiguous shapes distinct', () => {
  // Same three children, different fields: a flat child list would collide.
  const store = new GraphStore();
  const c = b.bool(true);
  const inv = b.bool(false);
  const body = b.block();
  const withInvariant = b.while_(c, body, { invariants: [inv], variant: null });
  const withVariant = b.while_(c, body, { invariants: [], variant: inv });
  assert.notEqual(store.intern(withInvariant), store.intern(withVariant));

  const ifNoElse = b.if_(c, body);
  const ifElse = b.if_(c, body, body);
  assert.notEqual(store.intern(ifNoElse), store.intern(ifElse));
});

test('FR-1.1: renaming a symbol invalidates no expression hash', () => {
  const { syms, x, decl, mod } = fixture();
  const store = new GraphStore();
  const beforeDecl = store.intern(decl);
  const beforeMod = store.intern(b.module_({
    symbol: syms.lookup('m')!, members: [decl], symbolTable: syms.table(),
  }));
  const beforeTable = store.intern(syms.table());

  syms.rename(x, 'amount_in_cents');

  const afterDecl = store.intern(decl);
  const afterTable = store.intern(syms.table());
  const afterMod = store.intern(b.module_({
    symbol: syms.lookup('m')!, members: [decl], symbolTable: syms.table(),
  }));

  assert.equal(afterDecl, beforeDecl, 'the function subtree keeps its address');
  assert.notEqual(afterTable, beforeTable, 'the symbol table is the one node that changed');
  assert.notEqual(afterMod, beforeMod, 'the module root re-points at the new table');
  assert.equal(syms.nameOf(x), 'amount_in_cents');
  void mod;
});

test('alpha-equivalent code shares a structural key but not an address', () => {
  const one = fixture('seed-one');
  const two = fixture('seed-two');
  const store = new GraphStore();
  const refA = store.intern(one.decl);
  const refB = store.intern(two.decl);

  assert.notEqual(refA, refB, 'distinct bindings are distinct nodes');
  assert.equal(store.structuralKey(refA), store.structuralKey(refB), 'same shape');
  assert.deepEqual(new Set(store.alphaEquivalents(refA)), new Set([refA, refB]));
});

test('structural sharing deduplicates repeated subtrees', () => {
  const store = new GraphStore();
  const syms = new SymbolSpace('dedup');
  const x = syms.define('x');
  // The same `x + 1` expression, written twenty times.
  const repeated = b.block(...Array.from({ length: 20 }, () => b.ret(b.add(b.v(x), b.int(1)))));
  store.intern(repeated);
  const stats = store.stats();

  assert.equal(size(repeated), 1 + 20 * 4, 'block + 20 * (ret, add, var, lit)');
  assert.ok(stats.dedupRatio > 0.4, `expected >40% dedup, got ${(stats.dedupRatio * 100).toFixed(1)}%`);
  // Only the distinct shapes survive: block, ret, add, var, lit.
  assert.equal(stats.physicalNodes, 5);
});

test('FR-1.1: mutation is a hash-tree update touching only the spine', () => {
  const store = new GraphStore();
  const syms = new SymbolSpace('spine');
  const x = syms.define('x');
  // A deliberately wide tree: 200 sibling statements, one of which we edit.
  const stmts = Array.from({ length: 200 }, (_, i) => b.ret(b.add(b.v(x), b.int(i))));
  const root = store.intern(b.block(...stmts));

  const before = store.size;
  const target = store.findPath(root, (n) => n.kind === 'Lit' && n.value === 77n);
  assert.ok(target, 'found the literal to replace');
  const replacement = store.intern(b.int(99));
  const next = store.replaceAt(root, target!, replacement);

  assert.notEqual(next, root);
  // path is block > stmts[77] > ... ; new nodes = spine length + the replacement.
  const written = store.size - before;
  assert.ok(written <= target!.length + 1, `wrote ${written} nodes for depth ${target!.length}`);
  assert.ok(written < 10, 'a 200-statement tree costs single-digit writes to edit');

  const hydrated = store.hydrate(next) as Extract<Term, { kind: 'Block' }>;
  const values = [...walk(hydrated)].filter((n) => n.kind === 'Lit').map((n) => n.value);
  assert.ok(values.includes(99n) && !values.includes(77n));
});

test('hydrate is the exact inverse of intern', () => {
  const { mod } = fixture();
  const store = new GraphStore();
  const ref = store.intern(mod);
  assert.deepEqual(store.hydrate(ref), mod);
});

test('record literal field order does not affect identity', () => {
  const store = new GraphStore();
  const ty = { t: 'Record' as const, name: CENTS, fields: [['a', b.Int], ['b', b.Int]] as const };
  const r1 = b.record(ty, { a: b.int(1), b: b.int(2) });
  const r2 = b.record(ty, { b: b.int(2), a: b.int(1) });
  assert.equal(store.intern(r1), store.intern(r2));
});

test('unknown refs fail loudly rather than returning undefined', () => {
  const store = new GraphStore();
  assert.throws(() => store.get(('ast:b3:' + '0'.repeat(64)) as NodeRef), ReferenceError);
});
