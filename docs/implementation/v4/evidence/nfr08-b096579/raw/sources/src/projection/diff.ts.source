import { linkGroups, scalarPayload, type FlatNode, type Term } from '../tier1/ast.ts';
import type { NodeRef } from '../tier1/ids.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import type { GraphStore, Step } from '../tier1/store.ts';
import { canonicalText } from '../tier1/canonical.ts';
import { TypeScriptProjector } from './typescript.ts';

export interface ProjectionDiffEntry {
  readonly path: readonly Step[];
  readonly before: NodeRef | null;
  readonly after: NodeRef | null;
  readonly reason: 'inserted' | 'deleted' | 'changed';
}

export function structuralDiff(
  store: GraphStore,
  before: NodeRef,
  after: NodeRef,
): ProjectionDiffEntry[] {
  const entries: ProjectionDiffEntry[] = [];
  const compare = (left: NodeRef | null, right: NodeRef | null, path: Step[]): void => {
    if (left === right) return;
    if (!left) { entries.push({ path, before: null, after: right, reason: 'inserted' }); return; }
    if (!right) { entries.push({ path, before: left, after: null, reason: 'deleted' }); return; }
    const a = store.get(left);
    const b = store.get(right);
    if (a.kind !== b.kind || canonicalText(scalarPayload(a) as never) !== canonicalText(scalarPayload(b) as never)) {
      entries.push({ path, before: left, after: right, reason: 'changed' });
      return;
    }
    const aGroups = new Map(linkGroups(a).map((group) => [group.field, group.links]));
    const bGroups = new Map(linkGroups(b).map((group) => [group.field, group.links]));
    for (const field of new Set([...aGroups.keys(), ...bGroups.keys()])) {
      const leftLinks = aGroups.get(field) ?? [];
      const rightLinks = bGroups.get(field) ?? [];
      for (let index = 0; index < Math.max(leftLinks.length, rightLinks.length); index++) {
        compare(leftLinks[index] ?? null, rightLinks[index] ?? null, [...path, { field, index }]);
      }
    }
  };
  compare(before, after, []);
  return entries;
}

export function projectDiff(
  store: GraphStore,
  before: NodeRef,
  after: NodeRef,
  symbols: SymbolSpace,
): string {
  const projector = new TypeScriptProjector(symbols);
  const render = (ref: NodeRef | null): string => {
    if (!ref) return '(absent)';
    const term = store.hydrate(ref) as Term;
    try { return projector.decl(term).trim(); } catch { return term.kind; }
  };
  return structuralDiff(store, before, after).map((entry) => {
    const path = entry.path.length
      ? entry.path.map((step) => `${step.field}[${step.index}]`).join('.')
      : '(root)';
    return `@@ ${path} (${entry.reason})\n- ${render(entry.before)}\n+ ${render(entry.after)}`;
  }).join('\n\n');
}
