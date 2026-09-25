import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { decimal, encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { operationId, type CandidateOperation } from '../fabric/replication.ts';
import type { NodeRef } from './ids.ts';
import { compareFractionalPositions, parseFractionalPosition } from './fractional-position.ts';

export const TREE_SEMANTICS = 'aether.occurrence-tree/1';
export const TRASH_PARENT = 'aether.tree-trash/1';
export interface OperationStamp { readonly lamport: string; readonly operationId: Digest }
export interface OccurrenceNode {
  readonly occurrenceId: Digest;
  readonly createdBy: Digest;
  readonly parent: Digest | typeof TRASH_PARENT | null;
  readonly field: string;
  readonly positionId: string;
  readonly content: NodeRef;
  readonly placement: OperationStamp;
  readonly replacement: OperationStamp;
}
export interface TreeDiagnostic { readonly operationId: Digest; readonly code: string; readonly occurrenceId: string }
export interface OccurrenceProjection {
  readonly format: typeof TREE_SEMANTICS;
  readonly nodes: readonly OccurrenceNode[];
  readonly visible: readonly Digest[];
  readonly trash: readonly Digest[];
  readonly diagnostics: readonly TreeDiagnostic[];
}
export const lexical = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export function compareStamps(a: OperationStamp, b: OperationStamp): number {
  const first = BigInt(a.lamport), second = BigInt(b.lamport);
  return first < second ? -1 : first > second ? 1 : lexical(a.operationId, b.operationId);
}
export function occurrenceIdForInsert(id: Digest): Digest { validateDigest(id, 'aether.operation-id/1'); return domainDigest('aether.occurrence/1', { insertOperationId: id }); }
export function orderChildren(nodes: readonly OccurrenceNode[], parent: string | null, field?: string): OccurrenceNode[] {
  return nodes.filter(node => node.parent === parent && (field === undefined || node.field === field))
    .sort((a, b) => (field === undefined ? lexical(a.field, b.field) : 0) || compareFractionalPositions(a.positionId, b.positionId) || compareStamps(a.placement, b.placement));
}
export function validateOccurrenceNodes(nodes: readonly OccurrenceNode[]): void {
  encodeCanonical(nodes);
  const ids = new Set<string>();
  for (const node of nodes) {
    exactObject(node, ['occurrenceId', 'createdBy', 'parent', 'field', 'positionId', 'content', 'placement', 'replacement']);
    validateDigest(node.createdBy, 'aether.operation-id/1');
    if (node.occurrenceId !== occurrenceIdForInsert(node.createdBy) || ids.has(node.occurrenceId)) throw new Error('invalid or duplicate occurrence identity');
    ids.add(node.occurrenceId); identifier(node.field); parseFractionalPosition(node.positionId); validateDigest(node.content, 'ast');
    if (node.parent !== null && node.parent !== TRASH_PARENT) validateDigest(node.parent, 'aether.occurrence/1');
    for (const stamp of [node.placement, node.replacement]) { exactObject(stamp, ['lamport', 'operationId']); decimal(stamp.lamport); validateDigest(stamp.operationId, 'aether.operation-id/1'); }
  }
  const byId = new Map(nodes.map(node => [node.occurrenceId, node]));
  for (const node of nodes) {
    const visited = new Set<string>(); let cursor: string | null = node.occurrenceId;
    while (cursor !== null && cursor !== TRASH_PARENT) {
      if (visited.has(cursor)) throw new Error('cycle in occurrence checkpoint'); visited.add(cursor);
      const current = byId.get(cursor); if (!current) throw new Error('dangling occurrence parent'); cursor = current.parent;
    }
  }
}
/** Deterministic sequential projection of the authenticated F05 operation set.
 * Rebuild after every union change; no arrival-order materialization is retained.
 * This candidate view has no production-admission authority. */
export function projectOccurrences(rows: readonly CandidateOperation[], base: readonly OccurrenceNode[] = [], maxOccurrences = 4096): OccurrenceProjection {
  if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 4096 || base.length > maxOccurrences) throw new RangeError('invalid occurrence projection capacity');
  validateOccurrenceNodes(base);
  const nodes = new Map<string, OccurrenceNode>(base.map(node => [node.occurrenceId, node]));
  const diagnostics = new Map<string, TreeDiagnostic>();
  const diagnose = (row: CandidateOperation, code: string) => {
    const diagnostic = { operationId: row.operationId, code, occurrenceId: row.envelope.occurrenceId };
    diagnostics.set(JSON.stringify(diagnostic), diagnostic);
  };
  const sorted = [...rows].sort((a, b) => compareStamps({ lamport: a.envelope.lamport, operationId: a.operationId }, { lamport: b.envelope.lamport, operationId: b.operationId }));
  for (const row of sorted) {
    const op = row.envelope;
    if (row.operationId !== operationId(op)) { diagnose(row, 'invalid-operation-id'); continue; }
    if (row.disposition !== 'accepted') { diagnose(row, row.disposition); continue; }
    const existing = nodes.get(op.occurrenceId), stamp = { lamport: op.lamport, operationId: row.operationId };
    if (op.operation === 'insert') {
      if (op.occurrenceId !== occurrenceIdForInsert(row.operationId)) { diagnose(row, 'unsupported-occurrence-identity'); continue; }
      if (existing) { diagnose(row, 'duplicate-creation'); continue; }
      // The bounded candidate projection suppresses excess insertions in the
      // same total order at every replica. The authenticated frame is retained.
      if (nodes.size >= maxOccurrences) { diagnose(row, 'occurrence-capacity-suppressed'); continue; }
    } else if (!existing) { diagnose(row, 'missing-occurrence'); continue; }
    if (op.operation === 'replace' && op.payload.format === 'aether.tree-replace/1') {
      nodes.set(op.occurrenceId, { ...existing!, content: op.payload.content as NodeRef, replacement: stamp }); continue;
    }
    if (op.operation === 'delete') {
      nodes.set(op.occurrenceId, { ...existing!, parent: TRASH_PARENT, placement: stamp }); continue;
    }
    if (op.payload.format !== 'aether.tree-insert/1' && op.payload.format !== 'aether.tree-move/1') { diagnose(row, 'invalid-payload'); continue; }
    const parent = op.payload.parentOccurrence;
    if (parent !== null && !nodes.has(parent)) { diagnose(row, 'missing-parent'); continue; }
    try { parseFractionalPosition(op.payload.positionId); } catch { diagnose(row, 'unsupported-fractional-position'); continue; }
    let cursor: string | null = parent, cycle = false;
    while (cursor !== null && cursor !== TRASH_PARENT) {
      if (cursor === op.occurrenceId) { cycle = true; break; }
      cursor = nodes.get(cursor)?.parent ?? null;
    }
    if (cycle) { diagnose(row, 'cycle-suppressed'); continue; }
    const placement = { parent, field: op.payload.field, positionId: op.payload.positionId, placement: stamp };
    if (op.operation === 'insert' && op.payload.format === 'aether.tree-insert/1') nodes.set(op.occurrenceId, { occurrenceId: op.occurrenceId, createdBy: row.operationId, content: op.payload.content as NodeRef, replacement: stamp, ...placement });
    else nodes.set(op.occurrenceId, { ...existing!, ...placement });
  }
  const all = [...nodes.values()].sort((a, b) => lexical(a.occurrenceId, b.occurrenceId));
  validateOccurrenceNodes(all);
  const descendants = (parent: string | null): Digest[] => {
    const result: Digest[] = [], pending = orderChildren(all, parent).reverse();
    while (pending.length) { const node = pending.pop()!; result.push(node.occurrenceId); pending.push(...orderChildren(all, node.occurrenceId).reverse()); }
    return result;
  };
  return { format: TREE_SEMANTICS, nodes: all, visible: descendants(null), trash: descendants(TRASH_PARENT), diagnostics: [...diagnostics.values()].sort((a, b) => lexical(a.operationId, b.operationId) || lexical(a.code, b.code)) };
}
export interface ReindexEntry { readonly occurrenceId: Digest; readonly parent: Digest | null; readonly field: string; readonly before: string; readonly after: string }
export function compactOccurrenceProjection(projection: OccurrenceProjection): { nodes: OccurrenceNode[]; collected: Digest[]; reindex: ReindexEntry[] } {
  validateOccurrenceNodes(projection.nodes);
  const discarded = new Set(projection.trash), retained = projection.nodes.filter(node => !discarded.has(node.occurrenceId));
  const reindex: ReindexEntry[] = [], replacements = new Map<string, string>();
  const groups = new Map<string, { parent: string | null; field: string }>();
  for (const node of retained) groups.set(JSON.stringify([node.parent, node.field]), { parent: node.parent, field: node.field });
  for (const group of [...groups.values()].sort((a, b) => lexical(JSON.stringify(a), JSON.stringify(b)))) {
    orderChildren(retained, group.parent, group.field).forEach((node, index) => {
      const after = `fi1:${index + 1}/1`;
      replacements.set(node.occurrenceId, after); reindex.push({ occurrenceId: node.occurrenceId, parent: node.parent, field: node.field, before: node.positionId, after });
    });
  }
  const nodes = retained.map(node => ({ ...node, positionId: replacements.get(node.occurrenceId)! }));
  validateOccurrenceNodes(nodes);
  return { nodes, collected: [...discarded].sort(lexical), reindex: reindex.sort((a, b) => lexical(a.occurrenceId, b.occurrenceId)) };
}
