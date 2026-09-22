/**
 * The fluid architectural topology engine (FR-4.1).
 *
 * Agents author one semantic graph of capability-gated functions. Where those
 * functions *run* — one binary, a set of containers, an edge worker — is a
 * compilation decision, taken from measured traffic rather than from an
 * architecture diagram drawn before any of it existed.
 *
 * The slicer works in three stages:
 *
 *   1. **Seed.** Every function starts in its own unit. Placement constraints
 *      are derived from capabilities, not from annotations: something holding
 *      `cap:db:*` cannot be an edge worker, something holding only
 *      `cap:pure:compute` can go anywhere.
 *   2. **Agglomerate.** Merge the pair of units with the heaviest interconnect,
 *      repeatedly, while merging is legal and pays for itself. This is the
 *      PRD's recombination rule: two services that talk constantly become one
 *      in-process shared-memory domain, with no refactor, because there was
 *      never any transport in the source to remove.
 *   3. **Cost.** Price the result. A cross-unit call pays serialization and a
 *      network hop; an in-process call pays neither. Every plan carries its
 *      own estimate, so "monolith or services?" is answered by a number rather
 *      than by taste.
 *
 * Splitting is the same algorithm run against a different constraint set: when
 * a unit exceeds its footprint budget, the lightest interconnect inside it is
 * cut.
 */

import type { Term } from '../tier1/ast.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';

export type TargetShape = 'single_binary' | 'containers' | 'edge_workers' | 'auto';

/** Measured traffic on one call edge. */
export interface EdgeTelemetry {
  readonly from: SymbolId;
  readonly to: SymbolId;
  /** Calls per second, measured in production. */
  readonly callsPerSecond: number;
  /** Mean payload size across the call boundary, in bytes. */
  readonly payloadBytes: number;
}

export interface FunctionTelemetry {
  readonly symbol: SymbolId;
  /** Mean self time per invocation, excluding callees. */
  readonly selfMs: number;
  /** Resident footprint when hot, in megabytes. */
  readonly memoryMb: number;
}

export interface Telemetry {
  readonly edges: readonly EdgeTelemetry[];
  readonly functions: readonly FunctionTelemetry[];
}

/** What it costs to put a boundary between two functions. */
export interface CostModel {
  /** One-way network latency across a unit boundary. */
  readonly hopLatencyMs: number;
  /** Throughput of the interconnect. */
  readonly bandwidthMbPerSecond: number;
  /** Fixed serialization overhead per cross-unit call. */
  readonly serializationMs: number;
  /** Monthly cost of running one unit at all. */
  readonly unitBaseCost: number;
  /** Monthly cost per megabyte of resident footprint. */
  readonly costPerMbMonth: number;
  /** Largest footprint a single unit may reach. */
  readonly maxUnitMemoryMb: number;
}

export const DEFAULT_COST_MODEL: CostModel = {
  hopLatencyMs: 0.9,
  bandwidthMbPerSecond: 1000,
  serializationMs: 0.15,
  unitBaseCost: 24,
  costPerMbMonth: 0.11,
  maxUnitMemoryMb: 2048,
};

/**
 * Where a unit *runs*. It says nothing about calls inside the unit: every unit
 * is a single in-process shared-memory domain by construction, so a call
 * between two of its members is a direct invocation whatever the placement.
 * `linked` means statically linked into one binary with everything else.
 */
export type Placement = 'linked' | 'container' | 'edge';

export interface Unit {
  readonly id: string;
  readonly members: readonly SymbolId[];
  readonly capabilities: readonly CapabilityName[];
  readonly placement: Placement;
  readonly memoryMb: number;
}

export interface CrossUnitEdge extends EdgeTelemetry {
  readonly fromUnit: string;
  readonly toUnit: string;
  readonly latencyMsPerSecond: number;
}

export interface TopologyPlan {
  readonly shape: TargetShape;
  readonly units: readonly Unit[];
  readonly crossEdges: readonly CrossUnitEdge[];
  /** Aggregate transport latency per second of traffic. */
  readonly transportLatencyMsPerSecond: number;
  readonly monthlyCost: number;
  /** Merges performed, in order, with the traffic that justified each. */
  readonly recombinations: readonly string[];
  /** Constraints that prevented a merge the traffic would otherwise justify. */
  readonly blockedMerges: readonly string[];
  /** Retained so live movement cannot discard the slicer's safety constraints. */
  readonly constraints?: {
    readonly cost: CostModel;
    readonly isolate: readonly CapabilityName[];
    readonly concurrencyGroups: readonly (readonly SymbolId[])[];
    readonly functionMemory: readonly (readonly [SymbolId, number])[];
    readonly edges: readonly EdgeTelemetry[];
  };
}

/** Capability domains that cannot run at the edge. */
const EDGE_FORBIDDEN_DOMAINS: ReadonlySet<string> = new Set(['db', 'fs', 'secrets']);

function placementFor(capabilities: readonly CapabilityName[], shape: TargetShape): Placement {
  if (shape === 'single_binary') return 'linked';
  if (shape === 'containers') return 'container';
  const domains = capabilities.map((c) => c.split(':')[1]);
  if (shape === 'edge_workers') {
    return domains.some((d) => EDGE_FORBIDDEN_DOMAINS.has(d)) ? 'container' : 'edge';
  }
  if (capabilities.length === 0) return 'edge';
  return domains.some((d) => EDGE_FORBIDDEN_DOMAINS.has(d)) ? 'container' : 'edge';
}

/** Read the call graph out of the module rather than out of a config file. */
export function callGraph(module: Term): Map<SymbolId, Set<SymbolId>> {
  const out = new Map<SymbolId, Set<SymbolId>>();
  const members = module.kind === 'Module' ? module.members : [module];
  for (const member of members) {
    if (member.kind !== 'FunctionDecl') continue;
    const callees = new Set<SymbolId>();
    const visit = (t: Term): void => {
      if (t.kind === 'Call') callees.add(t.callee);
      for (const value of Object.values(t as unknown as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === 'object' && 'kind' in item) visit(item as Term);
          }
        } else if (value && typeof value === 'object' && 'kind' in value) {
          visit(value as Term);
        }
      }
    };
    if (member.contract) visit(member.contract);
    if (member.body) visit(member.body);
    out.set(member.symbol, callees);
  }
  return out;
}

interface WorkingUnit {
  id: string;
  members: SymbolId[];
  capabilities: Set<CapabilityName>;
  memoryMb: number;
}

export interface SliceOptions {
  readonly shape?: TargetShape;
  readonly cost?: CostModel;
  readonly symbols?: SymbolSpace;
  /**
   * Merge two units when co-locating them saves more transport latency per
   * second than the merge costs. Raising it favours smaller services.
   */
  readonly mergeThresholdMsPerSecond?: number;
  /** Capabilities that must not share a unit with anything else. */
  readonly isolate?: readonly CapabilityName[];
  /** Race findings that require all named functions to share one single-writer unit. */
  readonly concurrencyFindings?: readonly ConcurrencyFinding[];
}

export interface ConcurrencyFinding {
  readonly symbols: readonly SymbolId[];
  readonly reason: string;
}

/**
 * Compile a semantic graph into a deployment topology.
 *
 * `shape: 'auto'` is the interesting case: the slicer picks per unit, so a
 * single system can be a binary at its core and edge workers at its rim
 * without anyone having written that down.
 */
export function slice(
  module: Term,
  telemetry: Telemetry,
  opts: SliceOptions = {},
): TopologyPlan {
  const shape = opts.shape ?? 'auto';
  const cost = opts.cost ?? DEFAULT_COST_MODEL;
  const isolate = new Set(opts.isolate ?? []);
  const threshold = opts.mergeThresholdMsPerSecond ?? 1;
  const forced = new Map<string, string>();
  const effectiveEdges: EdgeTelemetry[] = [...telemetry.edges];
  for (const finding of opts.concurrencyFindings ?? []) {
    const [first, ...rest] = finding.symbols;
    if (!first) continue;
    for (const symbol of rest) {
      effectiveEdges.push({ from: first, to: symbol, callsPerSecond: Number.MAX_VALUE, payloadBytes: 0 });
      forced.set(`${first}\0${symbol}`, finding.reason);
    }
  }

  const members = module.kind === 'Module' ? module.members : [module];
  const declarations = new Map<SymbolId, Extract<Term, { kind: 'FunctionDecl' }>>();
  for (const m of members) if (m.kind === 'FunctionDecl') declarations.set(m.symbol, m);

  const memoryOf = new Map<SymbolId, number>();
  for (const f of telemetry.functions) memoryOf.set(f.symbol, f.memoryMb);

  const name = (s: SymbolId) => opts.symbols?.nameOf(s) ?? s;

  // --- 1. seed -------------------------------------------------------------
  let units: WorkingUnit[] = [...declarations.values()].map((decl) => ({
    id: name(decl.symbol),
    members: [decl.symbol],
    capabilities: new Set(decl.capabilities),
    memoryMb: memoryOf.get(decl.symbol) ?? 16,
  }));

  const unitOf = new Map<SymbolId, WorkingUnit>();
  for (const unit of units) for (const m of unit.members) unitOf.set(m, unit);

  const latencyOf = (edge: EdgeTelemetry): number => {
    const transferMs = (edge.payloadBytes / (cost.bandwidthMbPerSecond * 1_000_000)) * 1000;
    return edge.callsPerSecond * (2 * cost.hopLatencyMs + cost.serializationMs + transferMs);
  };

  const recombinations: string[] = [];
  const blockedMerges: string[] = [];

  if (shape === 'single_binary') {
    const all: WorkingUnit = {
      id: 'monolith',
      members: [...declarations.keys()],
      capabilities: new Set([...declarations.values()].flatMap((d) => [...d.capabilities])),
      memoryMb: [...declarations.keys()].reduce((n, s) => n + (memoryOf.get(s) ?? 16), 0),
    };
    units = [all];
    for (const m of all.members) unitOf.set(m, all);
    recombinations.push('shape=single_binary: every function placed in one process');
  } else {
    // --- 2. agglomerate ----------------------------------------------------
    for (;;) {
      let best: { a: WorkingUnit; b: WorkingUnit; saving: number } | null = null;

      for (const edge of effectiveEdges) {
        const a = unitOf.get(edge.from);
        const b = unitOf.get(edge.to);
        if (!a || !b || a === b) continue;

        const saving = latencyOf(edge);
        if (saving <= threshold) continue;

        const reason = mergeBlockedBecause(a, b, cost, isolate);
        if (reason) {
          const note = `${a.id} + ${b.id}: ${reason} (would save ${saving.toFixed(1)}ms/s)`;
          if (!blockedMerges.includes(note)) blockedMerges.push(note);
          continue;
        }
        if (!best || saving > best.saving) best = { a, b, saving };
      }

      if (!best) break;
      const merged: WorkingUnit = {
        id: `${best.a.id}+${best.b.id}`,
        members: [...best.a.members, ...best.b.members],
        capabilities: new Set([...best.a.capabilities, ...best.b.capabilities]),
        memoryMb: best.a.memoryMb + best.b.memoryMb,
      };
      units = units.filter((u) => u !== best!.a && u !== best!.b);
      units.push(merged);
      for (const m of merged.members) unitOf.set(m, merged);
      recombinations.push(
        forced.get(`${best.a.members[0]}\0${best.b.members[0]}`)
          ? `${best.a.id} and ${best.b.id} share a concurrency finding; recombined into one single-writer domain`
          : `${best.a.id} and ${best.b.id} exchanged ${best.saving.toFixed(1)}ms/s of transport; ` +
            'recombined into one in-process shared-memory domain',
      );
    }
  }

  // --- 3. cost -------------------------------------------------------------
  const finalUnits: Unit[] = units.map((u) => ({
    id: u.id,
    members: u.members,
    capabilities: [...u.capabilities].sort(),
    placement: units.length === 1 && shape !== 'containers' && shape !== 'edge_workers'
      ? 'linked'
      : placementFor([...u.capabilities], shape),
    memoryMb: u.memoryMb,
  }));

  const crossEdges: CrossUnitEdge[] = [];
  for (const edge of telemetry.edges) {
    const a = unitOf.get(edge.from);
    const b = unitOf.get(edge.to);
    if (!a || !b || a === b) continue;
    crossEdges.push({
      ...edge,
      fromUnit: a.id,
      toUnit: b.id,
      latencyMsPerSecond: latencyOf(edge),
    });
  }

  const transport = crossEdges.reduce((n, e) => n + e.latencyMsPerSecond, 0);
  const monthlyCost = finalUnits.reduce(
    (n, u) => n + cost.unitBaseCost + u.memoryMb * cost.costPerMbMonth,
    0,
  );

  return {
    shape,
    units: finalUnits.sort((a, z) => (a.id < z.id ? -1 : 1)),
    crossEdges,
    transportLatencyMsPerSecond: transport,
    monthlyCost,
    recombinations,
    blockedMerges,
    constraints: {
      cost: { ...cost }, isolate: [...isolate],
      concurrencyGroups: (opts.concurrencyFindings ?? []).map(finding => [...finding.symbols]),
      functionMemory: [...declarations.keys()].map(symbol => [symbol, memoryOf.get(symbol) ?? 16] as const),
      edges: telemetry.edges.map(edge => ({ ...edge })),
    },
  };
}

function mergeBlockedBecause(
  a: WorkingUnit,
  b: WorkingUnit,
  cost: CostModel,
  isolate: ReadonlySet<CapabilityName>,
): string | null {
  if (a.memoryMb + b.memoryMb > cost.maxUnitMemoryMb) {
    return `combined footprint ${a.memoryMb + b.memoryMb}MB exceeds the ${cost.maxUnitMemoryMb}MB unit limit`;
  }
  for (const set of [a.capabilities, b.capabilities]) {
    for (const cap of set) {
      if (isolate.has(cap)) return `${cap} must run in isolation`;
    }
  }
  return null;
}

/**
 * The transport glue for one plan.
 *
 * This is the plumbing the PRD says agents currently waste tokens on: it is
 * derived, never authored. Co-located calls get a direct reference; calls that
 * cross a boundary get a stub carrying the capability envelope, because
 * authority has to survive the hop.
 */
export function generateGlue(plan: TopologyPlan, symbols?: SymbolSpace): string {
  const name = (s: SymbolId) => symbols?.nameOf(s) ?? s;
  const lines: string[] = [
    `// Generated transport for a ${plan.shape} topology. Do not edit: this file`,
    '// is a projection of the topology plan, not a source of truth.',
    '',
  ];
  for (const unit of plan.units) {
    lines.push(`// ---- unit ${unit.id} (${unit.placement}, ${unit.memoryMb}MB) ----`);
    lines.push(`export const ${sanitize(unit.id)} = {`);
    lines.push(`  placement: ${JSON.stringify(unit.placement)},`);
    lines.push(`  capabilities: ${JSON.stringify(unit.capabilities)},`);
    lines.push(`  exports: [${unit.members.map((m) => JSON.stringify(name(m))).join(', ')}],`);
    lines.push('};');
    lines.push('');
  }
  if (plan.crossEdges.length === 0) {
    lines.push('// No boundary is crossed: every call is a direct, zero-copy invocation.');
    return lines.join('\n');
  }
  for (const edge of plan.crossEdges) {
    lines.push(
      `// ${name(edge.from)} -> ${name(edge.to)}: ${edge.callsPerSecond}/s, ` +
        `${edge.payloadBytes}B, ${edge.latencyMsPerSecond.toFixed(1)}ms/s of transport`,
    );
    lines.push(`export const ${sanitize(name(edge.to))}Stub = rpc({`);
    lines.push(`  target: ${JSON.stringify(edge.toUnit)},`);
    lines.push(`  method: ${JSON.stringify(name(edge.to))},`);
    lines.push('  // The caller\'s capability envelope travels with the request:');
    lines.push('  // crossing a process boundary must not widen authority.');
    lines.push('  forwardCapabilities: true,');
    lines.push('});');
    lines.push('');
  }
  return lines.join('\n');
}

const sanitize = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, '_');

/** Compare candidate shapes so the choice is made on numbers. */
export function compareShapes(
  module: Term,
  telemetry: Telemetry,
  opts: SliceOptions = {},
): Array<{ shape: TargetShape; plan: TopologyPlan }> {
  const shapes: TargetShape[] = ['single_binary', 'containers', 'edge_workers', 'auto'];
  return shapes.map((shape) => ({ shape, plan: slice(module, telemetry, { ...opts, shape }) }));
}

/** A one-screen summary of a plan. */
export function formatPlan(plan: TopologyPlan, symbols?: SymbolSpace): string {
  const name = (s: SymbolId) => symbols?.nameOf(s) ?? s;
  const lines = [
    `topology ${plan.shape}: ${plan.units.length} unit(s), ` +
      `${plan.transportLatencyMsPerSecond.toFixed(1)}ms/s transport, ` +
      `$${plan.monthlyCost.toFixed(2)}/month`,
  ];
  for (const unit of plan.units) {
    lines.push(
      `  ${unit.id} [${unit.placement}, ${unit.memoryMb}MB, ` +
        `${unit.members.length} member(s) sharing one memory domain] ` +
        `{${unit.members.map(name).join(', ')}}` +
        (unit.capabilities.length ? ` caps: ${unit.capabilities.join(', ')}` : ''),
    );
  }
  for (const r of plan.recombinations) lines.push(`  + ${r}`);
  for (const b of plan.blockedMerges) lines.push(`  - blocked: ${b}`);
  return lines.join('\n');
}
