import type { Term, Ty } from '../tier1/ast.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import { CapabilitySealer, type CapabilityToken } from '../tier2/ocap.ts';
import { ProductionRuntime, type CompileOptions } from '../tier3/compile.ts';
import type { ExecutionResult } from '../tier3/runtime.ts';
import type { Ref, Value } from '../tier3/values.ts';
import type { EdgeTelemetry, FunctionTelemetry, Telemetry, TopologyPlan, Unit } from './topology.ts';

export interface WireRequest {
  readonly id: string;
  readonly from: SymbolId | null;
  readonly to: SymbolId;
  readonly args: readonly Value[];
  readonly capabilities: readonly CapabilityToken[];
  readonly timeoutMs?: number;
}

export type DistributedFaultKind = 'partition' | 'timeout' | 'authority' | 'remote_fault';
export interface DistributedFault {
  readonly kind: DistributedFaultKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly committed: boolean;
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
  private readonly runtime: ProductionRuntime;
  private readonly units = new Map<SymbolId, string>();
  private readonly declarations = new Map<SymbolId, Extract<Term, { kind: 'FunctionDecl' }>>();
  private readonly partitioned = new Set<string>();
  private readonly active = new Map<SymbolId, number>();
  private readonly sealer: CapabilitySealer;
  private readonly telemetry: TelemetryCollector;
  private readonly clock: () => number;

  constructor(module: Term, plan: TopologyPlan, opts: TopologyHostOptions) {
    this.planValue = plan;
    this.runtime = ProductionRuntime.compile(module, opts);
    this.sealer = opts.sealer ?? new CapabilitySealer();
    this.telemetry = opts.telemetry ?? new TelemetryCollector();
    this.clock = opts.clock ?? (() => Date.now());
    for (const unit of plan.units) for (const symbol of unit.members) this.units.set(symbol, unit.id);
    const members = module.kind === 'Module' ? module.members : [module];
    for (const member of members) if (member.kind === 'FunctionDecl') this.declarations.set(member.symbol, member);
  }

  get plan(): TopologyPlan { return this.planValue; }
  unitFor(symbol: SymbolId): string | null { return this.units.get(symbol) ?? null; }
  allocateRecord(ty: Ty, fields: Record<string, Value>): Ref { return this.runtime.allocateRecord(ty, fields); }
  readRecord(ref: Ref): ReadonlyMap<string, Value> { return this.runtime.readRecord(ref); }
  setPartition(unit: string, partitioned: boolean): void {
    if (partitioned) this.partitioned.add(unit); else this.partitioned.delete(unit);
  }

  call(symbol: SymbolId, args: readonly Value[], from: SymbolId | null = null): ExecutionResult {
    const started = this.clock();
    this.active.set(symbol, (this.active.get(symbol) ?? 0) + 1);
    try {
      return this.runtime.call(symbol, args);
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
  move(symbol: SymbolId, targetUnit: string): TopologyPlan {
    if ((this.active.get(symbol) ?? 0) !== 0) throw new Error(`${symbol} still has active calls`);
    const source = this.unitFor(symbol);
    if (!source) throw new ReferenceError(`unplaced function ${symbol}`);
    if (!this.planValue.units.some((unit) => unit.id === targetUnit)) throw new ReferenceError(`unknown unit ${targetUnit}`);
    const units = this.planValue.units
      .map((unit) => unit.id === source ? { ...unit, members: unit.members.filter((member) => member !== symbol) } : unit)
      .map((unit) => unit.id === targetUnit ? { ...unit, members: [...unit.members, symbol] } : unit)
      .filter((unit) => unit.members.length > 0);
    this.units.set(symbol, targetUnit);
    this.planValue = { ...this.planValue, units };
    return this.planValue;
  }

  collectTelemetry(windowSeconds: number): Telemetry {
    return this.telemetry.snapshot(windowSeconds, this.planValue.units);
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
