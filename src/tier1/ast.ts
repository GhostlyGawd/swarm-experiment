/**
 * The Aether AST (FR-1.1).
 *
 * `Term` is the hydrated tree — children inline — which the interpreter, the
 * verifier and the projector walk. `FlatNode` is the same union with every
 * child position replaced by a content address; that is the form persisted in
 * the DAG. `FlatNode` is *derived* from `Term` by a mapped type rather than
 * written out a second time, so the two representations cannot drift apart.
 *
 * Note what is deliberately absent from every node: identifier spellings. A
 * `Var` commits to a `SymbolId`, never to a name. Names live in a single
 * `SymbolTable` node, so renaming a binding rewrites one node and leaves every
 * expression hash — and therefore every cached verification result and every
 * compiled artifact downstream — intact (FR-1.1).
 */

import type { CapabilityName, NodeRef, ProvenanceId, SymbolId, TypeName } from './ids.ts';

export type BinOp =
  | 'add' | 'sub' | 'mul' | 'div' | 'mod'
  | 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'
  | 'and' | 'or'
  | 'concat';

export type UnOp = 'not' | 'neg';
export type StringOp = 'strlen' | 'contains' | 'slice' | 'lower' | 'upper' | 'trim';

/** Structural types. Inline values, not separately addressed nodes. */
export type Ty =
  | { t: 'Int' }
  | { t: 'Bool' }
  | { t: 'Str' }
  | { t: 'Unit' }
  /** Newtype over a representation type, e.g. `type:currency:cents` over Int. */
  | { t: 'Nominal'; name: TypeName; repr: Ty }
  | { t: 'Record'; name: TypeName; fields: ReadonlyArray<readonly [string, Ty]> }
  | { t: 'Result'; ok: Ty; err: Ty }
  | { t: 'Seq'; element: Ty }
  | { t: 'Fn'; params: readonly Ty[]; returns: Ty; capabilities: readonly CapabilityName[] }
  | { t: 'TypeVar'; name: string }
  | { t: 'IntN'; bits: 8 | 16 | 32 | 64; signed: boolean; overflow: 'wrap' | 'trap' | 'saturate' }
  | { t: 'Owned'; inner: Ty };

export const Int: Ty = { t: 'Int' };
export const Bool: Ty = { t: 'Bool' };
export const Str: Ty = { t: 'Str' };
export const Unit: Ty = { t: 'Unit' };

export interface Param {
  readonly symbol: SymbolId;
  readonly ty: Ty;
}

/** Where a clause sits on the tiered-rigor ladder (NFR 6.2, Risk R1). */
export type Rigor = 'formal' | 'property';
export type Purity = 'pure' | 'effectful';

/** A Tier-4 tunable exposed by a function (FR-4.2). */
export type SurfaceDomain =
  | { d: 'choice'; options: readonly string[] }
  | { d: 'range'; min: bigint; max: bigint; step: bigint };

export type Objective = 'minimize_latency' | 'minimize_cost' | 'minimize_memory';

export type Term =
  // ---- expressions -------------------------------------------------------
  | { kind: 'Lit'; ty: Ty; value: bigint | boolean | string | null }
  | { kind: 'Var'; symbol: SymbolId }
  | { kind: 'Bin'; op: BinOp; left: Term; right: Term }
  | { kind: 'Un'; op: UnOp; operand: Term }
  | { kind: 'Cond'; cond: Term; then: Term; otherwise: Term }
  | { kind: 'Call'; callee: SymbolId; args: readonly Term[] }
  | { kind: 'Field'; object: Term; field: string }
  | { kind: 'RecordLit'; ty: Ty; fields: ReadonlyArray<readonly [string, Term]> }
  /** Value-level constructors for the built-in binary sum type. */
  | { kind: 'ResultValue'; variant: 'ok' | 'err'; ty: Extract<Ty, { t: 'Result' }>; value: Term }
  /** Exhaustive elimination of a Result value. */
  | {
      kind: 'MatchResult'; value: Term;
      okSymbol: SymbolId; ok: Term;
      errSymbol: SymbolId; err: Term;
    }
  | { kind: 'SeqLit'; ty: Extract<Ty, { t: 'Seq' }>; items: readonly Term[] }
  | { kind: 'SeqIndex'; sequence: Term; index: Term }
  | { kind: 'SeqLength'; sequence: Term }
  | { kind: 'SeqMap'; sequence: Term; callee: SymbolId }
  | { kind: 'SeqFold'; sequence: Term; initial: Term; callee: SymbolId }
  | {
      kind: 'Lambda'; params: readonly Param[]; returns: Ty;
      capabilities: readonly CapabilityName[]; body: Term;
    }
  | { kind: 'Apply'; fn: Term; args: readonly Term[] }
  | { kind: 'StringOp'; op: StringOp; args: readonly Term[] }
  | { kind: 'IntCast'; ty: Extract<Ty, { t: 'IntN' }>; value: Term }
  | {
      kind: 'FixedBin'; op: 'add' | 'sub' | 'mul' | 'div' | 'mod';
      ty: Extract<Ty, { t: 'IntN' }>; left: Term; right: Term;
    }
  | { kind: 'ForAll'; symbol: SymbolId; start: Term; end: Term; body: Term }
  /** `old(e)` — the pre-state value of `e`. Legal only inside `ensures`. */
  | { kind: 'Old'; expr: Term }
  /** `result` — the value being returned. Legal only inside `ensures`. */
  | { kind: 'ResultRef' }
  /** The only route to the outside world; requires `capability` in scope. */
  | { kind: 'Invoke'; capability: CapabilityName; args: readonly Term[] }
  // ---- places and statements --------------------------------------------
  | { kind: 'Place'; symbol: SymbolId; path: readonly string[] }
  | { kind: 'Let'; symbol: SymbolId; ty: Ty; init: Term }
  | { kind: 'Assign'; target: Term; value: Term }
  | { kind: 'If'; cond: Term; then: Term; otherwise: Term | null }
  | { kind: 'While'; cond: Term; invariants: readonly Term[]; variant: Term | null; body: Term }
  | { kind: 'Return'; value: Term }
  | { kind: 'Assert'; expr: Term; label: string }
  | { kind: 'ExprStmt'; expr: Term }
  | { kind: 'Block'; stmts: readonly Term[] }
  // ---- declarations ------------------------------------------------------
  | { kind: 'Clause'; expr: Term; label: string; rigor: Rigor }
  | { kind: 'Contract'; requires: readonly Term[]; ensures: readonly Term[]; modifies: readonly Term[] }
  | {
      kind: 'FunctionDecl';
      symbol: SymbolId;
      typeParams: readonly string[];
      params: readonly Param[];
      returns: Ty;
      capabilities: readonly CapabilityName[];
      purity: Purity;
      contract: Term | null;
      /** `null` for a declared-but-unsynthesized function (FR-2.2). */
      body: Term | null;
      surfaces: readonly Term[];
      provenance: ProvenanceId | null;
    }
  | { kind: 'TypeDecl'; name: TypeName; ty: Ty; provenance: ProvenanceId | null }
  | {
      kind: 'Surface';
      symbol: SymbolId;
      domain: SurfaceDomain;
      current: string | bigint;
      objective: Objective;
    }
  | { kind: 'SymbolTable'; entries: ReadonlyArray<readonly [SymbolId, string]> }
  | { kind: 'Import'; module: NodeRef; symbols: readonly SymbolId[] }
  | {
      kind: 'Module';
      symbol: SymbolId;
      members: readonly Term[];
      symbolTable: Term;
      provenance: ProvenanceId | null;
    };

export type NodeKind = Term['kind'];

/**
 * Replace every child position of a node type with link type `L`.
 * `[F] extends [Term]` is wrapped in tuples so the check is not distributive:
 * a `Term | null` field must fall through to the nullable case rather than
 * being split into `L | never`.
 */
type RelinkField<F, L> = [F] extends [Term]
  ? L
  : [F] extends [Term | null]
    ? L | null
    : [F] extends [ReadonlyArray<readonly [string, Term]>]
      ? ReadonlyArray<readonly [string, L]>
      : [F] extends [readonly Term[]]
        ? readonly L[]
        : F;

type Relink<T, L> = T extends unknown ? { readonly [K in keyof T]: RelinkField<T[K], L> } : never;

/** A stored node: children are content addresses. */
export type FlatNode = Relink<Term, NodeRef>;
/** A node in either representation. */
export type AnyNode = Term | FlatNode;

type Arity = 'one' | 'opt' | 'many' | 'pairs';
interface LinkField {
  readonly field: string;
  readonly arity: Arity;
}

const one = (field: string): LinkField => ({ field, arity: 'one' });
const opt = (field: string): LinkField => ({ field, arity: 'opt' });
const many = (field: string): LinkField => ({ field, arity: 'many' });

/**
 * The single source of truth for which fields of each node kind are links.
 * Every traversal in the fabric — hashing, hydration, merge, rewriting,
 * capability checking — reads this table, so a new node kind cannot silently
 * leave a child unvisited in some module that forgot to add a `case`.
 */
export const LINK_SCHEMA: Readonly<Record<NodeKind, readonly LinkField[]>> = {
  Lit: [],
  Var: [],
  ResultRef: [],
  Place: [],
  TypeDecl: [],
  Surface: [],
  SymbolTable: [],
  Import: [],
  Bin: [one('left'), one('right')],
  Un: [one('operand')],
  Cond: [one('cond'), one('then'), one('otherwise')],
  Call: [many('args')],
  Field: [one('object')],
  RecordLit: [{ field: 'fields', arity: 'pairs' }],
  ResultValue: [one('value')],
  MatchResult: [one('value'), one('ok'), one('err')],
  SeqLit: [many('items')],
  SeqIndex: [one('sequence'), one('index')],
  SeqLength: [one('sequence')],
  SeqMap: [one('sequence')],
  SeqFold: [one('sequence'), one('initial')],
  Lambda: [one('body')],
  Apply: [one('fn'), many('args')],
  StringOp: [many('args')],
  IntCast: [one('value')],
  FixedBin: [one('left'), one('right')],
  ForAll: [one('start'), one('end'), one('body')],
  Old: [one('expr')],
  Invoke: [many('args')],
  Let: [one('init')],
  Assign: [one('target'), one('value')],
  If: [one('cond'), one('then'), opt('otherwise')],
  While: [one('cond'), many('invariants'), opt('variant'), one('body')],
  Return: [one('value')],
  Assert: [one('expr')],
  ExprStmt: [one('expr')],
  Block: [many('stmts')],
  Clause: [one('expr')],
  Contract: [many('requires'), many('ensures'), many('modifies')],
  FunctionDecl: [opt('contract'), opt('body'), many('surfaces')],
  Module: [many('members'), one('symbolTable')],
};

const EXPRESSION_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'Lit', 'Var', 'Bin', 'Un', 'Cond', 'Call', 'Field', 'RecordLit', 'ResultValue', 'MatchResult',
  'SeqLit', 'SeqIndex', 'SeqLength', 'SeqMap', 'SeqFold', 'Lambda', 'Apply', 'StringOp',
  'IntCast', 'FixedBin', 'ForAll', 'Old', 'ResultRef', 'Invoke',
]);

const STATEMENT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'Let', 'Assign', 'If', 'While', 'Return', 'Assert', 'ExprStmt', 'Block',
]);

export const isExpressionKind = (k: NodeKind): boolean => EXPRESSION_KINDS.has(k);
export const isStatementKind = (k: NodeKind): boolean => STATEMENT_KINDS.has(k);

type Bag = Record<string, unknown>;

/**
 * Children grouped by the field they came from.
 *
 * Grouping is not cosmetic: a flat child list is ambiguous. `While` with one
 * invariant and no variant, and `While` with no invariant and a variant, flatten
 * to the same three children. Hashing the grouped form keeps them distinct.
 */
export function linkGroups(node: Term): ReadonlyArray<{ field: string; links: readonly Term[] }>;
export function linkGroups(
  node: FlatNode,
): ReadonlyArray<{ field: string; links: readonly NodeRef[] }>;
export function linkGroups(node: AnyNode): ReadonlyArray<{ field: string; links: readonly unknown[] }> {
  const bag = node as unknown as Bag;
  return LINK_SCHEMA[node.kind].map(({ field, arity }) => {
    const raw = bag[field];
    switch (arity) {
      case 'one':
        return { field, links: [raw] };
      case 'opt':
        return { field, links: raw === null || raw === undefined ? [] : [raw] };
      case 'many':
        return { field, links: raw as readonly unknown[] };
      case 'pairs':
        return { field, links: (raw as ReadonlyArray<readonly [string, unknown]>).map((p) => p[1]) };
    }
  });
}

/** All direct children of a node, in canonical order. */
export function children(node: Term): readonly Term[];
export function children(node: FlatNode): readonly NodeRef[];
export function children(node: AnyNode): readonly unknown[] {
  return linkGroups(node as Term).flatMap((g) => g.links as readonly Term[]);
}

/**
 * Rebuild `node` with its children replaced in canonical order. The node's
 * *shape* is preserved: an optional field that was absent stays absent.
 */
export function withChildren(node: Term, next: readonly Term[]): Term;
export function withChildren(node: FlatNode, next: readonly NodeRef[]): FlatNode;
export function withChildren(node: AnyNode, next: readonly unknown[]): AnyNode {
  const bag = node as unknown as Bag;
  const out: Bag = { ...bag };
  let i = 0;
  for (const { field, arity } of LINK_SCHEMA[node.kind]) {
    switch (arity) {
      case 'one':
        out[field] = next[i++];
        break;
      case 'opt':
        out[field] = bag[field] === null || bag[field] === undefined ? null : next[i++];
        break;
      case 'many': {
        const n = (bag[field] as readonly unknown[]).length;
        out[field] = next.slice(i, i + n);
        i += n;
        break;
      }
      case 'pairs': {
        const pairs = bag[field] as ReadonlyArray<readonly [string, unknown]>;
        out[field] = pairs.map((p) => [p[0], next[i++]] as const);
        break;
      }
    }
  }
  if (i !== next.length) {
    throw new RangeError(`${node.kind} takes ${i} children, got ${next.length}`);
  }
  return out as unknown as AnyNode;
}

/**
 * Rebuild `node` from per-field link groups, allowing variable-arity fields to
 * change length. `withChildren` deliberately preserves a node's shape; the
 * merge needs the opposite, because a merged statement list is usually longer
 * or shorter than the one it came from.
 */
export function withLinkGroups(node: Term, groups: ReadonlyMap<string, readonly Term[]>): Term;
export function withLinkGroups(
  node: FlatNode,
  groups: ReadonlyMap<string, readonly NodeRef[]>,
): FlatNode;
export function withLinkGroups(
  node: AnyNode,
  groups: ReadonlyMap<string, readonly unknown[]>,
): AnyNode {
  const bag = node as unknown as Bag;
  const out: Bag = { ...bag };
  for (const { field, arity } of LINK_SCHEMA[node.kind]) {
    const links = groups.get(field);
    if (!links) continue;
    switch (arity) {
      case 'one':
        if (links.length !== 1) {
          throw new RangeError(`${node.kind}.${field} needs exactly one child, got ${links.length}`);
        }
        out[field] = links[0];
        break;
      case 'opt':
        if (links.length > 1) {
          throw new RangeError(`${node.kind}.${field} takes at most one child, got ${links.length}`);
        }
        out[field] = links.length === 1 ? links[0] : null;
        break;
      case 'many':
        out[field] = [...links];
        break;
      case 'pairs': {
        const names = (bag[field] as ReadonlyArray<readonly [string, unknown]>).map((p) => p[0]);
        if (names.length !== links.length) {
          throw new RangeError(
            `${node.kind}.${field} has ${names.length} names but ${links.length} values`,
          );
        }
        out[field] = names.map((n, i) => [n, links[i]] as const);
        break;
      }
    }
  }
  return out as unknown as AnyNode;
}

/**
 * The scalar payload of a node: everything that is not a link, and therefore
 * everything hashing must capture besides the children themselves.
 */
export function scalarPayload(node: AnyNode): Readonly<Bag> {
  const bag = node as unknown as Bag;
  const linked = new Set(LINK_SCHEMA[node.kind].map((f) => f.field));
  const out: Bag = {};
  for (const key of Object.keys(bag)) {
    if (!linked.has(key)) out[key] = bag[key];
  }
  // A `pairs` field's *names* are payload even though its values are links.
  for (const { field, arity } of LINK_SCHEMA[node.kind]) {
    if (arity === 'pairs') {
      out[field] = (bag[field] as ReadonlyArray<readonly [string, unknown]>).map((p) => p[0]);
    }
  }
  return out;
}

/** Pre-order walk of a hydrated tree. */
export function* walk(term: Term): Generator<Term> {
  yield term;
  for (const child of children(term)) yield* walk(child);
}

/** Count of nodes in a hydrated tree (counting shared subtrees once per occurrence). */
export function size(term: Term): number {
  let n = 0;
  for (const _ of walk(term)) n++;
  return n;
}
