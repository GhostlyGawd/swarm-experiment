import * as b from '../../../../src/tier1/build.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';

/** Representative valid scalar contexts absent from the earlier retained corpora. */
export function completionProjectionFixture() {
  const symbols = new SymbolSpace('projection-kind-completion');
  const entry = symbols.define('entry'), x = symbols.define('x');
  const tick = symbols.define('tick'), i = symbols.define('i');
  const surface = b.surface({ symbol: tick, domain: { d: 'range', min: 0n, max: 10n, step: 1n },
    current: 5n });
  const contract = b.contract({ ensures: [b.clause(b.forall(i, b.int(0), b.int(3),
    b.lt(b.v(i), b.int(3))), 'bounded-quantifier')] });
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, surfaces: [surface], contract,
      body: b.block(b.yield_(), b.ret(b.cond(b.not(b.lt(b.v(x), b.int(0))),
        b.add(b.v(x), b.v(tick)), b.neg(b.v(x))))) }),
  ] });
  return { symbols, module, entry };
}
export function completionProjectionCorpus() {
  const f = completionProjectionFixture();
  return [{ id: 'scalar-five-kind-completion', module: f.module, symbols: f.symbols }];
}
