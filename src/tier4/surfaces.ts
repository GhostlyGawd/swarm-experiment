/**
 * Differentiable code optimization surfaces (FR-4.2).
 *
 * A `Surface` node is a hole in the program that a background agent is allowed
 * to fill: a cache policy, a buffer size, a thread-pool width, an index
 * choice. The author states the *shape* of the decision — its domain and what
 * it is being optimized for — and declines to state the answer, because the
 * answer depends on production traffic nobody had when the code was written.
 *
 * "Differentiable" needs an honest gloss. The objective here is a measurement,
 * not an analytic function: there is no true derivative to take. What the
 * tuner does is estimate a gradient by finite differences on the range
 * surfaces and do coordinate descent on the discrete ones, then step against
 * it. That is the same machinery a gradient method uses, applied to a black
 * box, and it is bounded by an evaluation budget because every evaluation
 * costs a real measurement.
 *
 * Two guardrails matter more than the search:
 *
 *   • A tuner may only rewrite `Surface` nodes. Because a surface is its own
 *     content-addressed node, "only parameters changed" is verifiable by
 *     comparing addresses rather than trusted by convention.
 *   • A tuned module is re-verified before it is adopted. A configuration that
 *     is faster and wrong is not an improvement.
 */

import { children, linkGroups, type Term } from '../tier1/ast.ts';
import type { NodeRef, SymbolId } from '../tier1/ids.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import { GraphStore, type Step } from '../tier1/store.ts';

export type SurfaceValue = string | bigint;
export type Assignment = ReadonlyMap<SymbolId, SurfaceValue>;

export interface Measurement {
  readonly latencyMs: number;
  readonly costPerMonth: number;
  readonly memoryMb: number;
}

/**
 * Where the numbers come from. In production this is a telemetry query; in a
 * test it is a model. Either way the tuner only ever sees measurements, never
 * an analytic objective it could cheat on.
 */
export interface Objective {
  measure(assignment: Assignment): Measurement;
}

const OBJECTIVE_FIELD = {
  minimize_latency: 'latencyMs',
  minimize_cost: 'costPerMonth',
  minimize_memory: 'memoryMb',
} as const;

export interface SurfaceInfo {
  readonly symbol: SymbolId;
  readonly node: Extract<Term, { kind: 'Surface' }>;
  readonly path: readonly Step[];
}

/** Every tunable surface in a module, with the path needed to rewrite it. */
export function findSurfaces(store: GraphStore, root: NodeRef): SurfaceInfo[] {
  const out: SurfaceInfo[] = [];
  const walk = (ref: NodeRef, path: Step[]): void => {
    const node = store.get(ref);
    if (node.kind === 'Surface') {
      out.push({ symbol: node.symbol, node: store.hydrate(ref) as SurfaceInfo['node'], path });
      return;
    }
    for (const group of linkGroups(store.get(ref))) {
      group.links.forEach((child, index) => {
        walk(child, [...path, { field: group.field, index }]);
      });
    }
  };
  walk(root, []);
  return out;
}

/** Enumerate a surface's domain as a discrete grid. */
export function domainValues(node: Extract<Term, { kind: 'Surface' }>): SurfaceValue[] {
  if (node.domain.d === 'choice') return [...node.domain.options];
  const { min, max, step } = node.domain;
  const out: bigint[] = [];
  for (let v = min; v <= max; v += step === 0n ? 1n : step) out.push(v);
  return out;
}

export interface TuningStep {
  readonly evaluation: number;
  readonly symbol: SymbolId;
  readonly from: SurfaceValue;
  readonly to: SurfaceValue;
  readonly score: number;
  /** Finite-difference slope that motivated the step, where one applies. */
  readonly gradient: number | null;
}

export interface TuningResult {
  readonly before: Assignment;
  readonly after: Assignment;
  readonly baseline: Measurement;
  readonly tuned: Measurement;
  /** Fractional improvement in the objective. Negative means it got worse. */
  readonly improvement: number;
  readonly evaluations: number;
  readonly history: readonly TuningStep[];
  readonly converged: boolean;
}

export interface TuneOptions {
  /** Hard ceiling on measurements, because each one costs real traffic. */
  readonly maxEvaluations?: number;
  readonly symbols?: SymbolSpace;
}

/**
 * Tune a module's surfaces against a measured objective.
 *
 * Surfaces sharing an objective are optimized together: the score is their
 * summed measurement, so the search sees the whole cost surface rather than
 * chasing one parameter into a corner the others have to pay for.
 */
export function tune(
  surfaces: readonly SurfaceInfo[],
  objective: Objective,
  opts: TuneOptions = {},
): TuningResult {
  const budget = opts.maxEvaluations ?? 200;
  const current = new Map<SymbolId, SurfaceValue>(
    surfaces.map((s) => [s.symbol, s.node.current]),
  );
  const before: Assignment = new Map(current);

  let evaluations = 0;
  const cache = new Map<string, Measurement>();
  const key = (a: Assignment) =>
    [...a.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('|');

  const measure = (a: Assignment): Measurement => {
    const k = key(a);
    const hit = cache.get(k);
    if (hit) return hit;
    evaluations++;
    const m = objective.measure(a);
    cache.set(k, m);
    return m;
  };

  /** The scalar the search descends: each surface's own stated objective. */
  const score = (a: Assignment): number => {
    const m = measure(a);
    let total = 0;
    for (const surface of surfaces) total += m[OBJECTIVE_FIELD[surface.node.objective]];
    return total;
  };

  const baseline = measure(before);
  let best = score(before);
  const history: TuningStep[] = [];
  let converged = false;

  for (let round = 0; round < 32; round++) {
    let improved = false;

    for (const surface of surfaces) {
      if (evaluations >= budget) break;
      const values = domainValues(surface.node);
      const currentValue = current.get(surface.symbol)!;
      const index = values.findIndex((v) => v === currentValue);

      let candidates: SurfaceValue[];
      let gradient: number | null = null;

      if (surface.node.domain.d === 'choice') {
        // No ordering to exploit: try every option.
        candidates = values.filter((v) => v !== currentValue);
      } else {
        // Estimate the local slope, then step downhill by a decaying amount.
        const at = (i: number): number | null => {
          if (i < 0 || i >= values.length) return null;
          const probe = new Map(current);
          probe.set(surface.symbol, values[i]);
          return score(probe);
        };
        const left = at(index - 1);
        const right = at(index + 1);
        if (left !== null && right !== null) gradient = (right - left) / 2;
        else if (right !== null) gradient = right - best;
        else if (left !== null) gradient = best - left;

        const direction = gradient === null ? 0 : gradient > 0 ? -1 : 1;
        const strides = [1, 2, 4, 8, 16].map((s) => index + direction * s);
        candidates = strides
          .filter((i) => i >= 0 && i < values.length)
          .map((i) => values[i])
          .filter((v) => v !== currentValue);
        // Keep both neighbours in play so a flat spot is still explored.
        for (const i of [index - 1, index + 1]) {
          if (i >= 0 && i < values.length && !candidates.includes(values[i])) {
            candidates.push(values[i]);
          }
        }
      }

      for (const candidate of candidates) {
        if (evaluations >= budget) break;
        const probe = new Map(current);
        probe.set(surface.symbol, candidate);
        const probeScore = score(probe);
        if (probeScore >= best) continue;
        history.push({
          evaluation: evaluations,
          symbol: surface.symbol,
          from: current.get(surface.symbol)!,
          to: candidate,
          score: probeScore,
          gradient,
        });
        current.set(surface.symbol, candidate);
        best = probeScore;
        improved = true;
      }
    }

    if (!improved) {
      converged = true;
      break;
    }
    if (evaluations >= budget) break;
  }

  const tuned = measure(current);
  const baselineScore = surfaces.reduce(
    (n, s) => n + baseline[OBJECTIVE_FIELD[s.node.objective]],
    0,
  );
  return {
    before,
    after: new Map(current),
    baseline,
    tuned,
    improvement: baselineScore === 0 ? 0 : (baselineScore - best) / baselineScore,
    evaluations,
    history,
    converged,
  };
}

export interface ApplyResult {
  readonly root: NodeRef;
  /** Node addresses that changed. Should contain only Surface nodes and spines. */
  readonly rewritten: readonly NodeRef[];
  readonly unchanged: boolean;
}

/**
 * Write a tuned assignment back into the graph.
 *
 * Each surface is replaced through `replaceAt`, so only the spine from the
 * module root to that parameter is rewritten. Everything else keeps its
 * address, which is what lets the verification results computed before tuning
 * remain valid for every subtree the tuner did not touch.
 */
export function applyTuning(
  store: GraphStore,
  root: NodeRef,
  assignment: Assignment,
): ApplyResult {
  let current = root;
  const rewritten: NodeRef[] = [];

  for (const [symbol, value] of assignment) {
    // Re-find the surface each time: the path shifts as the spine is rebuilt.
    const surfaces = findSurfaces(store, current);
    const target = surfaces.find((s) => s.symbol === symbol);
    if (!target) continue;
    if (target.node.current === value) continue;

    const replacement = store.intern({ ...target.node, current: value });
    rewritten.push(replacement);
    current = store.replaceAt(current, target.path, replacement);
  }

  return { root: current, rewritten, unchanged: current === root };
}

/**
 * Confirm a tuning pass changed parameters and nothing else.
 *
 * This is the property content addressing makes cheap: every node reachable
 * from the new root is either reachable from the old one, or is a `Surface`,
 * or is on the spine leading to one. Anything else means the tuner overstepped.
 */
export function verifyOnlyParametersChanged(
  store: GraphStore,
  before: NodeRef,
  after: NodeRef,
): { ok: boolean; offending: readonly string[] } {
  const oldNodes = store.reachable(before);
  const newNodes = store.reachable(after);
  const added = [...newNodes].filter((n) => !oldNodes.has(n));

  const spine = new Set<NodeRef>();
  for (const ref of added) {
    const node = store.get(ref);
    if (node.kind === 'Surface') continue;
    // A rebuilt spine node must have at least one child that is itself new.
    const hasNewChild = children(node).some((c) => added.includes(c));
    if (hasNewChild) {
      spine.add(ref);
      continue;
    }
  }

  const offending = added
    .filter((ref) => store.get(ref).kind !== 'Surface' && !spine.has(ref))
    .map((ref) => `${store.get(ref).kind} ${ref}`);

  return { ok: offending.length === 0, offending };
}
