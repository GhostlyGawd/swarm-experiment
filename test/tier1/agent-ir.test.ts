import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, IrContext } from '../../src/tier1/agent-ir.ts';
import { buildLedgerExample } from '../../src/examples/ledger.ts';
import { projectTypeScript } from '../../src/projection/typescript.ts';
import { measure } from '../../src/util/tokens.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import * as b from '../../src/tier1/build.ts';
import { typeName } from '../../src/tier1/ids.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { walk } from '../../src/tier1/ast.ts';

test('every node kind survives an Agent-IR round trip', () => {
  const syms = new SymbolSpace('ir-kinds');
  const a = syms.define('a');
  const g = syms.define('g');
  const s = syms.define('s');
  const rec = { t: 'Record' as const, name: typeName('type:x:pair'), fields: [['l', b.Int], ['r', b.Str]] as const };
  const nominal = { t: 'Nominal' as const, name: typeName('type:x:id'), repr: b.Str };
  const res = { t: 'Result' as const, ok: b.Int, err: b.Str };

  const term = b.module_({
    symbol: syms.define('m'),
    symbolTable: syms.table(),
    members: [
      b.typeDecl(typeName('type:x:pair'), rec),
      b.fn({
        symbol: g,
        params: [b.param(a, nominal)],
        returns: res,
        capabilities: ['cap:network:fetch' as never],
        purity: 'effectful',
        surfaces: [
          b.surface({ symbol: s, domain: { d: 'choice', options: ['lru', 'lfu'] }, current: 'lru', objective: 'minimize_cost' }),
          b.surface({ symbol: syms.define('n'), domain: { d: 'range', min: -8n, max: 8n, step: 2n }, current: -4n, objective: 'minimize_memory' }),
        ],
        contract: b.contract({
          requires: [b.clause(b.not(b.eq(b.v(a), b.typed(nominal, ''))), 'nonempty')],
          ensures: [b.clause(b.ge(b.result(), b.old(b.int(0))), 'ok', 'property')],
          modifies: [b.place(a, 'left', 'right')],
        }),
        body: b.block(
          b.let_(syms.define('t'), rec, b.record(rec, { l: b.int(-17), r: b.str('hi') })),
          b.if_(b.bool(true), b.block(b.assert_(b.bool(false), 'never')), b.block()),
          b.if_(b.and(b.bool(true), b.or(b.bool(false), b.not(b.bool(true)))), b.block()),
          b.while_(b.lt(b.int(0), b.int(1)), b.block(b.exprStmt(b.invoke('cap:network:fetch' as never, b.str('u')))), {
            invariants: [b.ge(b.int(0), b.int(0))],
            variant: b.neg(b.int(1)),
          }),
          b.exprStmt(b.cond(b.bool(true), b.concat(b.str('a'), b.str('b')), b.str('c'))),
          b.exprStmt(b.call(g, b.v(a))),
          b.assign(b.place(a, 'left'), b.v(a)),
          b.exprStmt(b.field(b.v(a), 'balance')),
          b.exprStmt(b.mod(b.div(b.mul(b.sub(b.add(b.int(1), b.int(2)), b.int(3)), b.int(4)), b.int(5)), b.int(6))),
          b.exprStmt(b.ne(b.gt(b.int(1), b.int(2)) as Term, b.le(b.int(3), b.int(4)) as Term)),
          b.ret(b.typed(res, null)),
        ),
      }),
    ],
  });

  const ir = encode(term);
  assert.deepEqual(decode(ir.text), term);

  // The fixture is meant to be exhaustive; fail loudly if a kind is missing.
  const covered = new Set([...walk(term)].map((n) => n.kind));
  for (const kind of ['Lit','Var','Bin','Un','Cond','Call','Field','RecordLit','Old','ResultRef',
    'Invoke','Place','Let','Assign','If','While','Return','Assert','ExprStmt','Block','Clause',
    'Contract','FunctionDecl','TypeDecl','Surface','SymbolTable','Module']) {
    assert.ok(covered.has(kind as never), `round-trip fixture does not cover ${kind}`);
  }
});

test('the worked example round-trips exactly', () => {
  const ex = buildLedgerExample();
  assert.deepEqual(decode(encode(ex.module).text), ex.module);
});

test('a session dictionary makes later edits nearly free', () => {
  const ex = buildLedgerExample();
  const enc = new IrContext();
  const dec = new IrContext();

  const cold = encode(ex.module, enc);
  assert.deepEqual(decode(cold.text, dec), ex.module);

  const members = (ex.module as Extract<Term, { kind: 'Module' }>).members;
  const warm = encode(members[2], enc);
  assert.deepEqual(decode(warm.text, dec), members[2]);

  assert.ok(warm.tokens < cold.tokens / 4, 'a warm subtree costs a fraction of the cold module');
  assert.ok(
    measure(warm.header).tokens <= 6,
    `a warm header should be near-empty, was ${warm.header}`,
  );
});

test('FR-1.2: Agent-IR cuts the tokens per unit change by at least 4x', () => {
  const ex = buildLedgerExample();
  const members = (ex.module as Extract<Term, { kind: 'Module' }>).members;
  const ctx = new IrContext();
  encode(ex.module, ctx); // establish the session dictionary

  let tsTotal = 0;
  let irTotal = 0;
  const perFunction: string[] = [];
  for (const member of members) {
    if (member.kind !== 'FunctionDecl') continue;
    const ts = measure(projectTypeScript(member, ex.syms, {})).tokens;
    const ir = encode(member, ctx);
    tsTotal += ts;
    irTotal += ir.bodyTokens;
    perFunction.push(`${ex.syms.nameOf(member.symbol)}=${(ts / ir.bodyTokens).toFixed(2)}x`);
  }

  // The requirement is a property of the representation, so it is asserted
  // over the corpus rather than per declaration. Individual functions vary:
  // a three-line body carrying a five-clause contract does worse than the
  // aggregate, because the contract is irreducible content in both forms.
  const aggregate = tsTotal / irTotal;
  assert.ok(aggregate >= 4, `expected >=4x aggregate, got ${aggregate.toFixed(2)}x (${perFunction.join(' ')})`);
  // No declaration should be anywhere near parity, either.
  assert.ok(
    Math.min(...perFunction.map((p) => Number(p.split('=')[1].replace('x', '')))) >= 3.5,
    `per-declaration floor regressed: ${perFunction.join(' ')}`,
  );
});

test('a malformed stream is rejected rather than silently truncated', () => {
  assert.throws(() => decode('nope\nB0'), SyntaxError);
  assert.throws(() => decode('AE1\n§w 1\n+'), SyntaxError); // stack underflow
  assert.throws(() => decode('AE1\n§w 1\ni1 i2'), SyntaxError); // two roots
  assert.throws(() => decode('AE1\n§w 1\n§q a\ni1'), SyntaxError); // unknown section
  assert.throws(() => decode('AE1\n§w 1\nv0'), RangeError); // dangling dictionary index
});
