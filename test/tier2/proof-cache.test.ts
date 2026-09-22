import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { ProofCache } from '../../src/tier2/proof-cache.ts';
import { verifyFunction } from '../../src/tier2/verify.ts';
import { verifyIncremental } from '../../src/tier2/incremental.ts';

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test('C5: proofs are reused by exact declaration address across processes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-proof-cache-'));
  directories.push(directory);
  const syms = new SymbolSpace('proof-cache');
  const x = syms.define('x');
  const declaration = b.fn({
    symbol: syms.define('identity'),
    params: [b.param(x, b.Int)],
    returns: b.Int,
    contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.v(x)), 'identity')] }),
    body: b.block(b.ret(b.v(x))),
  });
  const firstCache = new ProofCache(directory);
  const first = verifyFunction(declaration, { symbols: syms, proofCache: firstCache });
  assert.equal(first.verdict, 'proved');
  const secondCache = new ProofCache(directory);
  const second = verifyFunction(declaration, { symbols: syms, proofCache: secondCache, budgetMs: 0 });
  assert.deepEqual(second, first);
  assert.equal(secondCache.stats.hits, 1);
});

test('C6: incremental verification rechecks changed functions and transitive callers only', () => {
  const syms = new SymbolSpace('incremental-verification');
  const leafSymbol = syms.define('leaf');
  const callerSymbol = syms.define('caller');
  const unrelatedSymbol = syms.define('unrelated');
  const makeLeaf = (value: number) => b.fn({
    symbol: leafSymbol, returns: b.Int,
    contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(value)), 'value')] }),
    body: b.block(b.ret(b.int(value))),
  });
  const caller = b.fn({
    symbol: callerSymbol, returns: b.Int, body: b.block(b.ret(b.call(leafSymbol))),
  });
  const unrelated = b.fn({
    symbol: unrelatedSymbol, returns: b.Int, body: b.block(b.ret(b.int(7))),
  });
  const makeModule = (leaf: ReturnType<typeof makeLeaf>) => b.module_({
    symbol: syms.define('module'),
    members: [leaf, caller, unrelated], symbolTable: syms.table(),
  });
  const before = makeModule(makeLeaf(1));
  const cache = new ProofCache();
  const seeded = verifyIncremental(before, before, { symbols: syms, proofCache: cache });
  assert.equal(seeded.verified.length, 3);
  const after = makeModule(makeLeaf(2));
  const result = verifyIncremental(before, after, { symbols: syms, proofCache: cache });
  assert.deepEqual(new Set(result.verified), new Set([leafSymbol, callerSymbol]));
  assert.deepEqual(result.reused, [unrelatedSymbol]);
});
