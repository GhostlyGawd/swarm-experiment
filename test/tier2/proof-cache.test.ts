import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { ProofCache } from '../../src/tier2/proof-cache.ts';
import { verifyFunction } from '../../src/tier2/verify.ts';

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
