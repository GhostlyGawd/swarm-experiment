/**
 * Graph analysis over the roadmap.
 *
 * All of this exists so that the claims in `docs/ROADMAP.md` are derived
 * rather than asserted. A dependency graph written by hand in prose is prose;
 * one that a topological sort has to succeed on is a graph.
 */

import {
  CRITICAL_PATH, EPICS, FEATURES, FIRST_SLICE, SEQUENCING_RATIONALE,
  type Feature, type Size,
} from './features.ts';

export const byId = new Map<string, Feature>(FEATURES.map((f) => [f.id, f]));

/**
 * Every analysis takes the feature list as an argument, defaulting to the real
 * one. That is what lets `test/roadmap.test.ts` feed the validator a graph with
 * a deliberate cycle and confirm it objects — a checker nobody has ever seen
 * fail is not evidence of anything.
 */
const index = (features: readonly Feature[]): Map<string, Feature> =>
  features === FEATURES ? byId : new Map(features.map((f) => [f.id, f]));

/** Relative weight, for totals. Not an estimate in time. */
export const WEIGHT: Readonly<Record<Size, number>> = { S: 1, M: 3, L: 8, XL: 20 };

export interface GraphProblem {
  readonly kind: 'unknown_dependency' | 'self_dependency' | 'cycle' | 'unknown_epic';
  readonly detail: string;
}

/** Structural problems that make the graph meaningless. */
export function problems(features: readonly Feature[] = FEATURES): GraphProblem[] {
  const found: GraphProblem[] = [];
  const epics = new Set(EPICS.map((e) => e.id));
  const lookup = index(features);

  for (const feature of features) {
    if (!epics.has(feature.epic)) {
      found.push({ kind: 'unknown_epic', detail: `${feature.id} is in epic ${feature.epic}` });
    }
    for (const dep of [...feature.deps, ...(feature.degradedUntil ?? [])]) {
      if (dep === feature.id) {
        found.push({ kind: 'self_dependency', detail: `${feature.id} depends on itself` });
      } else if (!lookup.has(dep)) {
        found.push({ kind: 'unknown_dependency', detail: `${feature.id} -> ${dep}` });
      }
    }
  }

  for (const cycle of cycles(features)) {
    found.push({ kind: 'cycle', detail: cycle.join(' -> ') });
  }
  return found;
}

/** Every dependency cycle, as a list of ids. Empty when the graph is a DAG. */
export function cycles(features: readonly Feature[] = FEATURES): string[][] {
  const lookup = index(features);
  const found: string[][] = [];
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const seen = state.get(id);
    if (seen === 'done') return;
    if (seen === 'open') {
      found.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    state.set(id, 'open');
    stack.push(id);
    for (const dep of lookup.get(id)?.deps ?? []) {
      if (lookup.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const feature of features) visit(feature.id);
  return found;
}

/**
 * Wave number: 0 for a feature with no blockers, otherwise one more than the
 * deepest blocker. Features in the same wave can be built in parallel.
 */
export function waves(features: readonly Feature[] = FEATURES): Map<string, number> {
  const lookup = index(features);
  const depth = new Map<string, number>();
  const compute = (id: string, seen: ReadonlySet<string> = new Set()): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // a cycle; `problems()` reports it separately
    const feature = lookup.get(id);
    if (!feature) return 0;
    const next = new Set([...seen, id]);
    const value = feature.deps.length === 0
      ? 0
      : 1 + Math.max(...feature.deps.map((d) => compute(d, next)));
    depth.set(id, value);
    return value;
  };
  for (const feature of features) compute(feature.id);
  return depth;
}

/** Everything that transitively depends on `id`. */
export function dependents(id: string, features: readonly Feature[] = FEATURES): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const feature of features) {
      if (out.has(feature.id)) continue;
      if (feature.deps.some((d) => d === id || out.has(d))) {
        out.add(feature.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Everything `id` transitively requires. */
export function requirements(id: string, features: readonly Feature[] = FEATURES): Set<string> {
  const lookup = index(features);
  const out = new Set<string>();
  const walk = (current: string): void => {
    for (const dep of lookup.get(current)?.deps ?? []) {
      if (out.has(dep)) continue;
      out.add(dep);
      walk(dep);
    }
  };
  walk(id);
  return out;
}

/** Features whose blockers are all inside `have` (or which have none). */
export function ready(
  have: ReadonlySet<string> = new Set(),
  features: readonly Feature[] = FEATURES,
): Feature[] {
  return features.filter((f) => !have.has(f.id) && f.deps.every((d) => have.has(d)));
}

/** Ids in `slice` whose dependencies fall outside it. */
export function leaks(
  slice: readonly string[],
  features: readonly Feature[] = FEATURES,
): Array<{ id: string; missing: string[] }> {
  const lookup = index(features);
  const inside = new Set(slice);
  return slice
    .map((id) => ({
      id,
      missing: (lookup.get(id)?.deps ?? []).filter((d) => !inside.has(d)),
    }))
    .filter((entry) => entry.missing.length > 0);
}

export type LinkStrength = 'hard' | 'judgment';

/**
 * Classify each step of a claimed sequence.
 *
 * `hard` means the graph forces the order — the later item transitively
 * requires the earlier one. `judgment` means it does not, and the ordering is
 * an opinion. The point of separating them is that an opinion presented as a
 * constraint is the most expensive kind of roadmap error.
 */
export function classifySequence(
  path: readonly string[],
  features: readonly Feature[] = FEATURES,
): Array<{ from: string; to: string; strength: LinkStrength }> {
  const out: Array<{ from: string; to: string; strength: LinkStrength }> = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const from = path[i];
    const to = path[i + 1];
    out.push({
      from,
      to,
      strength: requirements(to, features).has(from) ? 'hard' : 'judgment',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const label = (f: Feature): string => `${f.id}[${f.id}: ${escapeMermaid(shorten(f.title))}]`;

function shorten(title: string): string {
  const cut = title.split(/[:—(]/)[0].trim();
  return cut.length > 42 ? `${cut.slice(0, 40)}…` : cut;
}

const escapeMermaid = (s: string): string =>
  s.replace(/["`*]/g, '').replace(/[[\]]/g, '').replace(/\|/g, '/');

/** A Mermaid diagram of the hard-dependency graph, grouped by epic. */
export function mermaid(): string {
  const lines = ['```mermaid', 'graph LR'];
  for (const epic of EPICS) {
    const members = FEATURES.filter((f) => f.epic === epic.id);
    if (members.length === 0) continue;
    lines.push(`  subgraph ${epic.id}["${escapeMermaid(epic.title)}"]`);
    for (const f of members) lines.push(`    ${label(f)}`);
    lines.push('  end');
  }
  for (const f of FEATURES) {
    for (const dep of f.deps) lines.push(`  ${dep} --> ${f.id}`);
    for (const dep of f.degradedUntil ?? []) lines.push(`  ${dep} -.->|degraded until| ${f.id}`);
  }
  lines.push('```');
  return lines.join('\n');
}

/** The whole generated section of `docs/ROADMAP.md`. */
export function renderGraphSection(): string {
  const depth = waves();
  const maxWave = Math.max(...depth.values());
  const lines: string[] = [];

  lines.push(
    'Solid arrows are **hard dependencies** — the target cannot be built until the',
    'source exists. Dotted arrows mean the target *can* ship but stays incomplete',
    'in a stated way until the source lands.',
    '',
    mermaid(),
    '',
    '### Waves',
    '',
    'Wave *n* is everything whose deepest blocker sits in wave *n − 1*. Items in the',
    'same wave have no dependency on each other and can proceed in parallel.',
    '',
  );

  for (let wave = 0; wave <= maxWave; wave++) {
    const members = FEATURES.filter((f) => depth.get(f.id) === wave);
    if (members.length === 0) continue;
    const weight = members.reduce((n, f) => n + WEIGHT[f.size], 0);
    lines.push(`**Wave ${wave}** — ${members.length} feature(s), weight ${weight}`);
    lines.push('');
    for (const f of members) {
      const blockers = f.deps.length ? ` ← ${f.deps.join(', ')}` : '';
      const degraded = f.degradedUntil?.length
        ? ` *(degraded until ${f.degradedUntil.join(', ')})*`
        : '';
      lines.push(`- \`${f.id}\` ${f.title} — **${f.size}**${blockers}${degraded}`);
    }
    lines.push('');
  }

  lines.push('### Weight by epic', '');
  lines.push('| Epic | Features | Weight | Blocked by another epic |');
  lines.push('|---|---|---|---|');
  for (const epic of EPICS) {
    const members = FEATURES.filter((f) => f.epic === epic.id);
    if (members.length === 0) continue;
    const weight = members.reduce((n, f) => n + WEIGHT[f.size], 0);
    const external = new Set<string>();
    for (const f of members) {
      for (const dep of f.deps) {
        const depEpic = byId.get(dep)?.epic;
        if (depEpic && depEpic !== epic.id) external.add(depEpic);
      }
    }
    lines.push(
      `| ${epic.id}. ${epic.title} | ${members.length} | ${weight} | ` +
        `${external.size ? [...external].sort().join(', ') : '—'} |`,
    );
  }
  lines.push('');

  const startable = ready(new Set());
  lines.push('### Startable today', '');
  lines.push(
    `${startable.length} of ${FEATURES.length} features have no blockers at all: ` +
      `${startable.map((f) => `\`${f.id}\``).join(', ')}.`,
    '',
  );

  return lines.join('\n');
}

/**
 * The ordering section: the recommended path with every step classified, and
 * the first slice with its closure property stated.
 */
export function renderOrderingSection(): string {
  const lines: string[] = [];
  const links = classifySequence(CRITICAL_PATH);

  lines.push(
    'The recommended build order is below. Each step is classified: a **hard',
    'dependency** is forced by the graph, a *sequencing judgment* is not, and is an',
    'opinion about what to learn first. Both are legitimate; conflating them is not.',
    '',
  );

  for (const link of links) {
    const from = byId.get(link.from)!;
    const to = byId.get(link.to)!;
    if (link.strength === 'hard') {
      lines.push(
        `- ${link.from} → ${link.to} — **hard dependency**: ` +
          `${to.title.split(/[:—(]/)[0].trim()} cannot be built until ` +
          `${from.title.split(/[:—(]/)[0].trim().toLowerCase()} exists.`,
      );
      continue;
    }
    const rationale = SEQUENCING_RATIONALE[`${link.from}->${link.to}`]
      ?? 'No rationale recorded.';
    lines.push(`- ${link.from} → ${link.to} — *sequencing judgment*: ${rationale}`);
  }

  const sliceWeight = FIRST_SLICE.reduce((n, id) => n + WEIGHT[byId.get(id)!.size], 0);
  lines.push(
    '',
    '### Recommended first slice',
    '',
    `\`${FIRST_SLICE.join('`, `')}\`  — weight ${sliceWeight}.`,
    '',
    'Make it a repository, and make proofs persist with it. The slice is **closed',
    'under dependencies**: nothing in it requires anything outside it, so it can be',
    'built and shipped without pulling in the rest of the roadmap. Together these',
    'turn three current claims — deduplication, lock-free writes, and an immutable',
    'audit trail — from in-memory properties into on-disk ones.',
    '',
  );
  return lines.join('\n');
}
