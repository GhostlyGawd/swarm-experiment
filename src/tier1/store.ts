/**
 * The content-addressed AST DAG (FR-1.1).
 *
 * Two identities are computed for every node, and the distinction is the whole
 * design:
 *
 *   • `NodeRef`       — BLAKE3 over the node's own scalar payload plus the
 *                       *refs* of its children. This is the node's address.
 *                       It never mentions an identifier spelling, so renaming
 *                       is invisible to it.
 *   • `StructuralKey` — BLAKE3 over the alpha-normalized hydrated subtree, with
 *                       locally bound symbols replaced by binding-relative
 *                       indices. Two functions that differ only in their choice
 *                       of local names share a structural key. This is what
 *                       powers subtree deduplication (NFR 6.3) and lets the
 *                       three-way merge recognise "same shape, moved".
 */

import { blake3 } from './blake3.ts';
import { canonicalBytes, type Canonical } from './canonical.ts';
import {
  children,
  LINK_SCHEMA,
  linkGroups,
  scalarPayload,
  withChildren,
  type FlatNode,
  type NodeKind,
  type Term,
} from './ast.ts';
import {
  bytesToHexRef,
  type NodeRef,
  type StructuralKey,
  type SymbolId,
} from './ids.ts';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteOnce, encodeStored, readStored } from './persistence.ts';

/** Structured, unambiguous hash preimage for a stored node. */
function preimage(node: FlatNode): Canonical {
  return {
    k: node.kind,
    p: scalarPayload(node) as Canonical,
    // Grouped by field: a flat child list would conflate `While` shapes.
    c: linkGroups(node).map((g) => [g.field, g.links as readonly string[]] as const) as Canonical,
  };
}

/** The content address of a stored node. Pure function of its contents. */
export function hashNode(node: FlatNode): NodeRef {
  return bytesToHexRef(blake3(canonicalBytes(preimage(node))));
}

const SYMBOL_RE = /^sym:[a-z2-7]{22}$/;

/** Replace symbol ids appearing anywhere in a payload value. */
function mapSymbols(value: unknown, resolve: (s: SymbolId) => string): unknown {
  if (typeof value === 'string') {
    return SYMBOL_RE.test(value) ? resolve(value as SymbolId) : value;
  }
  if (Array.isArray(value)) return value.map((v) => mapSymbols(v, resolve));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = mapSymbols(v, resolve);
    }
    return out;
  }
  return value;
}

/** Node kinds that open a binding scope, and the symbols they bind. */
function boundSymbols(term: Term): readonly SymbolId[] {
  switch (term.kind) {
    case 'FunctionDecl':
      // The function's own symbol is bound first, so a recursive call inside
      // the body normalizes to the same index the declaration itself gets.
      return [
        term.symbol,
        ...term.params.map((p) => p.symbol),
        ...(term.surfaces
          .map((s) => (s.kind === 'Surface' ? s.symbol : null))
          .filter(Boolean) as SymbolId[]),
      ];
    case 'Module':
      // Pre-bind the module and every member name so mutual recursion between
      // members normalizes stably regardless of declaration order.
      return [
        term.symbol,
        ...(term.members
          .map((m) => ('symbol' in m ? (m.symbol as SymbolId) : null))
          .filter(Boolean) as SymbolId[]),
      ];
    case 'MatchResult':
      return [term.okSymbol, term.errSymbol];
    case 'Lambda':
      return term.params.map((param) => param.symbol);
    case 'ForAll': return [term.symbol];
    default:
      return [];
  }
}

const SCOPE_OPENERS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'FunctionDecl', 'Module', 'Block', 'MatchResult', 'Lambda', 'ForAll',
]);

/**
 * Alpha-normalized canonical form: locally bound symbols become `#0`, `#1`, …
 * in first-binding order. Free symbols keep their opaque ids, since they refer
 * to something outside the subtree and are therefore part of its meaning.
 */
export function alphaNormalize(term: Term): Canonical {
  const scopes: Array<Map<SymbolId, string>> = [new Map()];
  let counter = 0;

  const resolve = (s: SymbolId): string => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const hit = scopes[i].get(s);
      if (hit !== undefined) return hit;
    }
    return s;
  };
  const bind = (s: SymbolId): void => {
    scopes[scopes.length - 1].set(s, `#${counter++}`);
  };

  const norm = (t: Term): Canonical => {
    // A symbol table is naming, not structure: two modules that differ only in
    // what they call things must normalize identically.
    if (t.kind === 'SymbolTable') return { k: 'SymbolTable' };

    const opens = SCOPE_OPENERS.has(t.kind);
    if (opens) scopes.push(new Map());
    try {
      for (const s of boundSymbols(t)) bind(s);
      // `Let` binds for the *remainder* of its enclosing block, so it is bound
      // as the block walks over it rather than up front.
      const groups = linkGroups(t).map((g) => {
        if (t.kind === 'Block' && g.field === 'stmts') {
          return [
            g.field,
            g.links.map((stmt) => {
              if (stmt.kind === 'Let') bind(stmt.symbol);
              return norm(stmt);
            }),
          ] as const;
        }
        return [g.field, g.links.map(norm)] as const;
      });
      return {
        k: t.kind,
        p: mapSymbols(scalarPayload(t), resolve) as Canonical,
        c: groups as Canonical,
      };
    } finally {
      if (opens) scopes.pop();
    }
  };

  return norm(term);
}

export function structuralKeyOf(term: Term): StructuralKey {
  return bytesToHexRef(blake3(canonicalBytes(alphaNormalize(term))), 'struct:b3:') as string as StructuralKey;
}

/** A step down into a node: which link field, and which slot within it. */
export interface Step {
  readonly field: string;
  readonly index: number;
}

export interface StoreStats {
  /** Distinct nodes actually persisted. */
  readonly physicalNodes: number;
  /** Node occurrences across all interned trees, counting shared subtrees once per use. */
  readonly logicalNodes: number;
  /** Fraction of occurrences served by a shared node. */
  readonly dedupRatio: number;
  /** Structural keys computed so far. Keys are calculated lazily, on demand. */
  readonly structuralKeysComputed: number;
}

export interface GraphStoreOptions {
  /** Directory containing the durable object database. Omit for memory-only use. */
  readonly directory?: string;
}

/**
 * An immutable content-addressed node store.
 *
 * Writes are idempotent and commutative, which is what lets 1,000 agents mutate
 * disjoint subtrees without a lock (NFR 6.3): two writers that produce the same
 * node produce the same address, and a writer never mutates an existing entry.
 */
export class GraphStore {
  private readonly nodes = new Map<NodeRef, FlatNode>();
  private readonly structural = new Map<NodeRef, StructuralKey>();
  private readonly byStructure = new Map<StructuralKey, Set<NodeRef>>();
  /** child -> parents, for invalidation propagation (FR-1.3). */
  private readonly parents = new Map<NodeRef, Set<NodeRef>>();
  private logicalWrites = 0;
  private readonly objectDirectory: string | null;

  constructor(opts: GraphStoreOptions = {}) {
    this.objectDirectory = opts.directory ? join(opts.directory, 'objects') : null;
    if (this.objectDirectory) mkdirSync(this.objectDirectory, { recursive: true });
  }

  get size(): number {
    return this.objectDirectory ? this.listRefs().length : this.nodes.size;
  }

  has(ref: NodeRef): boolean {
    return this.nodes.has(ref) || (this.objectDirectory !== null && existsSync(this.objectPath(ref)));
  }

  private objectPath(ref: NodeRef): string {
    if (!this.objectDirectory) throw new Error('this GraphStore is memory-only');
    const digest = ref.slice(ref.lastIndexOf(':') + 1);
    return join(this.objectDirectory, digest.slice(0, 2), `${digest.slice(2)}.json`);
  }

  /** Every durable or cached object address. */
  listRefs(): NodeRef[] {
    if (!this.objectDirectory) return [...this.nodes.keys()];
    const refs: NodeRef[] = [];
    if (!existsSync(this.objectDirectory)) return refs;
    for (const shard of readdirSync(this.objectDirectory, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
      const directory = join(this.objectDirectory, shard.name);
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (!file.isFile() || !/^[0-9a-f]{62}\.json$/.test(file.name)) continue;
        refs.push(`ast:b3:${shard.name}${file.name.slice(0, -5)}` as NodeRef);
      }
    }
    return refs.sort();
  }

  /** Persist a flat node, returning its address. Idempotent. */
  put(node: FlatNode): NodeRef {
    const ref = hashNode(node);
    this.logicalWrites++;
    if (this.has(ref)) return ref;
    this.nodes.set(ref, node);
    if (this.objectDirectory) atomicWriteOnce(this.objectPath(ref), encodeStored(node));
    for (const child of children(node)) {
      let set = this.parents.get(child);
      if (!set) this.parents.set(child, (set = new Set()));
      set.add(ref);
    }
    return ref;
  }

  get(ref: NodeRef): FlatNode {
    let node = this.nodes.get(ref);
    if (!node && this.objectDirectory && existsSync(this.objectPath(ref))) {
      node = readStored<FlatNode>(this.objectPath(ref));
      if (hashNode(node) !== ref) throw new Error(`corrupt object ${ref}: content hash does not match its address`);
      this.nodes.set(ref, node);
      for (const child of children(node)) {
        let set = this.parents.get(child);
        if (!set) this.parents.set(child, (set = new Set()));
        set.add(ref);
      }
    }
    if (!node) throw new ReferenceError(`unknown node ${ref}`);
    return node;
  }

  parentsOf(ref: NodeRef): readonly NodeRef[] {
    // A fresh process has no reverse index yet. Hydrating every durable object
    // once reconstructs it without giving up the read-through cache for normal
    // point lookups.
    if (this.objectDirectory) for (const candidate of this.listRefs()) this.get(candidate);
    return [...(this.parents.get(ref) ?? [])];
  }

  /** Delete a durable object. Repository GC is the only intended caller. */
  delete(ref: NodeRef): boolean {
    const cached = this.nodes.delete(ref);
    this.structural.delete(ref);
    if (!this.objectDirectory || !existsSync(this.objectPath(ref))) return cached;
    unlinkSync(this.objectPath(ref));
    return true;
  }

  /**
   * Flatten a hydrated tree into the DAG, bottom-up.
   *
   * Structural keys are deliberately *not* computed here. Alpha-normalization
   * has to see a whole subtree at once, so doing it per node during interning
   * makes a write quadratic in the size of the tree. Dedup analytics and
   * alpha-equivalence queries are rare and can pay for themselves on demand;
   * writes are the hot path and cannot.
   */
  intern(term: Term): NodeRef {
    const childRefs = children(term).map((c) => this.intern(c));
    const flat = withChildren(term as never, childRefs as never) as unknown as FlatNode;
    return this.put(flat);
  }

  /** Inflate a stored node back into a hydrated tree. */
  hydrate(ref: NodeRef): Term {
    const flat = this.get(ref);
    const kids = children(flat).map((c) => this.hydrate(c));
    return withChildren(flat as never, kids as never) as unknown as Term;
  }

  structuralKey(ref: NodeRef): StructuralKey {
    const cached = this.structural.get(ref);
    if (cached) return cached;
    const key = structuralKeyOf(this.hydrate(ref));
    this.structural.set(ref, key);
    let set = this.byStructure.get(key);
    if (!set) this.byStructure.set(key, (set = new Set()));
    set.add(ref);
    return key;
  }

  /**
   * Index every node's structural key. O(n * subtree size); call it when you
   * actually want a repository-wide alpha-equivalence report, not per write.
   */
  indexStructures(): number {
    for (const ref of this.nodes.keys()) this.structuralKey(ref);
    return this.byStructure.size;
  }

  /** Every node sharing a structural key — alpha-equivalent code, anywhere. */
  alphaEquivalents(ref: NodeRef): readonly NodeRef[] {
    return [...(this.byStructure.get(this.structuralKey(ref)) ?? [])];
  }

  /** Follow a path from `root`, returning the ref at each step (inclusive). */
  resolvePath(root: NodeRef, path: readonly Step[]): readonly NodeRef[] {
    const chain: NodeRef[] = [root];
    let cur = root;
    for (const step of path) {
      const group = linkGroups(this.get(cur)).find((g) => g.field === step.field);
      if (!group) throw new ReferenceError(`${this.get(cur).kind} has no link field ${step.field}`);
      const next = group.links[step.index];
      if (next === undefined) {
        throw new RangeError(`${this.get(cur).kind}.${step.field}[${step.index}] is out of range`);
      }
      chain.push(next);
      cur = next;
    }
    return chain;
  }

  /**
   * Structural mutation as a hash-tree update (FR-1.1).
   *
   * Only the spine from `root` to the edited position is rewritten — `path.length`
   * new nodes, regardless of how large the tree is. Every sibling subtree keeps
   * its address, so downstream verification and compilation caches keyed on
   * those addresses stay warm.
   */
  replaceAt(root: NodeRef, path: readonly Step[], replacement: NodeRef): NodeRef {
    const chain = this.resolvePath(root, path);
    let next = replacement;
    for (let i = path.length - 1; i >= 0; i--) {
      const parent = this.get(chain[i]);
      const step = path[i];
      const groups = linkGroups(parent);
      const flatIndex =
        groups
          .slice(0, groups.findIndex((g) => g.field === step.field))
          .reduce((n, g) => n + g.links.length, 0) + step.index;
      const kids = [...children(parent)];
      kids[flatIndex] = next;
      next = this.put(withChildren(parent as never, kids as never) as unknown as FlatNode);
    }
    return next;
  }

  /** Find the first path (pre-order) to a node satisfying `pred`. */
  findPath(root: NodeRef, pred: (node: FlatNode, ref: NodeRef) => boolean): Step[] | null {
    const search = (ref: NodeRef, acc: Step[]): Step[] | null => {
      const node = this.get(ref);
      if (pred(node, ref)) return acc;
      for (const group of linkGroups(node)) {
        for (let i = 0; i < group.links.length; i++) {
          const hit = search(group.links[i], [...acc, { field: group.field, index: i }]);
          if (hit) return hit;
        }
      }
      return null;
    };
    return search(root, []);
  }

  /** Transitive closure of a root's subtree. */
  reachable(root: NodeRef): Set<NodeRef> {
    const seen = new Set<NodeRef>();
    const stack = [root];
    while (stack.length) {
      const ref = stack.pop()!;
      if (seen.has(ref)) continue;
      seen.add(ref);
      for (const child of children(this.get(ref))) stack.push(child);
    }
    return seen;
  }

  stats(): StoreStats {
    return {
      physicalNodes: this.nodes.size,
      logicalNodes: this.logicalWrites,
      dedupRatio: this.logicalWrites === 0 ? 0 : 1 - this.nodes.size / this.logicalWrites,
      structuralKeysComputed: this.byStructure.size,
    };
  }

  /** Every stored node kind, for reporting. */
  kindHistogram(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const node of this.nodes.values()) out[node.kind] = (out[node.kind] ?? 0) + 1;
    return out;
  }
}

export { LINK_SCHEMA };
