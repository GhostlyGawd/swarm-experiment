/** Pinned authored preflight corpus with exact one-literal entry edits. */
import type { Term } from '../../../../src/tier1/ast.ts';
import type { NodeRef } from '../../../../src/tier1/ids.ts';
import type { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { buildLedgerExample } from '../../../../src/examples/ledger.ts';
import { projectionCorpus } from '../projections/corpus.ts';
import { compositeProjectionCorpus } from '../projections/corpus-composites.ts';
import { stringImportProjectionCorpus } from '../projections/corpus-strings-imports.ts';
import { genericNestedCorpus } from '../projections/corpus-generics-nested.ts';
import { nestedImportCorpus } from '../projections/corpus-nested-imports.ts';
import { atomicProjectionCorpus } from '../projections/corpus-atomic.ts';

export interface ProjectionThroughputCase {
  readonly id: string; readonly workload: string; readonly variant: 'original' | 'one-literal-edit';
  readonly module: Term; readonly symbols: SymbolSpace;
  readonly modules?: ReadonlyMap<NodeRef, Term>; readonly expectedRoot: NodeRef;
}
interface Workload { readonly id: string; readonly module: Term; readonly symbols: SymbolSpace;
  readonly modules?: ReadonlyMap<NodeRef, Term> }
export function projectionThroughputCorpus(): readonly ProjectionThroughputCase[] {
  const base = projectionCorpus(), ledger = buildLedgerExample();
  const selected: Workload[] = [
    base.find(item => item.id === 'scalar-math')!,
    base.find(item => item.id === 'loop-contract')!,
    compositeProjectionCorpus()[0],
    { id: 'full-ledger', module: ledger.module, symbols: ledger.syms },
    stringImportProjectionCorpus()[0],
    genericNestedCorpus()[0],
    nestedImportCorpus()[0],
    atomicProjectionCorpus()[0],
  ];
  if (selected.some(item => !item) || new Set(selected.map(item => item.id)).size !== selected.length)
    throw new Error('projection throughput corpus selection changed');
  return selected.flatMap(item => {
    const store = new GraphStore(), root = store.intern(item.module);
    const path = store.findPath(root, node => node.kind === 'Lit' && typeof node.value === 'bigint');
    if (!path) throw new Error(`projection throughput edit literal missing: ${item.id}`);
    const selectedRef = store.resolvePath(root, path).at(-1)!;
    const prior = store.get(selectedRef);
    if (prior.kind !== 'Lit' || typeof prior.value !== 'bigint') throw new Error('projection edit path changed');
    const changed = store.hydrate(store.replaceAt(root, path,
      store.intern({ ...prior, value: prior.value + 1n })));
    const changedRoot = store.intern(changed);
    if (changedRoot === root) throw new Error('projection edited root unchanged');
    return [
      { id: `${item.id}/original`, workload: item.id, variant: 'original' as const,
        module: item.module, symbols: item.symbols, modules: item.modules, expectedRoot: root },
      { id: `${item.id}/one-literal-edit`, workload: item.id, variant: 'one-literal-edit' as const,
        module: changed, symbols: item.symbols, modules: item.modules, expectedRoot: changedRoot },
    ];
  });
}
