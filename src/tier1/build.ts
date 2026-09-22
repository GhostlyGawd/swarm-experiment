/**
 * Term constructors.
 *
 * Agents mutate the graph through the store; these helpers exist so that
 * *tests, examples and the projection parser* can write trees without hand-
 * assembling object literals. They perform no checking — the type checker
 * (Tier 2) and the verifier are what decide whether a tree is admissible.
 */

import type {
  BinOp, Objective, Param, Purity, Rigor, StringOp, SurfaceDomain, Term, Ty, UnOp,
} from './ast.ts';
import { Bool, Int, Str, Unit } from './ast.ts';
import type { CapabilityName, NodeRef, ProvenanceId, SymbolId, TypeName } from './ids.ts';

export const int = (value: bigint | number): Term => ({
  kind: 'Lit',
  ty: Int,
  value: typeof value === 'bigint' ? value : BigInt(value),
});
export const bool = (value: boolean): Term => ({ kind: 'Lit', ty: Bool, value });
export const str = (value: string): Term => ({ kind: 'Lit', ty: Str, value });
export const unit = (): Term => ({ kind: 'Lit', ty: Unit, value: null });
/** A literal carrying a nominal type, e.g. 250 cents rather than 250. */
export const typed = (ty: Ty, value: bigint | boolean | string | null): Term => ({
  kind: 'Lit', ty, value,
});

export const v = (symbol: SymbolId): Term => ({ kind: 'Var', symbol });

export const bin = (op: BinOp, left: Term, right: Term): Term => ({ kind: 'Bin', op, left, right });
export const un = (op: UnOp, operand: Term): Term => ({ kind: 'Un', op, operand });

export const add = (l: Term, r: Term) => bin('add', l, r);
export const sub = (l: Term, r: Term) => bin('sub', l, r);
export const mul = (l: Term, r: Term) => bin('mul', l, r);
export const div = (l: Term, r: Term) => bin('div', l, r);
export const mod = (l: Term, r: Term) => bin('mod', l, r);
export const eq = (l: Term, r: Term) => bin('eq', l, r);
export const ne = (l: Term, r: Term) => bin('ne', l, r);
export const lt = (l: Term, r: Term) => bin('lt', l, r);
export const le = (l: Term, r: Term) => bin('le', l, r);
export const gt = (l: Term, r: Term) => bin('gt', l, r);
export const ge = (l: Term, r: Term) => bin('ge', l, r);
export const and = (l: Term, r: Term) => bin('and', l, r);
export const or = (l: Term, r: Term) => bin('or', l, r);
export const concat = (l: Term, r: Term) => bin('concat', l, r);
export const not = (e: Term) => un('not', e);
export const neg = (e: Term) => un('neg', e);

export const cond = (c: Term, then: Term, otherwise: Term): Term => ({
  kind: 'Cond', cond: c, then, otherwise,
});
export const call = (callee: SymbolId, ...args: Term[]): Term => ({ kind: 'Call', callee, args });
export const field = (object: Term, name: string): Term => ({ kind: 'Field', object, field: name });
export const record = (ty: Ty, fields: Record<string, Term>): Term => ({
  kind: 'RecordLit',
  ty,
  // Sorted so that two literals differing only in authoring order share an address.
  fields: Object.entries(fields).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
});
export const ok = (ty: Extract<Ty, { t: 'Result' }>, value: Term): Term =>
  ({ kind: 'ResultValue', variant: 'ok', ty, value });
export const err = (ty: Extract<Ty, { t: 'Result' }>, value: Term): Term =>
  ({ kind: 'ResultValue', variant: 'err', ty, value });
export const matchResult = (
  value: Term,
  okSymbol: SymbolId,
  okBody: Term,
  errSymbol: SymbolId,
  errBody: Term,
): Term => ({ kind: 'MatchResult', value, okSymbol, ok: okBody, errSymbol, err: errBody });
export const seq = (element: Ty, ...items: Term[]): Term =>
  ({ kind: 'SeqLit', ty: { t: 'Seq', element }, items });
export const index = (sequence: Term, at: Term): Term => ({ kind: 'SeqIndex', sequence, index: at });
export const length = (sequence: Term): Term => ({ kind: 'SeqLength', sequence });
export const map = (sequence: Term, callee: SymbolId): Term => ({ kind: 'SeqMap', sequence, callee });
export const fold = (sequence: Term, initial: Term, callee: SymbolId): Term =>
  ({ kind: 'SeqFold', sequence, initial, callee });
export const lambda = (spec: {
  params?: readonly Param[];
  returns: Ty;
  capabilities?: readonly CapabilityName[];
  body: Term;
}): Term => ({
  kind: 'Lambda', params: spec.params ?? [], returns: spec.returns,
  capabilities: spec.capabilities ?? [], body: spec.body,
});
export const apply = (fn: Term, ...args: Term[]): Term => ({ kind: 'Apply', fn, args });
export const stringOp = (op: StringOp, ...args: Term[]): Term => ({ kind: 'StringOp', op, args });
export const strlen = (value: Term): Term => stringOp('strlen', value);
export const contains = (value: Term, search: Term): Term => stringOp('contains', value, search);
export const slice = (value: Term, start: Term, end: Term): Term => stringOp('slice', value, start, end);
export const lower = (value: Term): Term => stringOp('lower', value);
export const upper = (value: Term): Term => stringOp('upper', value);
export const trim = (value: Term): Term => stringOp('trim', value);
export const intCast = (ty: Extract<Ty, { t: 'IntN' }>, value: Term): Term =>
  ({ kind: 'IntCast', ty, value });
export const fixed = (
  op: 'add' | 'sub' | 'mul' | 'div' | 'mod',
  ty: Extract<Ty, { t: 'IntN' }>,
  left: Term,
  right: Term,
): Term => ({ kind: 'FixedBin', op, ty, left, right });
export const forall = (symbol: SymbolId, start: Term, end: Term, body: Term): Term =>
  ({ kind: 'ForAll', symbol, start, end, body });
export const old = (expr: Term): Term => ({ kind: 'Old', expr });
export const result = (): Term => ({ kind: 'ResultRef' });
export const invoke = (capability: CapabilityName, ...args: Term[]): Term => ({
  kind: 'Invoke', capability, args,
});

export const place = (symbol: SymbolId, ...path: string[]): Term => ({ kind: 'Place', symbol, path });
export const let_ = (symbol: SymbolId, ty: Ty, init: Term): Term => ({ kind: 'Let', symbol, ty, init });
export const assign = (target: Term, value: Term): Term => ({ kind: 'Assign', target, value });
export const if_ = (c: Term, then: Term, otherwise: Term | null = null): Term => ({
  kind: 'If', cond: c, then, otherwise,
});
export const while_ = (
  c: Term,
  body: Term,
  opts: { invariants?: readonly Term[]; variant?: Term | null } = {},
): Term => ({
  kind: 'While',
  cond: c,
  invariants: opts.invariants ?? [],
  variant: opts.variant ?? null,
  body,
});
export const ret = (value: Term): Term => ({ kind: 'Return', value });
export const assert_ = (expr: Term, label: string): Term => ({ kind: 'Assert', expr, label });
export const exprStmt = (expr: Term): Term => ({ kind: 'ExprStmt', expr });
export const block = (...stmts: Term[]): Term => ({ kind: 'Block', stmts });

export const clause = (expr: Term, label: string, rigor: Rigor = 'formal'): Term => ({
  kind: 'Clause', expr, label, rigor,
});

export const contract = (spec: {
  requires?: readonly Term[];
  ensures?: readonly Term[];
  modifies?: readonly Term[];
}): Term => ({
  kind: 'Contract',
  requires: spec.requires ?? [],
  ensures: spec.ensures ?? [],
  modifies: spec.modifies ?? [],
});

export const fn = (spec: {
  symbol: SymbolId;
  typeParams?: readonly string[];
  params?: readonly Param[];
  returns: Ty;
  capabilities?: readonly CapabilityName[];
  purity?: Purity;
  contract?: Term | null;
  body?: Term | null;
  surfaces?: readonly Term[];
  provenance?: ProvenanceId | null;
}): Term => ({
  kind: 'FunctionDecl',
  symbol: spec.symbol,
  typeParams: spec.typeParams ?? [],
  params: spec.params ?? [],
  returns: spec.returns,
  capabilities: spec.capabilities ?? [],
  purity: spec.purity ?? (spec.capabilities?.length ? 'effectful' : 'pure'),
  contract: spec.contract ?? null,
  body: spec.body ?? null,
  surfaces: spec.surfaces ?? [],
  provenance: spec.provenance ?? null,
});

export const typeDecl = (name: TypeName, ty: Ty, provenance: ProvenanceId | null = null): Term => ({
  kind: 'TypeDecl', name, ty, provenance,
});

export const surface = (spec: {
  symbol: SymbolId;
  domain: SurfaceDomain;
  current: string | bigint;
  objective?: Objective;
}): Term => ({
  kind: 'Surface',
  symbol: spec.symbol,
  domain: spec.domain,
  current: spec.current,
  objective: spec.objective ?? 'minimize_latency',
});
export const import_ = (module: NodeRef, symbols: readonly SymbolId[] = []): Term =>
  ({ kind: 'Import', module, symbols });

export const module_ = (spec: {
  symbol: SymbolId;
  members: readonly Term[];
  symbolTable: Term;
  provenance?: ProvenanceId | null;
}): Term => ({
  kind: 'Module',
  symbol: spec.symbol,
  members: spec.members,
  symbolTable: spec.symbolTable,
  provenance: spec.provenance ?? null,
});

export const param = (symbol: SymbolId, ty: Ty): Param => ({ symbol, ty });
export const owned = (inner: Ty): Ty => ({ t: 'Owned', inner });

export { Bool, Int, Str, Unit };
