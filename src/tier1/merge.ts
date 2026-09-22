/**
 * Three-way AST graph unification (FR-1.1).
 *
 * Text merges fail because they reason about lines, which are an artifact of
 * how code is *rendered*, not of what it means. Two agents that reformat the
 * same untouched function collide; two agents that edit adjacent independent
 * statements also collide. Neither is a real conflict.
 *
 * Here, merging is a fold over the DAG. Because nodes are content-addressed,
 * "did this side change?" is a pointer comparison, and an untouched subtree of
 * any size compares in constant time. A conflict is reported as a *node* with
 * both candidate addresses, never as a marker spliced into a file.
 */

import { GraphStore, type Step } from './store.ts';
import {
  children,
  LINK_SCHEMA,
  linkGroups,
  scalarPayload,
  withLinkGroups,
  type FlatNode,
} from './ast.ts';
import { canonicalText } from './canonical.ts';
import type { NodeRef } from './ids.ts';

export interface MergeConflict {
  /** Path from the merge root to the contested node. */
  readonly path: readonly Step[];
  readonly base: NodeRef | null;
  readonly left: NodeRef | null;
  readonly right: NodeRef | null;
  readonly reason:
    | 'divergent_edit'
    | 'kind_mismatch'
    | 'payload_mismatch'
    | 'shape_mismatch'
    | 'delete_vs_edit';
  readonly detail: string;
}

export interface MergeResult {
  /** Merged root. Present even when conflicted: contested slots keep `left`. */
  readonly ref: NodeRef;
  readonly conflicts: readonly MergeConflict[];
  readonly clean: boolean;
  /** Nodes taken verbatim from one side because the other did not touch them. */
  readonly reusedSubtrees: number;
}

/** Longest common subsequence over refs, returned as index pairs. */
function lcs(a: readonly NodeRef[], b: readonly NodeRef[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return out;
}

interface Chunk {
  readonly base: readonly NodeRef[];
  readonly left: readonly NodeRef[];
  readonly right: readonly NodeRef[];
  readonly stable: boolean;
}

/**
 * diff3 chunking.
 *
 * Base elements matched by *both* sides are anchors. Everything between two
 * anchors is an unstable region that the caller must resolve; everything on an
 * anchor is stable and merges recursively.
 */
function chunk3(
  base: readonly NodeRef[],
  left: readonly NodeRef[],
  right: readonly NodeRef[],
): Chunk[] {
  const matchL = new Map(lcs(base, left));
  const matchR = new Map(lcs(base, right));
  const anchors = [...matchL.keys()].filter((k) => matchR.has(k)).sort((a, z) => a - z);

  const chunks: Chunk[] = [];
  let bi = 0;
  let li = 0;
  let ri = 0;

  const unstable = (bEnd: number, lEnd: number, rEnd: number) => {
    if (bEnd === bi && lEnd === li && rEnd === ri) return;
    chunks.push({
      base: base.slice(bi, bEnd),
      left: left.slice(li, lEnd),
      right: right.slice(ri, rEnd),
      stable: false,
    });
  };

  for (const k of anchors) {
    const lk = matchL.get(k)!;
    const rk = matchR.get(k)!;
    unstable(k, lk, rk);
    chunks.push({ base: [base[k]], left: [left[lk]], right: [right[rk]], stable: true });
    bi = k + 1;
    li = lk + 1;
    ri = rk + 1;
  }
  unstable(base.length, left.length, right.length);
  return chunks;
}

const sameList = (a: readonly NodeRef[], b: readonly NodeRef[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Merge `left` and `right`, both descended from `base`.
 *
 * The three fast paths at the top are what make this cheap: an unchanged side
 * is a single pointer comparison against an entire subtree.
 */
export function merge3(
  store: GraphStore,
  base: NodeRef,
  left: NodeRef,
  right: NodeRef,
): MergeResult {
  const conflicts: MergeConflict[] = [];
  let reused = 0;

  const go = (b: NodeRef, l: NodeRef, r: NodeRef, path: Step[]): NodeRef => {
    if (l === r) return l; // Both sides agree (including "neither touched it").
    if (b === l) {
      reused++;
      return r; // Only the right side moved.
    }
    if (b === r) {
      reused++;
      return l; // Only the left side moved.
    }

    const bn = store.get(b);
    const ln = store.get(l);
    const rn = store.get(r);

    if (ln.kind !== rn.kind) {
      conflicts.push({
        path, base: b, left: l, right: r,
        reason: 'kind_mismatch',
        detail: `left is ${ln.kind}, right is ${rn.kind}`,
      });
      return l;
    }

    const lPayload = canonicalText(scalarPayload(ln) as never);
    const rPayload = canonicalText(scalarPayload(rn) as never);
    if (lPayload !== rPayload) {
      const bPayload = canonicalText(scalarPayload(bn) as never);
      // One side may have left the payload alone; then the other side wins.
      if (bPayload === lPayload || bPayload === rPayload) {
        const winner = bPayload === lPayload ? rn : ln;
        return mergeChildren(bn, ln, rn, winner, path, b, l, r);
      }
      conflicts.push({
        path, base: b, left: l, right: r,
        reason: 'payload_mismatch',
        detail: `both sides rewrote ${ln.kind} differently: ${lPayload} vs ${rPayload}`,
      });
      return l;
    }
    return mergeChildren(bn, ln, rn, ln, path, b, l, r);
  };

  const mergeChildren = (
    bn: FlatNode,
    ln: FlatNode,
    rn: FlatNode,
    shape: FlatNode,
    path: Step[],
    b: NodeRef,
    l: NodeRef,
    r: NodeRef,
  ): NodeRef => {
    const bg = new Map(linkGroups(bn).map((g) => [g.field, g.links]));
    const lg = new Map(linkGroups(ln).map((g) => [g.field, g.links]));
    const rg = new Map(linkGroups(rn).map((g) => [g.field, g.links]));
    const out = new Map<string, NodeRef[]>();
    let ok = true;

    for (const { field, arity } of LINK_SCHEMA[shape.kind]) {
      const bl = bg.get(field) ?? [];
      const ll = lg.get(field) ?? [];
      const rl = rg.get(field) ?? [];

      const slot: NodeRef[] = [];
      out.set(field, slot);

      if (arity === 'one' || arity === 'opt' || arity === 'pairs') {
        // Fixed-arity slots merge positionally.
        if (ll.length !== rl.length) {
          conflicts.push({
            path, base: b, left: l, right: r,
            reason: 'delete_vs_edit',
            detail: `${shape.kind}.${field}: one side removed an optional child the other kept`,
          });
          ok = false;
          break;
        }
        for (let i = 0; i < ll.length; i++) {
          const baseChild = bl[i] ?? ll[i];
          slot.push(go(baseChild, ll[i], rl[i], [...path, { field, index: i }]));
        }
        continue;
      }

      // Variable-arity slots (statement lists, arguments, members) merge by diff3,
      // so independent insertions on both sides both survive.
      if (sameList(bl, ll)) {
        slot.push(...rl);
        reused += ll.length;
        continue;
      }
      if (sameList(bl, rl)) {
        slot.push(...ll);
        reused += rl.length;
        continue;
      }
      for (const c of chunk3(bl, ll, rl)) {
        if (c.stable) {
          const baseChild = c.base[0];
          slot.push(go(baseChild, c.left[0], c.right[0], [...path, { field, index: slot.length }]));
          continue;
        }
        if (sameList(c.left, c.right)) {
          slot.push(...c.left);
          continue;
        }
        if (sameList(c.base, c.left)) {
          slot.push(...c.right);
          continue;
        }
        if (sameList(c.base, c.right)) {
          slot.push(...c.left);
          continue;
        }
        // Both sides rewrote the same region of the same list.
        if (c.base.length === c.left.length && c.left.length === c.right.length) {
          for (let i = 0; i < c.left.length; i++) {
            slot.push(go(c.base[i], c.left[i], c.right[i], [...path, { field, index: slot.length }]));
          }
          continue;
        }
        conflicts.push({
          path, base: b, left: l, right: r,
          reason: 'divergent_edit',
          detail:
            `${shape.kind}.${field}: both agents rewrote the same ${c.base.length}-element region ` +
            `(left wrote ${c.left.length}, right wrote ${c.right.length})`,
        });
        slot.push(...c.left);
      }
    }

    if (!ok) return l;
    return store.put(withLinkGroups(shape as never, out as never) as unknown as FlatNode);
  };

  const ref = go(base, left, right, []);
  return { ref, conflicts, clean: conflicts.length === 0, reusedSubtrees: reused };
}

/** Did `candidate` descend from `ancestor` by edits confined to `subtree`? */
export function touches(store: GraphStore, root: NodeRef, target: NodeRef): boolean {
  return store.reachable(root).has(target);
}

export { children };
