import type { Term, Ty } from '../tier1/ast.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import { CapabilitySealer, type CapabilityToken } from '../tier2/ocap.ts';
import { ProductionRuntime, type CompileOptions } from '../tier3/compile.ts';
import type { ExecutionResult } from '../tier3/runtime.ts';
import { type Ref, type Value } from '../tier3/values.ts';
import { DEFAULT_COST_MODEL, type EdgeTelemetry, type FunctionTelemetry, type Telemetry, type TopologyPlan, type Unit } from './topology.ts';

export interface WireRequest {
  readonly id: string;
  readonly from: SymbolId | null;
  readonly to: SymbolId;
  readonly args: readonly Value[];
  readonly capabilities: readonly CapabilityToken[];
  readonly timeoutMs?: number;
}

export type DistributedFaultKind = 'partition' | 'timeout' | 'authority' | 'remote_fault' | 'indeterminate';
export interface DistributedFault {
  readonly kind: DistributedFaultKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly committed: boolean | null;
  readonly recoveryId?: string;
}
export type DistributedResult =
  | { readonly ok: true; readonly execution: ExecutionResult; readonly unit: string }
  | { readonly ok: false; readonly fault: DistributedFault; readonly unit: string | null };

interface Aggregate {
  calls: number;
  elapsedMs: number;
  payloadBytes: number;
}

export class TelemetryCollector {
  private readonly edges = new Map<string, Aggregate>();
  private readonly functions = new Map<SymbolId, Aggregate>();

  record(from: SymbolId | null, to: SymbolId, elapsedMs: number, payloadBytes: number): void {
    const fn = this.functions.get(to) ?? { calls: 0, elapsedMs: 0, payloadBytes: 0 };
    fn.calls++; fn.elapsedMs += elapsedMs; fn.payloadBytes += payloadBytes;
    this.functions.set(to, fn);
    if (from) {
      const key = `${from}\0${to}`;
      const edge = this.edges.get(key) ?? { calls: 0, elapsedMs: 0, payloadBytes: 0 };
      edge.calls++; edge.elapsedMs += elapsedMs; edge.payloadBytes += payloadBytes;
      this.edges.set(key, edge);
    }
  }

  snapshot(windowSeconds: number, units: readonly Unit[]): Telemetry {
    const memory = new Map<SymbolId, number>();
    for (const unit of units) for (const member of unit.members) memory.set(member, unit.memoryMb / unit.members.length);
    const edges: EdgeTelemetry[] = [...this.edges.entries()].map(([key, value]) => {
      const [from, to] = key.split('\0') as [SymbolId, SymbolId];
      return {
        from, to, callsPerSecond: value.calls / windowSeconds,
        payloadBytes: value.calls ? value.payloadBytes / value.calls : 0,
      };
    });
    const functions: FunctionTelemetry[] = [...this.functions.entries()].map(([symbol, value]) => ({
      symbol,
      selfMs: value.calls ? value.elapsedMs / value.calls : 0,
      memoryMb: memory.get(symbol) ?? 0,
    }));
    return { edges, functions };
  }
}

export interface TopologyHostOptions extends CompileOptions {
  readonly sealer?: CapabilitySealer;
  readonly telemetry?: TelemetryCollector;
  readonly clock?: () => number;
}

/** Executable host for a topology plan, including boundary and migration semantics. */
export class TopologyHost {
  private planValue: TopologyPlan;
  private readonly unitRuntimes = new Map<string, ProductionRuntime>();
  private readonly module: Term;
  private readonly compileOptions: TopologyHostOptions;
  private readonly units = new Map<SymbolId, string>();
  private readonly declarations = new Map<SymbolId, Extract<Term, { kind: 'FunctionDecl' }>>();
  private readonly partitioned = new Set<string>();
  private readonly active = new Map<SymbolId, number>();
  private readonly sealer: CapabilitySealer;
  private readonly telemetry: TelemetryCollector;
  private readonly clock: () => number;
  // One synchronous local state domain, with isolated runtime copies. The last
  // executing runtime owns the authoritative version; boundaries copy it before
  // dispatch and back into suspended callers. This also coordinates allocation.
  private authoritative: ProductionRuntime | null = null;
  private readonly executionStack: ProductionRuntime[] = [];
  private moving = false;
  private generationValue = 0;

  constructor(module: Term, plan: TopologyPlan, opts: TopologyHostOptions) {
    this.planValue = plan;
    this.module = module;
    this.compileOptions = opts;
    this.sealer = opts.sealer ?? new CapabilitySealer();
    this.telemetry = opts.telemetry ?? new TelemetryCollector();
    this.clock = opts.clock ?? (() => Date.now());
    for (const unit of plan.units) for (const symbol of unit.members) this.units.set(symbol, unit.id);
    const members = module.kind === 'Module' ? module.members : [module];
    for (const member of members) if (member.kind === 'FunctionDecl') this.declarations.set(member.symbol, member);
    for (const unit of plan.units) this.unitRuntimes.set(unit.id, this.compileUnit(unit));
    this.authoritative = this.unitRuntimes.values().next().value ?? null;
  }

  get plan(): TopologyPlan { return this.planValue; }
  get unitRuntimeCount(): number { return this.unitRuntimes.size; }
  get generation(): number { return this.generationValue; }
  unitFor(symbol: SymbolId): string | null { return this.units.get(symbol) ?? null; }
  allocateRecord(ty: Ty, fields: Record<string, Value>): Ref {
    if (this.moving) throw new Error('state handoff is in preparation');
    const runtime = this.executionStack.at(-1) ?? this.authoritative;
    if (!runtime) throw new Error('topology has no runtime units');
    return runtime.allocateRecord(ty, fields);
  }
  readRecord(ref: Ref): ReadonlyMap<string, Value> {
    const runtime = this.executionStack.at(-1) ?? this.authoritative;
    if (!runtime) throw new RangeError(`no unit owns @${ref.addr}`);
    return runtime.readRecord(ref);
  }
  setPartition(unit: string, partitioned: boolean): void {
    if (partitioned) this.partitioned.add(unit); else this.partitioned.delete(unit);
  }

  call(symbol: SymbolId, args: readonly Value[], from: SymbolId | null = null): ExecutionResult {
    if (this.moving) throw new Error('state handoff is in preparation');
    const started = this.clock();
    this.active.set(symbol, (this.active.get(symbol) ?? 0) + 1);
    try {
      const unit = this.unitFor(symbol);
      const runtime = unit ? this.unitRuntimes.get(unit) : undefined;
      if (!runtime) {
        return {
          ok: false,
          fault: { kind: 'unbound', message: `${symbol} is not assigned to a runtime`, label: null, step: 0, bindings: {} },
          steps: 0,
        };
      }
      return this.withRuntime(runtime, () => runtime.call(symbol, args));
    } finally {
      this.active.set(symbol, (this.active.get(symbol) ?? 1) - 1);
      this.telemetry.record(from, symbol, this.clock() - started, estimatePayload(args));
    }
  }

  dispatch(request: WireRequest): DistributedResult {
    const unit = this.unitFor(request.to);
    if (!unit) return { ok: false, unit: null, fault: fault('remote_fault', 'target is not placed', false, false) };
    if (this.partitioned.has(unit)) return { ok: false, unit, fault: fault('partition', `unit ${unit} is partitioned`, true, false) };
    const declaration = this.declarations.get(request.to);
    for (const capability of declaration?.capabilities ?? []) {
      const token = request.capabilities.find((candidate) => candidate.capability === capability);
      if (!token || !this.sealer.verify(token, unit)) {
        return { ok: false, unit, fault: fault('authority', `missing valid ${capability} token`, false, false) };
      }
    }
    const started = this.clock();
    const execution = this.call(request.to, request.args, request.from);
    if (!execution.ok && execution.fault.kind === 'effect_indeterminate') {
      return { ok: false, unit, fault: {
        kind: 'indeterminate', message: execution.fault.message,
        retryable: false, committed: null, recoveryId: execution.fault.recoveryId,
      } };
    }
    if (request.timeoutMs !== undefined && this.clock() - started > request.timeoutMs) {
      return { ok: false, unit, fault: fault('timeout', `request ${request.id} exceeded its deadline`, true, execution.ok) };
    }
    if (!execution.ok) {
      return { ok: false, unit, fault: fault('remote_fault', execution.fault.message, false, true) };
    }
    return { ok: true, execution, unit };
  }

  issueTokens(symbol: SymbolId, ttlMs = 60_000): CapabilityToken[] {
    const unit = this.unitFor(symbol);
    if (!unit) throw new ReferenceError(`unplaced function ${symbol}`);
    return (this.declarations.get(symbol)?.capabilities ?? [])
      .map((capability) => this.sealer.issue(capability, unit, ttlMs));
  }

  /** Move a quiescent function to an existing unit and publish a new plan generation. */
  move(symbol: SymbolId, targetUnit: string, expectedGeneration = this.generationValue): TopologyPlan {
    if (expectedGeneration !== this.generationValue) throw new Error('stale topology generation');
    const source = this.unitFor(symbol);
    if (!source) throw new ReferenceError(`unplaced function ${symbol}`);
    if (!this.planValue.units.some((unit) => unit.id === targetUnit)) throw new ReferenceError(`unknown unit ${targetUnit}`);
    if (source === targetUnit) return this.planValue;
    if (this.moving || this.executionStack.length || [...this.active.values()].some(count => count > 0)) throw new Error('state domain still has active calls');
    if (this.partitioned.has(source) || this.partitioned.has(targetUnit)) throw new Error('cannot move a partitioned unit');
    this.moving = true;
    try {
    const units = this.planValue.units
      .map((unit) => unit.id === source ? { ...unit, members: unit.members.filter((member) => member !== symbol) } : unit)
      .map((unit) => unit.id === targetUnit ? { ...unit, members: [...unit.members, symbol] } : unit)
      .filter((unit) => unit.members.length > 0);
      const plan = this.repriceAndValidate(units);
      for (const id of [source, targetUnit]) this.unitRuntimes.get(id)!.assertMigrationSafe();
      if (!this.authoritative) throw new Error('topology has no authoritative state');
      const snapshot = this.authoritative.exportSnapshot();
      const replacements = new Map<string, ProductionRuntime>();
      for (const unit of plan.units.filter(unit => unit.id === source || unit.id === targetUnit)) {
        const runtime = this.compileUnit(unit);
        runtime.importSnapshot(snapshot);
        replacements.set(unit.id, runtime);
      }
      // All potentially failing work above precedes the synchronous publication.
      this.unitRuntimes.delete(source);
      for (const [id, runtime] of replacements) this.unitRuntimes.set(id, runtime);
      this.units.set(symbol, targetUnit);
      this.authoritative = replacements.get(targetUnit)!;
      this.planValue = plan;
      this.generationValue++;
      return this.planValue;
    } finally {
      this.moving = false;
    }
  }

  collectTelemetry(windowSeconds: number): Telemetry {
    return this.telemetry.snapshot(windowSeconds, this.planValue.units);
  }

  private compileUnit(unit: Unit): ProductionRuntime {
    const options: CompileOptions = {
      ...this.compileOptions,
      includeSymbols: unit.members,
      callHandler: (callee, args, caller) => this.call(callee, args, caller),
      continuationHandler: (runtime, execute) => this.withRuntime(runtime, execute),
    };
    return ProductionRuntime.compile(this.module, options);
  }

  private withRuntime<T>(runtime: ProductionRuntime, execute: () => T): T {
    if (this.moving) throw new Error('state handoff is in preparation');
    const caller = this.executionStack.at(-1);
    const current = caller ?? this.authoritative;
    if (current) runtime.synchronizeLocalHeap(current);
    this.executionStack.push(runtime);
    try { return execute(); }
    finally {
      this.executionStack.pop();
      this.authoritative = runtime;
      if (caller) {
        caller.synchronizeLocalHeap(runtime);
        this.authoritative = caller;
      }
    }
  }

  private repriceAndValidate(input: readonly Unit[]): TopologyPlan {
    const constraints = this.planValue.constraints;
    const cost = constraints?.cost ?? DEFAULT_COST_MODEL;
    const memory = new Map(constraints?.functionMemory ?? this.planValue.units.flatMap(unit =>
      unit.members.map(member => [member, unit.memoryMb / unit.members.length] as const)));
    const units = input.map(unit => ({ ...unit,
      capabilities: [...new Set(unit.members.flatMap(symbol => this.declarations.get(symbol)?.capabilities ?? []))].sort(),
      memoryMb: unit.members.reduce((sum, symbol) => sum + (memory.get(symbol) ?? 0), 0),
    }));
    const placement = new Map(units.flatMap(unit => unit.members.map(member => [member, unit] as const)));
    for (const unit of units) {
      if (unit.memoryMb > cost.maxUnitMemoryMb) throw new Error('movement exceeds unit memory limit');
      if (unit.placement === 'edge' && unit.capabilities.some(cap => ['db', 'fs', 'secrets'].includes(cap.split(':')[1]))) throw new Error('capability cannot be placed at edge');
      if (unit.members.length > 1 && unit.capabilities.some(cap => constraints?.isolate.includes(cap))) throw new Error('capability requires isolated placement');
    }
    for (const group of constraints?.concurrencyGroups ?? []) {
      if (new Set(group.map(symbol => placement.get(symbol)?.id)).size > 1) throw new Error('movement splits a single-writer group');
    }
    const edges = constraints?.edges ?? this.planValue.crossEdges;
    const crossEdges = edges.flatMap(edge => {
      const from = placement.get(edge.from), to = placement.get(edge.to);
      if (!from || !to || from.id === to.id) return [];
      return [{ ...edge, fromUnit: from.id, toUnit: to.id,
        latencyMsPerSecond: edge.callsPerSecond * (2 * cost.hopLatencyMs + cost.serializationMs + edge.payloadBytes / (cost.bandwidthMbPerSecond * 1_000_000) * 1000),
      }];
    });
    return { ...this.planValue, units, crossEdges,
      transportLatencyMsPerSecond: crossEdges.reduce((sum, edge) => sum + edge.latencyMsPerSecond, 0),
      monthlyCost: units.reduce((sum, unit) => sum + cost.unitBaseCost + unit.memoryMb * cost.costPerMbMonth, 0),
    };
  }
}

const fault = (
  kind: DistributedFaultKind, message: string, retryable: boolean, committed: boolean,
): DistributedFault => ({ kind, message, retryable, committed });

function estimatePayload(args: readonly Value[]): number {
  return new TextEncoder().encode(JSON.stringify(args, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )).length;
}
