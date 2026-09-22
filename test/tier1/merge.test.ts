import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphStore } from '../../src/tier1/store.ts';
import { merge3 } from '../../src/tier1/merge.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';

function scenario() {
  const store = new GraphStore();
  const syms = new SymbolSpace('merge');
  const x = syms.define('x');
  const y = syms.define('y');
  const stmt = (n: number): Term => b.let_(syms.define(`t${n}`), b.Int, b.int(n));
  const base = b.block(stmt(0), stmt(1), stmt(2), stmt(3));
  return { store, syms, x, y, base, stmt };
}

test('independent edits on disjoint statements merge cleanly', () => {
  const { store, base } = scenario();
  const baseRef = store.intern(base);
  const baseBlock = base as Extract<Term, { kind: 'Block' }>;

  // Left rewrites statement 0; right rewrites statement 3.
  const left = b.block(b.ret(b.int(100)), ...baseBlock.stmts.slice(1));
  const right = b.block(...baseBlock.stmts.slice(0, 3), b.ret(b.int(300)));

  const res = merge3(store, baseRef, store.intern(left), store.intern(right));
  assert.ok(res.clean, `expected clean merge, got ${JSON.stringify(res.conflicts)}`);

  const merged = store.hydrate(res.ref) as Extract<Term, { kind: 'Block' }>;
  assert.equal(merged.stmts.length, 4);
  assert.deepEqual(merged.stmts[0], b.ret(b.int(100)));
  assert.deepEqual(merged.stmts[3], b.ret(b.int(300)));
  assert.deepEqual(merged.stmts.slice(1, 3), baseBlock.stmts.slice(1, 3));
});

test('insertions from both agents both survive', () => {
  const { store, base, stmt } = scenario();
  const baseRef = store.intern(base);
  const baseBlock = base as Extract<Term, { kind: 'Block' }>;
  const inserted = stmt(99);
  const appended = stmt(77);

  const left = b.block(inserted, ...baseBlock.stmts);
  const right = b.block(...baseBlock.stmts, appended);

  const res = merge3(store, baseRef, store.intern(left), store.intern(right));
  assert.ok(res.clean, JSON.stringify(res.conflicts));
  const merged = store.hydrate(res.ref) as Extract<Term, { kind: 'Block' }>;
  assert.equal(merged.stmts.length, 6);
  assert.deepEqual(merged.stmts[0], inserted);
  assert.deepEqual(merged.stmts[5], appended);
});

test('identical edits by two agents converge instead of conflicting', () => {
  const { store, base } = scenario();
  const baseRef = store.intern(base);
  const baseBlock = base as Extract<Term, { kind: 'Block' }>;
  const same = b.block(b.ret(b.int(5)), ...baseBlock.stmts.slice(1));
  const res = merge3(store, baseRef, store.intern(same), store.intern(same));
  assert.ok(res.clean);
  assert.deepEqual(store.hydrate(res.ref), same);
});

test('genuinely divergent edits to one expression are reported as a node conflict', () => {
  const store = new GraphStore();
  const syms = new SymbolSpace('conflict');
  const x = syms.define('x');
  const base = b.ret(b.add(b.v(x), b.int(1)));
  const left = b.ret(b.add(b.v(x), b.int(2)));
  const right = b.ret(b.add(b.v(x), b.int(3)));

  const res = merge3(store, store.intern(base), store.intern(left), store.intern(right));
  assert.equal(res.clean, false);
  assert.equal(res.conflicts.length, 1);
  const c = res.conflicts[0];
  assert.equal(c.reason, 'payload_mismatch');
  // The conflict names a node and a path, not a line range.
  assert.deepEqual(c.path.map((s) => s.field), ['value', 'right']);
  assert.ok(c.left && c.right && c.base, 'all three candidate addresses are retained');
});

test('an untouched subtree of any size costs one pointer comparison', () => {
  const store = new GraphStore();
  const syms = new SymbolSpace('wide');
  const huge = b.block(...Array.from({ length: 500 }, (_, i) =>
    b.let_(syms.define(`v${i}`), b.Int, b.int(i))));
  const container = b.block(huge, b.ret(b.int(0)));
  const baseRef = store.intern(container);

  // Only the trailing return differs; the 500-statement block is untouched.
  const left = store.intern(b.block(huge, b.ret(b.int(1))));
  const res = merge3(store, baseRef, left, baseRef);
  assert.ok(res.clean);
  assert.equal(res.ref, left);
});

test('a reformat-only change is invisible to the merge', () => {
  // Two agents "reformat" by rebuilding an identical tree; text merge would
  // see a whole-file rewrite, the graph sees the same addresses.
  const { store, base } = scenario();
  const baseRef = store.intern(base);
  const rebuilt = store.intern(structuredClone(base) as Term);
  assert.equal(rebuilt, baseRef);
  const res = merge3(store, baseRef, rebuilt, baseRef);
  assert.ok(res.clean);
  assert.equal(res.ref, baseRef);
});
