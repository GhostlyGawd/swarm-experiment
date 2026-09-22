import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../../src/tier3/runtime.ts';
import { RevocationList } from '../../src/tier2/ocap.ts';
import {
  ACCOUNT, CAP_LEDGER_APPEND, CENTS, buildLedgerExample,
} from '../../src/examples/ledger.ts';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import type { Value } from '../../src/tier3/values.ts';
import type { Term } from '../../src/tier1/ast.ts';

function setup(opts: Partial<Parameters<typeof Runtime.prototype.constructor>[0]> = {}) {
  const ex = buildLedgerExample();
  const rt = new Runtime({ registry: ex.capabilities, symbols: ex.syms, trace: true, ...opts });
  rt.load(ex.module);
  const acct = (id: string, balance: bigint) =>
    rt.allocateRecord(ACCOUNT, { id, balance });
  return { ex, rt, acct };
}

const sym = (ex: ReturnType<typeof buildLedgerExample>, name: string) => ex.symbols[name];

test('the worked example executes and satisfies its contract', () => {
  const { ex, rt, acct } = setup();
  const alice = acct('alice', 1000n);
  const bob = acct('bob', 250n);

  const result = rt.call(sym(ex, 'transfer'), [alice, bob, 400n]);
  assert.equal(result.ok, true);
  assert.equal(rt.readRecord(alice).get('balance'), 600n);
  assert.equal(rt.readRecord(bob).get('balance'), 650n);
});

test('a violated precondition is a structured fault, not an exception to parse', () => {
  const { ex, rt, acct } = setup();
  const alice = acct('alice', 10n);
  const bob = acct('bob', 0n);

  const result = rt.call(sym(ex, 'transfer'), [alice, bob, 400n]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.fault.kind, 'precondition');
  assert.equal(result.fault.label, 'sufficient_funds');
  // The fault carries the bindings the repair agent needs.
  assert.equal(result.fault.bindings.amount, '400');
  assert.match(result.fault.bindings.sender, /balance: 10/);
  // Nothing was written: the guard fired before the body ran.
  assert.equal(rt.readRecord(alice).get('balance'), 10n);
});

test('the aliasing case the verifier assumed away is reachable here', () => {
  const { ex, rt, acct } = setup();
  const alice = acct('alice', 1000n);
  // transfer(alice, alice, n) violates the distinct_accounts precondition.
  const result = rt.call(sym(ex, 'transfer'), [alice, alice, 100n]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.label, 'distinct_accounts');
});

test('FR-3.1: execution rewinds to an exact prior state', () => {
  const { ex, rt, acct } = setup();
  const alice = acct('alice', 1000n);
  const bob = acct('bob', 250n);

  const mark = rt.checkpoint('before transfer');
  rt.call(sym(ex, 'transfer'), [alice, bob, 400n]);
  assert.equal(rt.readRecord(alice).get('balance'), 600n);

  rt.restore(mark);
  assert.equal(rt.readRecord(alice).get('balance'), 1000n, 'the debit was undone');
  assert.equal(rt.readRecord(bob).get('balance'), 250n, 'the credit was undone');
  assert.equal(rt.steps, mark.step);
});

test('FR-3.1: stepping back N steps lands between two writes', () => {
  const { ex, rt, acct } = setup();
  const alice = acct('alice', 1000n);
  const bob = acct('bob', 250n);
  rt.call(sym(ex, 'transfer'), [alice, bob, 400n]);

  // Walk backwards until the credit is undone but the debit is not.
  const afterAll = rt.steps;
  for (let back = 1; back <= afterAll; back++) {
    const fresh = setup();
    const a2 = fresh.acct('alice', 1000n);
    const b2 = fresh.acct('bob', 250n);
    fresh.rt.call(sym(fresh.ex, 'transfer'), [a2, b2, 400n]);
    fresh.rt.rewind(back);
    const debited = fresh.rt.readRecord(a2).get('balance') === 600n;
    const credited = fresh.rt.readRecord(b2).get('balance') === 650n;
    if (debited && !credited) {
      assert.ok(true, `found the intermediate state ${back} steps back`);
      return;
    }
  }
  assert.fail('no intermediate state between the debit and the credit');
});

test('NFR 6.1: a checkpoint rollback completes well inside 15ms', () => {
  const { ex, rt, acct } = setup({ trace: false });
  const accounts = Array.from({ length: 200 }, (_, i) => acct(`a${i}`, 10_000n));
  const mark = rt.checkpoint('start');
  for (let i = 0; i + 1 < accounts.length; i += 2) {
    rt.call(sym(ex, 'transfer'), [accounts[i], accounts[i + 1], 5n]);
  }
  const started = process.hrtime.bigint();
  rt.restore(mark);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 15, `rollback took ${elapsedMs.toFixed(2)}ms`);
  assert.equal(rt.readRecord(accounts[0]).get('balance'), 10_000n);
});

test('FR-3.1: micro-forks explore candidate repairs independently', () => {
  const { ex, rt, acct } = setup({ trace: false });
  const alice = acct('alice', 1000n);
  const bob = acct('bob', 250n);

  // 50 candidate amounts, each against the exact same heap.
  const outcomes = Array.from({ length: 50 }, (_, i) => {
    const child = rt.fork();
    child.load(ex.module);
    const result = child.call(sym(ex, 'transfer'), [alice, bob, BigInt(i) * 40n]);
    return {
      amount: BigInt(i) * 40n,
      ok: result.ok,
      senderBalance: child.readRecord(alice).get('balance'),
    };
  });

  assert.equal(outcomes.filter((o) => o.ok).length, 25, 'amounts in (0, 1000] succeed');
  assert.equal(outcomes[0].ok, false, 'a zero transfer violates positive_amount');
  assert.equal(outcomes[26].ok, false, 'an over-balance transfer violates sufficient_funds');
  // The parent heap is untouched by any of the 50 forks.
  assert.equal(rt.readRecord(alice).get('balance'), 1000n);
});

test('agents read structured state, never a byte stream', () => {
  const { ex, rt, acct } = setup();
  const alice = acct('alice', 1000n);
  const bob = acct('bob', 250n);
  rt.call(sym(ex, 'transfer'), [alice, bob, 400n]);

  const state = rt.inspect();
  assert.equal(state.heap['@1'].balance, '600');
  assert.equal(state.heap['@2'].balance, '650');
  assert.ok(state.step > 0);

  // The effect went through the capability, and is recorded as data.
  assert.equal(rt.effects.length, 1);
  assert.equal(rt.effects[0].capability, CAP_LEDGER_APPEND);
  assert.deepEqual(rt.effects[0].args, ['alice', 'bob', 400n]);
  assert.ok(rt.trace.some((e) => e.kind === 'assign'));
});

test('a capability the function does not hold is denied at runtime too', () => {
  const registry = new CapabilityRegistry();
  registry.declare('cap:network:fetch', { arity: 1, description: 'fetch' });
  const syms = new SymbolSpace('deny');
  const f = syms.define('sneaky');
  // The checker would reject this; the runtime is the second line of defence.
  const decl = b.fn({
    symbol: f,
    returns: b.Unit,
    purity: 'effectful',
    capabilities: [],
    body: b.block(b.exprStmt(b.invoke('cap:network:fetch' as never, b.str('x'))), b.ret(b.unit())),
  });
  const rt = new Runtime({ registry, symbols: syms }).load(decl);
  const result = rt.call(f, []);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.kind, 'capability_denied');
});

test('§5: an operator can revoke a capability without redeploying', () => {
  const ex = buildLedgerExample();
  const revocations = new RevocationList(() => 0);
  const rt = new Runtime({ registry: ex.capabilities, symbols: ex.syms, revocations });
  rt.load(ex.module);
  const alice = rt.allocateRecord(ACCOUNT, { id: 'alice', balance: 1000n });
  const bob = rt.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });

  assert.equal(rt.call(ex.symbols.transfer, [alice, bob, 10n]).ok, true);

  revocations.revoke(CAP_LEDGER_APPEND, { by: 'sre@aether' });
  const after = rt.call(ex.symbols.transfer, [alice, bob, 10n]);
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.fault.kind, 'capability_revoked');
  assert.equal(revocations.history[0].by, 'sre@aether');

  revocations.restore(CAP_LEDGER_APPEND);
  assert.equal(rt.call(ex.symbols.transfer, [alice, bob, 10n]).ok, true);
});

test('runtime arithmetic agrees with the verifier on truncating division', () => {
  const syms = new SymbolSpace('div');
  const a = syms.define('a');
  const f = syms.define('divide');
  const decl = b.fn({
    symbol: f,
    params: [b.param(a, b.Int)],
    returns: b.Int,
    body: b.block(b.ret(b.div(b.v(a), b.int(100)))),
  });
  const rt = new Runtime({ registry: new CapabilityRegistry(), symbols: syms }).load(decl);
  for (const [input, expected] of [[250n, 2n], [-250n, -2n], [99n, 0n], [-99n, 0n]] as const) {
    const r = rt.call(f, [input]);
    assert.equal(r.ok && r.value, expected, `${input} / 100`);
  }
});

test('division by zero and the step budget are faults, not hangs', () => {
  const syms = new SymbolSpace('bad');
  const f = syms.define('boom');
  const spin = syms.define('spin');
  const rt = new Runtime({ registry: new CapabilityRegistry(), symbols: syms, maxSteps: 5000 })
    .load(b.fn({ symbol: f, returns: b.Int, body: b.block(b.ret(b.div(b.int(1), b.int(0)))) }))
    .load(b.fn({
      symbol: spin,
      returns: b.Unit,
      body: b.block(b.while_(b.bool(true), b.block()), b.ret(b.unit())),
    }));

  const divided = rt.call(f, []);
  assert.equal(divided.ok, false);
  if (!divided.ok) assert.equal(divided.fault.kind, 'division_by_zero');

  const spun = rt.call(spin, []);
  assert.equal(spun.ok, false);
  if (!spun.ok) assert.equal(spun.fault.kind, 'step_budget');
});

test('a postcondition failure names the clause that broke', () => {
  const ex = buildLedgerExample();
  const transfer = (ex.module as Extract<Term, { kind: 'Module' }>).members[2] as Extract<Term, { kind: 'FunctionDecl' }>;
  const sender = transfer.params[0].symbol;
  const receiver = transfer.params[1].symbol;
  const amount = transfer.params[2].symbol;
  const broken: Term = {
    ...transfer,
    body: b.block(
      b.assign(b.place(sender, 'balance'), b.sub(b.field(b.v(sender), 'balance'), b.v(amount))),
      b.assign(b.place(receiver, 'balance'), b.field(b.v(receiver), 'balance')), // forgot the credit
      b.ret(b.unit()),
    ),
  };
  const rt = new Runtime({ registry: ex.capabilities, symbols: ex.syms });
  const alice = rt.allocateRecord(ACCOUNT, { id: 'alice', balance: 1000n });
  const bob = rt.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
  const result = rt.callDeclaration(broken, [alice, bob, 100n]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.fault.kind, 'postcondition');
    assert.equal(result.fault.label, 'credit_exact');
  }
});
