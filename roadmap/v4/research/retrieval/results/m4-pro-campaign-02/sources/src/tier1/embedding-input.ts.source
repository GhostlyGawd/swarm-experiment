/** Versioned AST/context input and structural metadata. These are sidecars: no
 * embedding, spelling or retrieval state is written into executable AST nodes. */
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { linkGroups, type FlatNode, type NodeKind, type Purity, type Ty } from './ast.ts';
import type { NodeRef } from './ids.ts';
import { DurableGraphStore } from './durable-store.ts';

export const EMBEDDING_INPUT_VERSION = 'aether.ast-embedding-input/1';
export interface IndexScope { readonly root: NodeRef; readonly context: { readonly specRoot: Digest | null; readonly text: string } }
export interface StructuralEdge { readonly field: string; readonly index: number; readonly node: NodeRef }
export interface EmbeddingInput {
  readonly format: typeof EMBEDDING_INPUT_VERSION; readonly entryId: Digest; readonly scopeDigest: Digest;
  readonly subject: NodeRef; readonly contextDigest: Digest; readonly inputDigest: Digest; readonly text: string;
  readonly structure: {
    readonly kind: NodeKind; readonly declaredPurity: Purity | null; readonly capabilities: readonly string[];
    readonly declaredReturnType: Digest | null; readonly declaredTypes: readonly Digest[];
    readonly typeNames: readonly string[]; readonly typeDependencies: readonly NodeRef[];
    readonly parents: readonly StructuralEdge[]; readonly children: readonly StructuralEdge[];
  };
}
function validateType(value: Ty, depth = 0): void {
  if (depth > 64 || !value || typeof value !== 'object') throw new Error('invalid declared index type');
  const recurse = (ty: Ty) => validateType(ty, depth + 1);
  switch (value.t) {
    case 'Int': case 'Bool': case 'Str': case 'Unit': exactObject(value, ['t']); return;
    case 'Nominal': exactObject(value, ['t', 'name', 'repr']); identifier(value.name); recurse(value.repr); return;
    case 'Record': {
      exactObject(value, ['t', 'name', 'fields']); identifier(value.name);
      if (!Array.isArray(value.fields)) throw new Error('invalid declared record type');
      const names = new Set<string>(); for (const field of value.fields) { if (!Array.isArray(field) || field.length !== 2) throw new Error('invalid declared field'); identifier(field[0]); if (names.has(field[0])) throw new Error('duplicate declared field'); names.add(field[0]); recurse(field[1]); } return;
    }
    case 'Result': exactObject(value, ['t', 'ok', 'err']); recurse(value.ok); recurse(value.err); return;
    case 'Seq': exactObject(value, ['t', 'element']); recurse(value.element); return;
    case 'Owned': exactObject(value, ['t', 'inner']); recurse(value.inner); return;
    case 'Task': exactObject(value, ['t', 'result']); recurse(value.result); return;
    case 'TypeVar': exactObject(value, ['t', 'name']); identifier(value.name); return;
    case 'Fn': exactObject(value, ['t', 'params', 'returns', 'capabilities']); if (!Array.isArray(value.params) || !Array.isArray(value.capabilities)) throw new Error('invalid declared function type'); value.params.forEach(recurse); recurse(value.returns); value.capabilities.forEach(identifier); return;
    case 'IntN': exactObject(value, ['t', 'bits', 'signed', 'overflow']); if (![8, 16, 32, 64].includes(value.bits) || typeof value.signed !== 'boolean' || !['wrap', 'trap', 'saturate'].includes(value.overflow)) throw new Error('invalid declared fixed integer type'); return;
    default: throw new Error('unsupported declared index type');
  }
}
export function typeDigest(ty: Ty): Digest { encodeCanonical(ty); validateType(ty); return domainDigest('aether.index-type/1', ty); }
export function scopeDigest(scope: IndexScope): Digest {
  encodeCanonical(scope); exactObject(scope, ['root', 'context']); exactObject(scope.context, ['specRoot', 'text']); validateDigest(scope.root, 'ast');
  if (scope.context.specRoot !== null) validateDigest(scope.context.specRoot);
  if (typeof scope.context.text !== 'string' || Buffer.byteLength(scope.context.text) > 16384) throw new RangeError('index context text limit');
  return domainDigest('aether.index-scope/1', scope);
}
const sorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();
function typesIn(node: FlatNode): Ty[] {
  const values: Ty[] = [];
  if ('ty' in node) values.push(node.ty);
  if ('returns' in node) values.push(node.returns);
  if ('params' in node) values.push(...node.params.map(param => param.ty));
  return values;
}
function typeNames(ty: Ty, found = new Set<string>()): Set<string> {
  if ('name' in ty && (ty.t === 'Nominal' || ty.t === 'Record')) found.add(ty.name);
  switch (ty.t) {
    case 'Nominal': typeNames(ty.repr, found); break;
    case 'Record': for (const [, field] of ty.fields) typeNames(field, found); break;
    case 'Result': typeNames(ty.ok, found); typeNames(ty.err, found); break;
    case 'Seq': typeNames(ty.element, found); break;
    case 'Fn': ty.params.forEach(param => typeNames(param, found)); typeNames(ty.returns, found); break;
    case 'Owned': typeNames(ty.inner, found); break;
    case 'Task': typeNames(ty.result, found); break;
  }
  return found;
}
function display(value: unknown, names: ReadonlyMap<string, string>, depth = 0): string {
  if (depth > 32) throw new RangeError('embedding scalar depth');
  if (typeof value === 'string') return names.get(value) ?? value;
  if (typeof value === 'bigint') return value.toString();
  if (value === null) return 'none';
  if (Array.isArray(value)) return value.map(item => display(item, names, depth + 1)).join(' ');
  if (typeof value === 'object') return Object.entries(value as object).filter(([key]) => key !== 'provenance').map(([key, child]) => `${key} ${display(child, names, depth + 1)}`).join(' ');
  return String(value);
}
/** Traverse every grouped child occurrence, storing one entry per (scope,node).
 * Shared nodes preserve every direct parent edge, and distinct scope contexts
 * receive different input identities even when executable content is shared. */
export function embeddingInputs(store: DurableGraphStore, scopes: readonly IndexScope[], maxEntries = 10000): EmbeddingInput[] {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('index entry bound');
  const output: EmbeddingInput[] = [], seenScopes = new Set<string>();
  for (const scope of scopes) {
    const scopeId = scopeDigest(scope); if (seenScopes.has(scopeId)) throw new Error('duplicate index scope'); seenScopes.add(scopeId);
    const nodes = new Map<NodeRef, FlatNode>(), pending = [scope.root], parents = new Map<NodeRef, StructuralEdge[]>();
    while (pending.length) {
      const ref = pending.pop()!; if (nodes.has(ref)) continue;
      if (output.length + nodes.size >= maxEntries) throw new RangeError('index entry capacity');
      const node = store.get(ref); nodes.set(ref, node);
      for (const group of linkGroups(node)) group.links.forEach((child, index) => {
        const incoming = parents.get(child) ?? []; incoming.push({ field: group.field, index, node: ref }); parents.set(child, incoming); pending.push(child);
      });
    }
    const names = new Map<string, string>(), declarations = new Map<string, NodeRef>();
    for (const [ref, node] of nodes) {
      if (node.kind === 'SymbolTable') for (const [symbol, name] of node.entries) {
        if (names.has(symbol) && names.get(symbol) !== name) throw new Error('conflicting symbol context'); names.set(symbol, name);
      }
      if (node.kind === 'TypeDecl') { if (declarations.has(node.name) && declarations.get(node.name) !== ref) throw new Error('conflicting type declarations'); declarations.set(node.name, ref); }
    }
    const contextDigest = domainDigest('aether.index-context/1', { scope, names: [...names].sort(([a], [b]) => a < b ? -1 : 1) });
    const describe = (ref: NodeRef, depth: number, remaining: { count: number }): string => {
      if (depth > 8 || remaining.count-- <= 0) return '[subtree summarized]';
      const node = nodes.get(ref)!; const fields = new Set(linkGroups(node).map(group => group.field));
      const scalars = Object.fromEntries(Object.entries(node).filter(([key]) => !fields.has(key) && key !== 'provenance'));
      return `${display(scalars, names)} ${linkGroups(node).map(group => `${group.field} ${group.links.map(child => describe(child, depth + 1, remaining)).join(' ')}`).join(' ')}`.trim();
    };
    for (const [subject, node] of [...nodes].sort(([a], [b]) => a < b ? -1 : 1)) {
      const declared = typesIn(node), nominalNames = sorted(declared.flatMap(ty => [...typeNames(ty)]));
      const structure: EmbeddingInput['structure'] = {
        kind: node.kind, declaredPurity: node.kind === 'FunctionDecl' ? node.purity : null,
        capabilities: sorted('capabilities' in node ? node.capabilities : node.kind === 'Invoke' ? [node.capability] : []),
        declaredReturnType: node.kind === 'FunctionDecl' || node.kind === 'Lambda' ? typeDigest(node.returns) : null,
        declaredTypes: sorted(declared.map(typeDigest)), typeNames: nominalNames,
        typeDependencies: sorted(nominalNames.flatMap(name => declarations.has(name) ? [declarations.get(name)!] : [])),
        parents: (parents.get(subject) ?? []).sort((a, b) => a.node.localeCompare(b.node) || a.field.localeCompare(b.field) || a.index - b.index),
        children: linkGroups(node).flatMap(group => group.links.map((child, index) => ({ field: group.field, index, node: child }))),
      };
      const text = `${scope.context.text ? `Context: ${scope.context.text}\n` : ''}${describe(subject, 0, { count: 64 })}`;
      if (Buffer.byteLength(text) > 65536) throw new RangeError('embedding input text limit');
      const entryId = domainDigest('aether.index-entry/1', { scopeDigest: scopeId, subject });
      const inputDigest = domainDigest('aether.embedding-input/1', { version: EMBEDDING_INPUT_VERSION, subject, contextDigest, text, structure });
      output.push({ format: EMBEDDING_INPUT_VERSION, entryId, scopeDigest: scopeId, subject, contextDigest, inputDigest, text, structure });
    }
  }
  return output.sort((a, b) => a.entryId < b.entryId ? -1 : 1);
}
