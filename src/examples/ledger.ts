/**
 * The worked example used throughout the tests, the benchmarks and the demo:
 * the `TransferFunds` contract from the PRD, plus enough surrounding code to
 * exercise every tier — a nominal money type, a capability-gated effect, a
 * loop with an invariant, and a tunable surface.
 */

import * as b from '../tier1/build.ts';
import { SymbolSpace } from '../tier1/symbols.ts';
import { ProvenanceLedger } from '../tier1/provenance.ts';
import { capability, typeName, type InvariantId, type SymbolId } from '../tier1/ids.ts';
import type { Term, Ty } from '../tier1/ast.ts';

export const CENTS: Ty = {
  t: 'Nominal',
  name: typeName('type:currency:cents'),
  repr: { t: 'Int' },
};

export const ACCOUNT: Ty = {
  t: 'Record',
  name: typeName('type:ledger:account'),
  fields: [
    ['id', { t: 'Str' }],
    ['balance', CENTS],
  ],
};

export const CAP_LEDGER_APPEND = capability('cap:db:ledger_append');
export const CAP_NETWORK_FETCH = capability('cap:network:fetch');

export const INV_CONSERVATION = 'inv:b3:' + 'c0'.repeat(32) as InvariantId;
export const INV_NON_NEGATIVE = 'inv:b3:' + 'a1'.repeat(32) as InvariantId;

export interface LedgerExample {
  readonly syms: SymbolSpace;
  readonly ledger: ProvenanceLedger;
  readonly module: Term;
  readonly transfer: Term;
  readonly symbols: Readonly<Record<string, SymbolId>>;
}

/** Build the example. Deterministic: same seed, same symbol ids, same hashes. */
export function buildLedgerExample(seed = 'ledger-example'): LedgerExample {
  const syms = new SymbolSpace(seed);
  let tick = 1_700_000_000_000;
  const ledger = new ProvenanceLedger(() => tick++);

  const specProv = ledger.record({
    intent: 'Money must never be created or destroyed by a transfer.',
    origin: { kind: 'spec_clause', ref: 'LEDGER-7', actor: 'product@aether' },
    specClauses: [INV_CONSERVATION],
    guard: {
      invariant: INV_CONSERVATION,
      priority: 'architectural',
      rationale:
        'Double-entry conservation. Removing the balance checks silently converts ' +
        'an overdraft bug into an audited accounting discrepancy.',
    },
  });

  const transferProv = ledger.record({
    intent: 'Move funds between two accounts, atomically.',
    origin: { kind: 'agent_session', ref: 'sess-4417', actor: 'synthesis-agent' },
    parents: [specProv],
    specClauses: [INV_CONSERVATION, INV_NON_NEGATIVE],
    reasoning: [
      'Guarded the debit with an explicit balance precondition rather than a runtime throw, ' +
        'so the solver can discharge it statically.',
      'Appended to the ledger through cap:db:ledger_append; no ambient database handle exists.',
    ],
  });

  // --- symbols -------------------------------------------------------------
  const mod = syms.define('ledger');
  const transfer = syms.define('transfer');
  const sender = syms.define('sender');
  const receiver = syms.define('receiver');
  const amount = syms.define('amount');
  const feeFor = syms.define('feeFor');
  const gross = syms.define('gross');
  const batchSize = syms.define('batchSize');
  const accrue = syms.define('accrue');
  const principal = syms.define('principal');
  const periods = syms.define('periods');
  const total = syms.define('total');
  const i = syms.define('i');

  const senderBalance = b.field(b.v(sender), 'balance');
  const receiverBalance = b.field(b.v(receiver), 'balance');

  // --- transfer ------------------------------------------------------------
  const transferDecl = b.fn({
    symbol: transfer,
    params: [b.param(sender, ACCOUNT), b.param(receiver, ACCOUNT), b.param(amount, CENTS)],
    returns: b.Unit,
    capabilities: [CAP_LEDGER_APPEND],
    purity: 'effectful',
    provenance: transferProv,
    contract: b.contract({
      requires: [
        b.clause(b.ge(senderBalance, b.v(amount)), 'sufficient_funds'),
        b.clause(b.gt(b.v(amount), b.typed(CENTS, 0n)), 'positive_amount'),
      ],
      ensures: [
        b.clause(b.eq(senderBalance, b.sub(b.old(senderBalance), b.v(amount))), 'debit_exact'),
        b.clause(b.eq(receiverBalance, b.add(b.old(receiverBalance), b.v(amount))), 'credit_exact'),
        b.clause(
          b.eq(
            b.add(senderBalance, receiverBalance),
            b.add(b.old(senderBalance), b.old(receiverBalance)),
          ),
          'conservation',
        ),
      ],
      modifies: [b.place(sender, 'balance'), b.place(receiver, 'balance')],
    }),
    body: b.block(
      b.assign(b.place(sender, 'balance'), b.sub(senderBalance, b.v(amount))),
      b.assign(b.place(receiver, 'balance'), b.add(receiverBalance, b.v(amount))),
      b.exprStmt(
        b.invoke(CAP_LEDGER_APPEND, b.field(b.v(sender), 'id'), b.field(b.v(receiver), 'id'), b.v(amount)),
      ),
      b.ret(b.unit()),
    ),
  });

  // --- feeFor: a pure function carrying a tunable surface ------------------
  const feeDecl = b.fn({
    symbol: feeFor,
    params: [b.param(gross, CENTS)],
    returns: CENTS,
    purity: 'pure',
    contract: b.contract({
      requires: [b.clause(b.ge(b.v(gross), b.typed(CENTS, 0n)), 'non_negative_gross')],
      ensures: [
        b.clause(b.ge(b.result(), b.typed(CENTS, 0n)), 'non_negative_fee'),
        b.clause(b.le(b.result(), b.v(gross)), 'fee_within_gross'),
      ],
    }),
    surfaces: [
      b.surface({
        symbol: batchSize,
        domain: { d: 'range', min: 1n, max: 64n, step: 1n },
        current: 8n,
        objective: 'minimize_latency',
      }),
    ],
    body: b.block(b.ret(b.div(b.v(gross), b.int(100)))),
  });

  // --- accrue: a loop with an invariant and a variant ----------------------
  const accrueDecl = b.fn({
    symbol: accrue,
    params: [b.param(principal, CENTS), b.param(periods, b.Int)],
    returns: CENTS,
    purity: 'pure',
    contract: b.contract({
      requires: [
        b.clause(b.ge(b.v(principal), b.typed(CENTS, 0n)), 'non_negative_principal'),
        b.clause(b.ge(b.v(periods), b.int(0)), 'non_negative_periods'),
      ],
      ensures: [b.clause(b.ge(b.result(), b.v(principal)), 'never_shrinks', 'property')],
    }),
    body: b.block(
      b.let_(total, CENTS, b.v(principal)),
      b.let_(i, b.Int, b.int(0)),
      b.while_(
        b.lt(b.v(i), b.v(periods)),
        b.block(
          b.assign(b.place(total), b.add(b.v(total), b.div(b.v(total), b.int(100)))),
          b.assign(b.place(i), b.add(b.v(i), b.int(1))),
        ),
        {
          invariants: [b.ge(b.v(total), b.v(principal)), b.ge(b.v(i), b.int(0))],
          variant: b.sub(b.v(periods), b.v(i)),
        },
      ),
      b.ret(b.v(total)),
    ),
  });

  const members = [
    b.typeDecl(typeName('type:currency:cents'), CENTS, specProv),
    b.typeDecl(typeName('type:ledger:account'), ACCOUNT, specProv),
    transferDecl,
    feeDecl,
    accrueDecl,
  ];

  const moduleTerm = b.module_({
    symbol: mod,
    members,
    symbolTable: syms.table(),
    provenance: specProv,
  });

  return {
    syms,
    ledger,
    module: moduleTerm,
    transfer: transferDecl,
    symbols: {
      module: mod, transfer, sender, receiver, amount,
      feeFor, gross, batchSize, accrue, principal, periods, total, i,
    },
  };
}
