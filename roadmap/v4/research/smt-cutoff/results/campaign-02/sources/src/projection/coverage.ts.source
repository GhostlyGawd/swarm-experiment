import { LINK_SCHEMA, walk, type NodeKind, type Term } from '../tier1/ast.ts';

export type ProjectionTarget = 'typescript' | 'rust' | 'python';
export type ProjectionSupport = 'bidirectional' | 'native' | 'placeholder';

const native = new Set<NodeKind>([
  'Lit', 'Var', 'Bin', 'Cond', 'Call', 'Field', 'SeqLit', 'ResultValue',
  'Return', 'Block', 'FunctionDecl', 'TypeDecl', 'Module', 'SymbolTable',
]);

export const PROJECTION_COVERAGE: Readonly<Record<NodeKind, Readonly<Record<ProjectionTarget, ProjectionSupport>>>> =
  Object.fromEntries((Object.keys(LINK_SCHEMA) as NodeKind[]).map((kind) => [kind, {
    typescript: 'bidirectional',
    rust: native.has(kind) ? 'native' : 'placeholder',
    python: native.has(kind) ? 'native' : 'placeholder',
  }])) as Record<NodeKind, Record<ProjectionTarget, ProjectionSupport>>;

export function unsupportedProjectionKinds(term: Term, target: Exclude<ProjectionTarget, 'typescript'>): NodeKind[] {
  return [...new Set(
    [...walk(term)]
      .map((node) => node.kind)
      .filter((kind) => PROJECTION_COVERAGE[kind][target] === 'placeholder'),
  )].sort();
}
