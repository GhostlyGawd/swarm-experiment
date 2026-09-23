/** Fixed authored scalar workloads, not a production density qualification. */
import * as b from '../../../../src/tier1/build.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import type { Term } from '../../../../src/tier1/ast.ts';
export function projectionCorpus(): { id: string; module: Term; symbols: SymbolSpace }[] {
  const math = new SymbolSpace('projection-corpus-math');
  const x = math.define('amount'), y = math.define('divisor');
  const mathMembers = [
    b.fn({
      symbol: math.define('truncateDivision'), params: [b.param(x, b.Int), b.param(y, b.Int)], returns: b.Int,
      contract: b.contract({ requires: [b.clause(b.ne(b.v(y), b.int(0)), 'nonzero')] }),
      body: b.block(b.ret(b.div(b.v(x), b.v(y)))),
    }),
    b.fn({ symbol: math.define('largeConstant'), returns: b.Int, body: b.ret(b.add(b.int(10n ** 80n), b.int(17))) }),
  ];
  const loops = new SymbolSpace('projection-corpus-loops');
  const n = loops.define('count'), i = loops.define('position'), total = loops.define('total');
  const loopBody = b.block(
    b.let_(i, b.Int, b.int(0)), b.let_(total, b.Int, b.int(0)),
    b.while_(b.lt(b.v(i), b.v(n)), b.block(
      b.assign(b.place(total), b.add(b.v(total), b.int(1))),
      b.assign(b.place(i), b.add(b.v(i), b.int(1))),
    ), { invariants: [b.ge(b.v(total), b.int(0))], variant: b.sub(b.v(n), b.v(i)) }),
    b.ret(b.v(total)),
  );
  const loopMembers = [b.fn({
    symbol: loops.define('countUp'), params: [b.param(n, b.Int)], returns: b.Int,
    contract: b.contract({ requires: [b.clause(b.ge(b.v(n), b.int(0)), 'positive')], ensures: [b.clause(b.eq(b.result(), b.old(b.v(n))), 'counted')] }),
    body: loopBody,
  })];
  const effects = new SymbolSpace('projection-corpus-effects'), cap = 'cap:audit:append' as never;
  const effectMembers = [b.fn({
    symbol: effects.define('recordEvent'), returns: b.Unit, purity: 'effectful', capabilities: [cap],
    body: b.block(b.if_(b.bool(true), b.exprStmt(b.invoke(cap, b.str('record the event'), b.int(1)))), b.ret(b.typed(b.Unit, null))),
  })];
  const fixed = new SymbolSpace('projection-corpus-fixed');
  const byte = { t: 'IntN' as const, bits: 8 as const, signed: false, overflow: 'wrap' as const };
  const fixedMembers = [
    b.fn({ symbol: fixed.define('wrapByte'), returns: byte, body: b.ret(b.fixed('add', byte, b.intCast(byte, b.int(250)), b.intCast(byte, b.int(10)))) }),
    b.fn({ symbol: fixed.define('lazyCondition'), returns: b.Bool, body: b.ret(b.or(b.bool(true), b.eq(b.div(b.int(1), b.int(0)), b.int(0)))) }),
  ];
  return ([['scalar-math', math, mathMembers], ['loop-contract', loops, loopMembers], ['external-effect', effects, effectMembers], ['fixed-lazy', fixed, fixedMembers]] as const).map(([id, symbols, members]) => {
    const symbol = symbols.define('module');
    return { id, symbols, module: b.module_({ symbol, symbolTable: symbols.table(), members }) };
  });
}
