import { LINK_SCHEMA, isExpressionKind, isStatementKind, withLinkGroups, type NodeKind, type Term } from './ast.ts';
import { decode, encode } from './agent-ir.ts';
import { GraphStore } from './store.ts';
import { DurableGraphStore } from './durable-store.ts';
import type { NodeRef } from './ids.ts';
import { typecheck, type CheckResult } from '../tier2/typecheck.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { lexical, orderChildren, type OccurrenceProjection } from './occurrence-tree.ts';

export interface MaterializationDiagnostic { readonly occurrenceId: string | null; readonly code: string; readonly detail: string }
export interface TreeMaterialization {
  readonly status: 'materialized' | 'invalid-structure';
  readonly rootOccurrence: string | null;
  /** Null whenever structural or replication diagnostics leave an incomplete candidate. */
  readonly root: NodeRef | null;
  readonly typecheck: CheckResult | null;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  /** Diagnostic subtree addresses, including any partial document root; no admission authority. */
  readonly occurrenceRoots: ReadonlyArray<readonly [string, NodeRef]>;
  readonly productionAuthorized: false;
}
/** Grouped AST roles, separate from type inference. Link count alone must never
 * turn a Clause into a statement or a statement into an expression. */
export function treeChildRole(parent: NodeKind, field: string, child: NodeKind): boolean {
  if (parent === 'Module') return field === 'symbolTable' ? child === 'SymbolTable' : ['FunctionDecl', 'TypeDecl', 'Import', 'Surface', 'Module'].includes(child);
  if (parent === 'FunctionDecl') return field === 'contract' ? child === 'Contract' : field === 'surfaces' ? child === 'Surface' : isStatementKind(child);
  if (parent === 'Contract') return field === 'modifies' ? child === 'Place' : child === 'Clause';
  if (parent === 'Block') return isStatementKind(child);
  if (parent === 'If' && field !== 'cond' || parent === 'While' && field === 'body' || parent === 'Atomic') return isStatementKind(child);
  if (parent === 'Lambda' && field === 'body') return isExpressionKind(child) || isStatementKind(child);
  if (parent === 'Assign' && field === 'target') return child === 'Place';
  return isExpressionKind(child);
}
function checkLiteral(term: Extract<Term, { kind: 'Lit' }>): void {
  let ty = term.ty;
  while (ty.t === 'Nominal' || ty.t === 'Owned') ty = ty.t === 'Nominal' ? ty.repr : ty.inner;
  const value = term.value;
  if (ty.t === 'Unit' && value === null || ty.t === 'Bool' && typeof value === 'boolean' || ty.t === 'Str' && typeof value === 'string' || ty.t === 'Int' && typeof value === 'bigint') return;
  if (ty.t === 'IntN' && typeof value === 'bigint') {
    if (![8, 16, 32, 64].includes(ty.bits) || typeof ty.signed !== 'boolean' || !['wrap', 'trap', 'saturate'].includes(ty.overflow)) throw new Error('unsupported fixed integer literal type');
    const minimum = ty.signed ? -(1n << BigInt(ty.bits - 1)) : 0n;
    const maximum = (1n << BigInt(ty.bits - (ty.signed ? 1 : 0))) - 1n;
    if (value >= minimum && value <= maximum) return;
  }
  throw new Error('literal value does not inhabit its declared type');
}
/** Build only the occurrence overlay; template child references are never used
 * as a fallback for missing editable children. Every returned CAS address is
 * retained under the caller's explicit lease, never committed as a root/head. */
export function materializeOccurrences(projection: OccurrenceProjection, store: DurableGraphStore, registry: CapabilityRegistry, leaseId: string): TreeMaterialization {
  const diagnostics: MaterializationDiagnostic[] = [], terms = new Map<string, Term>(), roots = new Map<string, NodeRef>();
  // Cycle suppression is the selected conflict resolution rule. Other excluded
  // operations describe an incomplete or quarantined candidate, including
  // deterministic capacity overflow; do not present its truncated AST as complete.
  for (const issue of projection.diagnostics) if (issue.code !== 'cycle-suppressed') diagnostics.push({ occurrenceId: issue.occurrenceId, code: 'unresolved-replication-operation', detail: `${issue.code}: ${issue.operationId}` });
  const nodes = new Map(projection.nodes.map(node => [node.occurrenceId, node]));
  const visiting = new Set<string>(); let remaining = 100000;
  const build = (id: string, depth: number): Term | null => {
    if (terms.has(id)) return terms.get(id)!;
    const node = nodes.get(id)!;
    try {
      if (depth > 64 || --remaining < 0) throw new Error('materialization resource limit');
      if (visiting.has(id)) throw new Error('cycle in occurrence overlay'); visiting.add(id);
      const template = store.get(node.content);
      const schema = LINK_SCHEMA[template.kind];
      if (!schema) throw new Error('unknown AST template kind');
      const children = orderChildren(projection.nodes, id);
      if (children.some(child => !schema.some(link => link.field === child.field))) throw new Error('unknown AST child field');
      const groups = new Map<string, Term[]>();
      for (const link of schema) {
        const children = orderChildren(projection.nodes, id, link.field), values: Term[] = [];
        for (const child of children) {
          const value = build(child.occurrenceId, depth + 1);
          if (!value) throw new Error(`invalid descendant in ${link.field}`);
          if (!treeChildRole(template.kind, link.field, value.kind)) throw new Error(`invalid child role: ${template.kind}.${link.field} cannot contain ${value.kind}`);
          values.push(value);
        }
        groups.set(link.field, values);
      }
      const term = withLinkGroups(template as unknown as Term, groups);
      // Agent-IR defines the supported scalar/type shape. A round trip must not
      // discard unknown fields or silently change an immutable v1 AST address.
      if (term.kind === 'Lit') checkLiteral(term);
      const memory = new GraphStore(), root = memory.intern(term);
      if (memory.intern(decode(encode(term).text)) !== root) throw new Error('noncanonical or unsupported AST scalar/type shape');
      const saved = store.intern(term, { leaseId });
      terms.set(id, term); roots.set(id, saved); return term;
    } catch (error) {
      diagnostics.push({ occurrenceId: id, code: 'invalid-ast-structure', detail: String(error) }); return null;
    } finally { visiting.delete(id); }
  };
  const rootCandidates = orderChildren(projection.nodes, null, 'root');
  if (projection.nodes.some(node => node.parent === null && node.field !== 'root')) diagnostics.push({ occurrenceId: null, code: 'invalid-document-root-field', detail: 'The document container accepts only the root field.' });
  if (rootCandidates.length !== 1) diagnostics.push({ occurrenceId: null, code: 'invalid-document-root-count', detail: `Expected one designated root occurrence, got ${rootCandidates.length}.` });
  const selected = rootCandidates.length === 1 ? rootCandidates[0] : null;
  const term = selected ? build(selected.occurrenceId, 0) : null;
  const root = selected && term ? roots.get(selected.occurrenceId)! : null;
  let checked: CheckResult | null = null;
  if (term && !diagnostics.length) {
    try { checked = typecheck(term, { registry }); }
    catch (error) { diagnostics.push({ occurrenceId: selected!.occurrenceId, code: 'typecheck-failed', detail: String(error) }); }
  }
  return { status: diagnostics.length || !root ? 'invalid-structure' : 'materialized', rootOccurrence: selected?.occurrenceId ?? null, root: diagnostics.length ? null : root, typecheck: checked, diagnostics: diagnostics.sort((a, b) => lexical(a.occurrenceId ?? '', b.occurrenceId ?? '') || lexical(a.detail, b.detail)), occurrenceRoots: [...roots].sort(([a], [b]) => lexical(a, b)), productionAuthorized: false };
}
