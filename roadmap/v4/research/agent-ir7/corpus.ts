/** Frozen authored diagnostic corpus; IDs and seeds are registered in REGISTRATION.md. */
import { buildLedgerExample } from '../../../../src/examples/ledger.ts';
import { projectionCorpus } from '../projections/corpus.ts';
import { compositeProjectionCorpus } from '../projections/corpus-composites.ts';
import { continuationProjectionCorpus } from '../projections/corpus-continuations.ts';
import { completionProjectionCorpus } from '../projections/corpus-completion.ts';
import type { Term } from '../../../../src/tier1/ast.ts';
import type { SymbolSpace } from '../../../../src/tier1/symbols.ts';

export interface DensityFixture { id: string; seed: string; module: Term; symbols: SymbolSpace }

export function densityCorpusV7(): DensityFixture[] {
  const ledger = buildLedgerExample();
  return [
    { id: 'ledger', seed: 'ledger-example', module: ledger.module, symbols: ledger.syms },
    ...projectionCorpus().map((row, i) => ({ ...row, seed: [
      'projection-corpus-math', 'projection-corpus-loops',
      'projection-corpus-effects', 'projection-corpus-fixed',
    ][i] })),
    ...compositeProjectionCorpus().map(row => ({ ...row, seed: 'projection-composite-corpus' })),
    ...continuationProjectionCorpus().map(row => ({ ...row, seed: 'projection-continuation-corpus' })),
    ...completionProjectionCorpus().map(row => ({ ...row, seed: 'projection-kind-completion' })),
  ];
}
