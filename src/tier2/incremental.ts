import { children, type Term } from '../tier1/ast.ts';
import type { SymbolId } from '../tier1/ids.ts';
import { GraphStore } from '../tier1/store.ts';
import { ProofCache } from './proof-cache.ts';
import { verifyFunction, type VerificationReport, type VerifyOptions } from './verify.ts';

export interface IncrementalVerificationResult {
  readonly reports: ReadonlyMap<SymbolId, VerificationReport>;
  readonly verified: readonly SymbolId[];
  readonly reused: readonly SymbolId[];
  readonly removed: readonly SymbolId[];
}

const declarations = (module: Term): Map<SymbolId, Extract<Term, { kind: 'FunctionDecl' }>> => {
  const out = new Map<SymbolId, Extract<Term, { kind: 'FunctionDecl' }>>();
  const visit = (term: Term): void => {
    if (term.kind === 'FunctionDecl') out.set(term.symbol, term);
    if (term.kind === 'Module') for (const member of term.members) visit(member);
  };
  visit(module);
  return out;
};

const callees = (term: Term | null): Set<SymbolId> => {
  const out = new Set<SymbolId>();
  const visit = (node: Term): void => {
    if (node.kind === 'Call' || node.kind === 'SeqMap' || node.kind === 'SeqFold') out.add(node.callee);
    for (const child of children(node)) visit(child);
  };
  if (term) visit(term);
  return out;
};

export function verifyIncremental(
  previous: Term,
  current: Term,
  opts: Omit<VerifyOptions, 'environment' | 'proofCache'> & { readonly proofCache?: ProofCache } = {},
): IncrementalVerificationResult {
  const before = declarations(previous);
  const after = declarations(current);
  const store = new GraphStore();
  const changed = new Set<SymbolId>();
  const removed = [...before.keys()].filter((symbol) => !after.has(symbol));
  for (const [symbol, declaration] of after) {
    const old = before.get(symbol);
    if (!old || store.intern(old) !== store.intern(declaration)) changed.add(symbol);
  }
  for (const symbol of removed) changed.add(symbol);

  let grew = true;
  while (grew) {
    grew = false;
    for (const [symbol, declaration] of after) {
      if (changed.has(symbol)) continue;
      if ([...callees(declaration.body)].some((callee) => changed.has(callee))) {
        changed.add(symbol);
        grew = true;
      }
    }
  }

  const cache = opts.proofCache ?? new ProofCache();
  const environment = new Map<SymbolId, Term>(after);
  const reports = new Map<SymbolId, VerificationReport>();
  const verified: SymbolId[] = [];
  const reused: SymbolId[] = [];
  for (const [symbol, declaration] of after) {
    const subject = store.intern(declaration);
    const cached = !changed.has(symbol) ? cache.get(subject) : undefined;
    if (cached) {
      reports.set(symbol, cached);
      reused.push(symbol);
      continue;
    }
    reports.set(symbol, verifyFunction(declaration, { ...opts, environment, proofCache: cache }));
    verified.push(symbol);
  }
  return { reports, verified, reused, removed };
}
