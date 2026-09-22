import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typecheck } from '../../src/tier2/typecheck.ts';
import { CapabilityRegistry, CapabilityEnvelope, PURE_COMPUTE } from '../../src/tier2/ocap.ts';
import { buildLedgerExample, ACCOUNT, CENTS, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';

const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);

test('the worked example type-checks clean', () => {
  const ex = buildLedgerExample();
  const result = typecheck(ex.module, { registry: ex.capabilities, symbols: ex.syms });
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics, null, 2));
  assert.ok(result.ok);
  assert.deepEqual(result.usedCapabilities, [CAP_LEDGER_APPEND]);
});

test('FR-2.3: an ungranted capability is a compile error, not a runtime check', () => {
  const ex = buildLedgerExample();
  const syms = new SymbolSpace('ocap');
  const f = syms.define('exfiltrate');
  const decl = b.fn({
    symbol: f,
    returns: b.Unit,
    purity: 'effectful',
    capabilities: [], // declares nothing
    body: b.block(b.exprStmt(b.invoke('cap:network:fetch' as never, b.str('https://x')))),
  });
  const result = typecheck(decl, { registry: ex.capabilities, symbols: syms });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['capability_not_granted']);
  assert.match(result.diagnostics[0].hint!, /not ambient/);
});

test('FR-2.3: authority cannot be escalated across a call', () => {
  const ex = buildLedgerExample();
  const syms = new SymbolSpace('escalate');
  const privileged = syms.define('writeLedger');
  const innocent = syms.define('looksHarmless');
  const mod = b.module_({
    symbol: syms.define('m'),
    symbolTable: syms.table(),
    members: [
      b.fn({
        symbol: privileged,
        returns: b.Unit,
        purity: 'effectful',
        capabilities: [CAP_LEDGER_APPEND],
        body: b.block(b.exprStmt(b.invoke(CAP_LEDGER_APPEND, b.str('a'), b.str('b'), b.int(1)))),
      }),
      b.fn({
        symbol: innocent,
        returns: b.Unit,
        purity: 'pure',
        body: b.block(b.exprStmt(b.call(privileged))),
      }),
    ],
  });
  const result = typecheck(mod, { registry: ex.capabilities, symbols: syms });
  assert.ok(codes(result).includes('capability_escalation'));
  assert.match(result.diagnostics.find((d) => d.code === 'capability_escalation')!.message,
    /requires cap:db:ledger_append, which the caller does not hold/);
});

test('FR-2.3: a pure function may not hold capabilities at all', () => {
  const ex = buildLedgerExample();
  const syms = new SymbolSpace('purity');
  const result = typecheck(
    b.fn({
      symbol: syms.define('f'),
      returns: b.Unit,
      purity: 'pure',
      capabilities: [CAP_LEDGER_APPEND],
      body: b.block(),
    }),
    { registry: ex.capabilities, symbols: syms },
  );
  assert.ok(codes(result).includes('purity_violation'));
});

test('a sandboxed envelope grants nothing but pure computation', () => {
  const sandbox = CapabilityEnvelope.sandboxed();
  assert.ok(sandbox.has(PURE_COMPUTE));
  assert.equal(sandbox.has(CAP_LEDGER_APPEND), false);
  // Attenuation can only narrow: asking for more yields less, never more.
  assert.deepEqual(sandbox.attenuate([CAP_LEDGER_APPEND]).list, []);
});

test('nominal money types do not silently mix with bare integers', () => {
  const ex = buildLedgerExample();
  const syms = new SymbolSpace('money');
  const amount = syms.define('amount');
  const bad = b.fn({
    symbol: syms.define('f'),
    params: [b.param(amount, CENTS)],
    returns: CENTS,
    body: b.block(b.ret(b.add(b.v(amount), b.int(1)))), // Cents + Int
  });
  const result = typecheck(bad, { registry: ex.capabilities, symbols: syms });
  assert.deepEqual(codes(result), ['type_mismatch']);
  assert.match(result.diagnostics[0].hint!, /distinct money type/);
});

test('scaling a dimensioned value by a scalar is allowed; squaring it is not', () => {
  const ex = buildLedgerExample();
  const syms = new SymbolSpace('scale');
  const amount = syms.define('amount');
  const ok = b.fn({
    symbol: syms.define('half'),
    params: [b.param(amount, CENTS)],
    returns: CENTS,
    body: b.block(b.ret(b.div(b.v(amount), b.int(2)))),
  });
  assert.deepEqual(typecheck(ok, { registry: ex.capabilities, symbols: syms }).diagnostics, []);

  const ratio = b.fn({
    symbol: syms.define('ratio'),
    params: [b.param(amount, CENTS)],
    returns: b.Int,
    body: b.block(b.ret(b.div(b.v(amount), b.v(amount)))),
  });
  assert.deepEqual(typecheck(ratio, { registry: ex.capabilities, symbols: syms }).diagnostics, []);

  const squared = b.fn({
    symbol: syms.define('sq'),
    params: [b.param(amount, CENTS)],
    returns: CENTS,
    body: b.block(b.ret(b.mul(b.v(amount), b.v(amount)))),
  });
  assert.ok(codes(typecheck(squared, { registry: ex.capabilities, symbols: syms })).includes('type_mismatch'));
});

test('old() and result are rejected outside an ensures clause', () => {
  const ex = buildLedgerExample();
  const syms = new SymbolSpace('ctx');
  const x = syms.define('x');
  const decl = b.fn({
    symbol: syms.define('f'),
    params: [b.param(x, b.Int)],
    returns: b.Int,
    contract: b.contract({ requires: [b.clause(b.ge(b.old(b.v(x)), b.int(0)), 'bad')] }),
    body: b.block(b.ret(b.v(x))),
  });
  const result = typecheck(decl, { registry: ex.capabilities, symbols: syms });
  assert.deepEqual(codes(result), ['contract_only_expression']);
});

test('unknown fields and missing returns are caught with a usable path', () => {
  const ex = buildLedgerExample();
  const syms = new SymbolSpace('paths');
  const acct = syms.define('acct');
  const decl = b.fn({
    symbol: syms.define('f'),
    params: [b.param(acct, ACCOUNT)],
    returns: b.Int,
    body: b.block(b.exprStmt(b.field(b.v(acct), 'blance'))),
  }) as Extract<Term, { kind: 'FunctionDecl' }>;
  const result = typecheck(decl, { registry: ex.capabilities, symbols: syms });
  assert.deepEqual(codes(result).sort(), ['missing_return', 'unknown_field']);
  const field = result.diagnostics.find((d) => d.code === 'unknown_field')!;
  assert.deepEqual(field.path, ['body', 'stmts[0]', 'expr']);
  assert.match(field.hint!, /id, balance/);
});
