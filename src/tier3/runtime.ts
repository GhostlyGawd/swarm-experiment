/**
 * The telemetric runtime (FR-3.1).
 *
 * The execution engine is built around one decision: *every state change is
 * journaled with its inverse*. That single property gives the three things the
 * PRD asks for, and gives them cheaply.
 *
 *   • **Time travel.** Rewinding N steps is applying N inverse deltas. It costs
 *     what the changes cost, not what the program cost, so stepping backwards
 *     out of a failed assertion is bounded by how far you step, not by how long
 *     the program had been running (NFR 6.1: 15 ms).
 *   • **Micro-forking.** A fork is a snapshot of the live state plus a shared,
 *     immutable prefix of the journal. Fifty candidate repairs can be run
 *     against the exact heap where a bug occurred, independently.
 *   • **Structured feedback.** Agents read `Trace` records and `inspect()`,
 *     never a byte stream. There is no stdout here to parse, and no ambient
 *     authority to write to one.
 *
 * Failures are values, not exceptions to be pattern-matched out of a log: a
 * contract violation carries the clause, the binding environment and the step
 * index, which is exactly what the synthesis loop needs to make a next attempt.
 */

import type { BinOp, Term, Ty } from '../tier1/ast.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import { GraphStore } from '../tier1/store.ts';
import { checkVirtualForwardDescriptor, type VirtualForwardBinding, type VirtualForwardDescriptor } from '../tier1/semantic-gc-virtual-forward.ts';
import { CapabilityEnvelope, type CapabilityRegistry, type RevocationList } from '../tier2/ocap.ts';
import { underlying } from '../tier2/typecheck.ts';
import { formatValue, isClosureValue, isRef, isResultValue, isSeqValue, isTaskValue, type Ref, type Value } from './values.ts';
import { EffectInvocationError, type RuntimeEffectRouter } from './effects.ts';

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

type Scope = Map<SymbolId, Value>;

type Delta =
  | { k: 'env'; step: number; scope: Scope; symbol: SymbolId; had: boolean; prev: Value }
  | { k: 'heap'; step: number; addr: number; field: string; had: boolean; prev: Value }
  | { k: 'alloc'; step: number; addr: number }
  | { k: 'push'; step: number }
  | { k: 'pop'; step: number; scope: Scope };

export type TraceKind =
  | 'call' | 'return' | 'assign' | 'alloc' | 'branch' | 'loop'
  | 'invoke' | 'assert' | 'contract' | 'fault';

export interface TraceEvent {
  readonly step: number;
  readonly kind: TraceKind;
  readonly node: Term['kind'];
  readonly detail: string;
  /** Depth in the call stack, for rendering a readable trace. */
  readonly depth: number;
}

// ---------------------------------------------------------------------------
// faults
// ---------------------------------------------------------------------------

export type FaultKind =
  | 'precondition'
  | 'postcondition'
  | 'assertion'
  | 'capability_denied'
  | 'capability_revoked'
  | 'division_by_zero'
  | 'step_budget'
  | 'unbound'
  | 'type_error'
  /** An effect handler refused. Injected by micro-worlds to model an outage. */
  | 'effect_failed'
  | 'effect_indeterminate';

export interface Fault {
  readonly kind: FaultKind;
  readonly message: string;
  /** The clause or assertion label, where there is one. */
  readonly label: string | null;
  readonly step: number;
  /** Variable bindings in scope at the fault, for the repair agent. */
  readonly bindings: Readonly<Record<string, string>>;
  /** Durable effect recovery identity; never treat this outcome as safely aborted. */
  readonly recoveryId?: string;
}

export class AetherFault extends Error {
  readonly fault: Fault;
  constructor(fault: Fault) {
    super(fault.message);
    this.name = 'AetherFault';
    this.fault = fault;
  }
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

export type ExecutionResult =
  | { readonly ok: true; readonly value: Value; readonly steps: number }
  | { readonly ok: false; readonly fault: Fault; readonly steps: number };

export interface Checkpoint {
  /** Journal length. Rewinding to this point undoes everything after it. */
  readonly mark: number;
  readonly step: number;
  readonly label: string;
}

export interface RuntimeOptions {
  readonly registry: CapabilityRegistry;
  readonly symbols?: SymbolSpace;
  readonly revocations?: RevocationList;
  /** Implementations of the capabilities in scope. */
  readonly effects?: ReadonlyMap<CapabilityName, (args: readonly Value[], from?: SymbolId) => Value>;
  readonly effectRouter?: RuntimeEffectRouter;
  /**
   * Bound on a single top-level call, not on the runtime's lifetime. A
   * cumulative bound would make a long-lived development runtime quietly stop
   * working part-way through a session.
   */
  readonly maxSteps?: number;
  /** Record a trace event for every step. Off in the production runtime. */
  readonly trace?: boolean;
  /** Called on every step; the agent's replacement for a debugger breakpoint. */
  readonly onStep?: (event: TraceEvent) => void;
  /** Scope name used when consulting the revocation list. */
  readonly scope?: string;
  /** Exact-source, checked reference-runtime profile for one retired pure
   * forwarder. A caller cannot opt in with an unverified event script. */
  readonly virtualForward?: {
    readonly source: Extract<Term, { kind: 'Module' }>;
    readonly descriptor: VirtualForwardDescriptor;
  };
}

interface Frame {
  readonly decl: Extract<Term, { kind: 'FunctionDecl' }>;
  readonly scopes: Scope[];
  readonly envelope: CapabilityEnvelope;
  /** Heap as it was on entry, for evaluating `old(…)` in postconditions. */
  readonly preHeap: Map<number, Map<string, Value>>;
  readonly preScope: Scope;
}

const DEFAULT_MAX_STEPS = 200_000;

/** Thrown internally to unwind to the enclosing call. Never escapes. */
class ReturnSignal {
  readonly value: Value;
  constructor(value: Value) {
    this.value = value;
  }
}

export class Runtime {
  private readonly opts: RuntimeOptions;
  private readonly functions = new Map<SymbolId, Extract<Term, { kind: 'FunctionDecl' }>>();
  private readonly virtualForwardSites = new WeakMap<object, VirtualForwardBinding>();
  private heap = new Map<number, Map<string, Value>>();
  private nextAddr = 1;
  private journal: Delta[] = [];
  private readonly frames: Frame[] = [];
  private stepCount = 0;
  /** Step count when the current top-level call began. */
  private callBaseline = 0;
  private readonly events: TraceEvent[] = [];
  /** Effects performed, in order. The replacement for reading a log. */
  private readonly effectLog: Array<{ step: number; capability: CapabilityName; args: Value[] }> = [];

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }

  // --- registration --------------------------------------------------------

  /** Make a module's functions callable. */
  load(term: Term): this {
    let loaded = term;
    if (this.opts.virtualForward) {
      if (term.kind !== 'Module') throw new TypeError('virtual forward profile requires a complete candidate module');
      // Validate plain AST input before cloning it, then bind the verified
      // sites in a private snapshot. A later caller mutation of either input
      // module must not change an already loaded virtual frame or call site.
      checkVirtualForwardDescriptor(this.opts.virtualForward.descriptor, this.opts.virtualForward.source, term);
      const source = structuredClone(this.opts.virtualForward.source);
      loaded = structuredClone(term);
      if (loaded.kind !== 'Module') throw new TypeError('virtual forward candidate changed during loading');
      const bindings = checkVirtualForwardDescriptor(this.opts.virtualForward.descriptor, source, loaded);
      for (const binding of bindings) this.virtualForwardSites.set(binding.candidateCall, binding);
    }
    this.opts.effectRouter?.bind(new GraphStore().intern(loaded));
    const collect = (node: Term): void => {
      if (node.kind === 'FunctionDecl') this.functions.set(node.symbol, node);
      if (node.kind === 'Module') for (const member of node.members) collect(member);
    };
    collect(loaded);
    return this;
  }

  get steps(): number {
    return this.stepCount;
  }

  get trace(): readonly TraceEvent[] {
    return this.events;
  }

  get effects(): ReadonlyArray<{ step: number; capability: CapabilityName; args: Value[] }> {
    return this.effectLog;
  }

  private name(sym: SymbolId): string {
    return this.opts.symbols?.nameOf(sym) ?? sym;
  }

  // --- journaled state -----------------------------------------------------

  private record(delta: Delta): void {
    this.journal.push(delta);
  }

  private setVar(scope: Scope, symbol: SymbolId, value: Value): void {
    const had = scope.has(symbol);
    this.record({ k: 'env', step: this.stepCount, scope, symbol, had, prev: had ? scope.get(symbol)! : null });
    scope.set(symbol, value);
  }

  private setField(addr: number, field: string, value: Value): void {
    const record = this.heap.get(addr);
    if (!record) throw new AetherFault(this.fault('type_error', `no record at @${addr}`, null));
    const had = record.has(field);
    this.record({ k: 'heap', step: this.stepCount, addr, field, had, prev: had ? record.get(field)! : null });
    record.set(field, value);
  }

  private allocate(fields: Iterable<readonly [string, Value]>): Ref {
    const addr = this.nextAddr++;
    this.heap.set(addr, new Map(fields));
    this.record({ k: 'alloc', step: this.stepCount, addr });
    return { addr };
  }

  // --- checkpoints and time travel -----------------------------------------

  /** Mark a point that execution can be returned to exactly. */
  checkpoint(label = ''): Checkpoint {
    return { mark: this.journal.length, step: this.stepCount, label };
  }

  /**
   * Undo everything after a checkpoint. Cost is proportional to the number of
   * *changes* since the mark, not to the work done.
   */
  restore(checkpoint: Checkpoint): void {
    if (checkpoint.mark > this.journal.length) {
      throw new RangeError('checkpoint is from a different execution');
    }
    this.undoTo(checkpoint.mark);
    this.stepCount = checkpoint.step;
  }

  /** Step backwards by `steps` executed steps (FR-3.1, time-travel debugging). */
  rewind(steps: number): void {
    const target = Math.max(0, this.stepCount - steps);
    let mark = this.journal.length;
    while (mark > 0 && this.journal[mark - 1].step > target) mark--;
    this.undoTo(mark);
    this.stepCount = target;
  }

  private undoTo(mark: number): void {
    for (let i = this.journal.length - 1; i >= mark; i--) {
      const delta = this.journal[i];
      switch (delta.k) {
        case 'env':
          if (delta.had) delta.scope.set(delta.symbol, delta.prev);
          else delta.scope.delete(delta.symbol);
          break;
        case 'heap': {
          const record = this.heap.get(delta.addr);
          if (!record) break;
          if (delta.had) record.set(delta.field, delta.prev);
          else record.delete(delta.field);
          break;
        }
        case 'alloc':
          this.heap.delete(delta.addr);
          this.nextAddr = Math.min(this.nextAddr, delta.addr);
          break;
        case 'push':
        case 'pop':
          break;
      }
    }
    this.journal.length = mark;
  }

  /**
   * A micro-fork (FR-3.1).
   *
   * The clone starts from the current heap, with an empty journal of its own,
   * so candidate repairs cannot disturb each other or the parent. The parent's
   * history is deliberately *not* copied: a fork explores forwards.
   */
  fork(): Runtime {
    const child = new Runtime({ ...this.opts, effectRouter: this.opts.effectRouter?.fork() });
    for (const [symbol, decl] of this.functions) child.functions.set(symbol, decl);
    child.heap = new Map();
    for (const [addr, record] of this.heap) child.heap.set(addr, new Map(record));
    child.nextAddr = this.nextAddr;
    child.stepCount = this.stepCount;
    return child;
  }

  /** Structured state for an agent's memory hook. Never a formatted string. */
  inspect(): {
    step: number;
    heap: Record<string, Record<string, string>>;
    locals: Record<string, string>;
    stack: string[];
  } {
    const heap: Record<string, Record<string, string>> = {};
    for (const [addr, record] of this.heap) {
      heap[`@${addr}`] = Object.fromEntries(
        [...record.entries()].map(([k, v]) => [k, formatValue(v, this.heap)]),
      );
    }
    return {
      step: this.stepCount,
      heap,
      locals: this.bindings(),
      stack: this.frames.map((f) => this.name(f.decl.symbol)),
    };
  }

  private bindings(): Record<string, string> {
    const out: Record<string, string> = {};
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return out;
    for (const scope of frame.scopes) {
      for (const [symbol, value] of scope) out[this.name(symbol)] = formatValue(value, this.heap);
    }
    return out;
  }

  private fault(kind: FaultKind, message: string, label: string | null): Fault {
    return { kind, message, label, step: this.stepCount, bindings: this.bindings() };
  }

  private emit(kind: TraceKind, node: Term['kind'], detail: string): void {
    if (!this.opts.trace && !this.opts.onStep) return;
    const event: TraceEvent = { step: this.stepCount, kind, node, detail, depth: this.frames.length };
    if (this.opts.trace) this.events.push(event);
    this.opts.onStep?.(event);
  }

  private tick(): void {
    this.stepCount++;
    if (this.stepCount - this.callBaseline > (this.opts.maxSteps ?? DEFAULT_MAX_STEPS)) {
      throw new AetherFault(this.fault('step_budget', 'step budget exhausted', null));
    }
  }

  // --- calling -------------------------------------------------------------

  /** Allocate a record of type `ty` from plain field values. */
  allocateRecord(ty: Ty, fields: Record<string, Value>): Ref {
    const base = underlying(ty);
    if (base.t !== 'Record') throw new TypeError(`${ty.t} is not a record type`);
    return this.allocate(base.fields.map(([name]) => [name, Object.hasOwn(fields, name) ? fields[name] ?? null : null] as const));
  }

  readRecord(ref: Ref): ReadonlyMap<string, Value> {
    const record = this.heap.get(ref.addr);
    if (!record) throw new RangeError(`no record at @${ref.addr}`);
    return record;
  }

  /** Invoke a loaded function by symbol. */
  call(symbol: SymbolId, args: readonly Value[]): ExecutionResult {
    const decl = this.functions.get(symbol);
    if (!decl) {
      return { ok: false, fault: this.fault('unbound', `${this.name(symbol)} is not loaded`, null), steps: this.stepCount };
    }
    return this.callDeclaration(decl, args);
  }

  callDeclaration(
    decl: Extract<Term, { kind: 'FunctionDecl' }>,
    args: readonly Value[],
  ): ExecutionResult {
    const before = this.stepCount;
    // The budget covers this call, so nested calls share it but a later
    // top-level call starts fresh.
    if (this.frames.length === 0) this.callBaseline = this.stepCount;
    try {
      const value = this.enter(decl, args);
      return { ok: true, value, steps: this.stepCount - before };
    } catch (e) {
      if (e instanceof AetherFault) {
        this.emit('fault', 'FunctionDecl', `${e.fault.kind}: ${e.fault.message}`);
        return { ok: false, fault: e.fault, steps: this.stepCount - before };
      }
      throw e;
    }
  }

  private enter(decl: Extract<Term, { kind: 'FunctionDecl' }>, args: readonly Value[]): Value {
    if (decl.body === null) {
      throw new AetherFault(
        this.fault('unbound', `${this.name(decl.symbol)} has a contract but no body`, null),
      );
    }
    const scope: Scope = new Map();
    decl.params.forEach((p, i) => scope.set(p.symbol, args[i] ?? null));
    for (const s of decl.surfaces) {
      if (s.kind === 'Surface') {
        scope.set(s.symbol, typeof s.current === 'bigint' ? s.current : s.current);
      }
    }

    const preHeap = new Map<number, Map<string, Value>>();
    for (const [addr, record] of this.heap) preHeap.set(addr, new Map(record));

    const frame: Frame = {
      decl,
      scopes: [scope],
      envelope: CapabilityEnvelope.of(...decl.capabilities),
      preHeap,
      preScope: new Map(scope),
    };
    this.frames.push(frame);
    this.emit('call', 'FunctionDecl', `${this.name(decl.symbol)}(${args.map((a) => formatValue(a, this.heap)).join(', ')})`);

    try {
      const contract = decl.contract?.kind === 'Contract' ? decl.contract : null;
      if (contract) {
        for (const clause of contract.requires) {
          if (clause.kind !== 'Clause') continue;
          if (this.truthy(this.eval(clause.expr, frame, null))) continue;
          this.emit('contract', 'Clause', `requires ${clause.label} failed`);
          throw new AetherFault(
            this.fault('precondition', `precondition ${clause.label} does not hold`, clause.label),
          );
        }
      }

      let returned: Value = null;
      try {
        this.exec(decl.body, frame);
      } catch (e) {
        if (!(e instanceof ReturnSignal)) throw e;
        returned = e.value;
      }

      if (contract) {
        for (const clause of contract.ensures) {
          if (clause.kind !== 'Clause') continue;
          if (this.truthy(this.eval(clause.expr, frame, returned))) continue;
          this.emit('contract', 'Clause', `ensures ${clause.label} failed`);
          throw new AetherFault(
            this.fault('postcondition', `postcondition ${clause.label} does not hold`, clause.label),
          );
        }
      }
      this.emit('return', 'Return', formatValue(returned, this.heap));
      return returned;
    } finally {
      this.frames.pop();
    }
  }

  /** Execute the original forwarder's observable transitions while the
   * current module contains only the direct target call. This is deliberately
   * a reference-runtime profile; compiled and resumable lowering need their
   * own checked bindings before GC promotion may admit the rewrite. */
  private enterVirtualForward(binding: VirtualForwardBinding, args: readonly Value[]): Value {
    const wrapper = binding.wrapper;
    const parameter = wrapper.params[0];
    const scope: Scope = new Map([[parameter.symbol, args[0] ?? null]]);
    const preHeap = new Map<number, Map<string, Value>>();
    for (const [addr, record] of this.heap) preHeap.set(addr, new Map(record));
    const frame: Frame = {
      decl: wrapper,
      scopes: [scope],
      envelope: CapabilityEnvelope.of(),
      preHeap,
      preScope: new Map(scope),
    };
    this.frames.push(frame);
    this.emit('call', 'FunctionDecl', `${this.name(wrapper.symbol)}(${args.map((a) => formatValue(a, this.heap)).join(', ')})`);
    try {
      // The independently checked wrapper grammar is exactly
      // Block(Return(Call(target, Var(parameter)))). Each tick retains its
      // original position relative to the target and the step-budget fault.
      this.tick(); // Block
      this.tick(); // Return
      this.tick(); // Call
      const callee = this.functions.get(binding.target);
      if (!callee) throw new AetherFault(this.fault('unbound', `${this.name(binding.target)} is not loaded`, null));
      for (const cap of callee.capabilities) {
        if (frame.envelope.has(cap)) continue;
        throw new AetherFault(this.fault('capability_denied',
          `${this.name(binding.target)} needs ${cap}, which ${this.name(wrapper.symbol)} does not hold`, cap));
      }
      this.tick(); // Var
      const value = this.enter(callee, [this.lookup(parameter.symbol, frame)]);
      this.emit('return', 'Return', formatValue(value, this.heap));
      return value;
    } finally {
      this.frames.pop();
    }
  }

  // --- statements ----------------------------------------------------------

  private exec(stmt: Term, frame: Frame): void {
    this.tick();
    switch (stmt.kind) {
      case 'Block': {
        const scope: Scope = new Map();
        frame.scopes.push(scope);
        try {
          for (const s of stmt.stmts) this.exec(s, frame);
        } finally {
          frame.scopes.pop();
        }
        return;
      }
      case 'Let':
        this.setVar(frame.scopes[frame.scopes.length - 1], stmt.symbol, this.eval(stmt.init, frame, null));
        return;
      case 'Assign': {
        const value = this.eval(stmt.value, frame, null);
        this.write(stmt.target, value, frame);
        this.emit('assign', 'Assign', `${this.placeText(stmt.target)} := ${formatValue(value, this.heap)}`);
        return;
      }
      case 'If': {
        const test = this.truthy(this.eval(stmt.cond, frame, null));
        this.emit('branch', 'If', test ? 'then' : 'else');
        if (test) this.exec(stmt.then, frame);
        else if (stmt.otherwise) this.exec(stmt.otherwise, frame);
        return;
      }
      case 'While': {
        let iterations = 0;
        while (this.truthy(this.eval(stmt.cond, frame, null))) {
          this.emit('loop', 'While', `iteration ${iterations++}`);
          this.exec(stmt.body, frame);
          this.tick();
        }
        return;
      }
      case 'Return':
        throw new ReturnSignal(this.eval(stmt.value, frame, null));
      case 'Assert': {
        if (this.truthy(this.eval(stmt.expr, frame, null))) return;
        this.emit('assert', 'Assert', `${stmt.label} failed`);
        throw new AetherFault(this.fault('assertion', `assertion ${stmt.label} failed`, stmt.label));
      }
      case 'ExprStmt':
        this.eval(stmt.expr, frame, null);
        return;
      case 'Yield':
        this.emit('branch', 'Yield', 'cooperative yield');
        return;
      case 'Atomic': {
        const checkpoint = this.checkpoint('atomic');
        try {
          this.exec(stmt.body, frame);
        } catch (error) {
          if (!(error instanceof ReturnSignal)) this.restore(checkpoint);
          throw error;
        }
        return;
      }
      default:
        this.eval(stmt, frame, null);
    }
  }

  private placeText(target: Term): string {
    if (target.kind === 'Place') return [this.name(target.symbol), ...target.path].join('.');
    if (target.kind === 'Field') return `${this.placeText(target.object)}.${target.field}`;
    if (target.kind === 'Var') return this.name(target.symbol);
    return target.kind;
  }

  private write(target: Term, value: Value, frame: Frame): void {
    if (target.kind === 'Place') {
      if (target.path.length === 0) {
        const scope = this.scopeOf(target.symbol, frame);
        this.setVar(scope ?? frame.scopes[frame.scopes.length - 1], target.symbol, value);
        return;
      }
      let cursor = this.lookup(target.symbol, frame);
      for (const seg of target.path.slice(0, -1)) cursor = this.fieldOf(cursor, seg);
      if (!isRef(cursor)) {
        throw new AetherFault(this.fault('type_error', `${this.placeText(target)} is not a record`, null));
      }
      this.setField(cursor.addr, target.path[target.path.length - 1], value);
      return;
    }
    if (target.kind === 'Field') {
      const owner = this.eval(target.object, frame, null);
      if (!isRef(owner)) {
        throw new AetherFault(this.fault('type_error', `${this.placeText(target)} is not a record`, null));
      }
      this.setField(owner.addr, target.field, value);
      return;
    }
    if (target.kind === 'Var') {
      const scope = this.scopeOf(target.symbol, frame);
      this.setVar(scope ?? frame.scopes[frame.scopes.length - 1], target.symbol, value);
      return;
    }
    throw new AetherFault(this.fault('type_error', `${target.kind} is not assignable`, null));
  }

  private scopeOf(symbol: SymbolId, frame: Frame): Scope | null {
    for (let i = frame.scopes.length - 1; i >= 0; i--) {
      if (frame.scopes[i].has(symbol)) return frame.scopes[i];
    }
    return null;
  }

  private lookup(symbol: SymbolId, frame: Frame): Value {
    const scope = this.scopeOf(symbol, frame);
    if (!scope) {
      throw new AetherFault(this.fault('unbound', `${this.name(symbol)} is not bound`, null));
    }
    return scope.get(symbol)!;
  }

  private fieldOf(owner: Value, field: string): Value {
    if (!isRef(owner)) {
      throw new AetherFault(this.fault('type_error', `cannot read .${field} of a non-record`, null));
    }
    const record = this.heap.get(owner.addr);
    if (!record || !record.has(field)) {
      throw new AetherFault(this.fault('type_error', `no field ${field} at @${owner.addr}`, null));
    }
    return record.get(field)!;
  }

  private truthy(v: Value): boolean {
    if (typeof v === 'boolean') return v;
    throw new AetherFault(this.fault('type_error', `expected a boolean, got ${formatValue(v, this.heap)}`, null));
  }

  // --- expressions ---------------------------------------------------------

  /**
   * `result` is bound only while evaluating a postcondition, and `old(…)`
   * reads the entry-time heap, which the frame kept.
   */
  private eval(expr: Term, frame: Frame, result: Value | null, old = false): Value {
    this.tick();
    switch (expr.kind) {
      case 'Lit': return expr.value;
      case 'Var': {
        if (old) {
          const snapshot = frame.preScope.get(expr.symbol);
          if (snapshot !== undefined) return snapshot;
        }
        return this.lookup(expr.symbol, frame);
      }
      case 'Place': {
        let cursor = old ? frame.preScope.get(expr.symbol) ?? this.lookup(expr.symbol, frame)
                         : this.lookup(expr.symbol, frame);
        for (const seg of expr.path) cursor = this.readField(cursor, seg, old, frame);
        return cursor;
      }
      case 'Field':
        return this.readField(this.eval(expr.object, frame, result, old), expr.field, old, frame);
      case 'Old': return this.eval(expr.expr, frame, result, true);
      case 'ResultRef':
        if (result === null) return null;
        return result;
      case 'Un': {
        const operand = this.eval(expr.operand, frame, result, old);
        if (expr.op === 'not') return !this.truthy(operand);
        if (typeof operand !== 'bigint') {
          throw new AetherFault(this.fault('type_error', 'unary - needs an integer', null));
        }
        return -operand;
      }
      case 'Bin': return this.binary(expr.op, expr, frame, result, old);
      case 'Cond':
        return this.truthy(this.eval(expr.cond, frame, result, old))
          ? this.eval(expr.then, frame, result, old)
          : this.eval(expr.otherwise, frame, result, old);
      case 'RecordLit': {
        const fields: Array<readonly [string, Value]> = expr.fields.map(
          ([name, value]) => [name, this.eval(value, frame, result, old)] as const,
        );
        const ref = this.allocate(fields);
        this.emit('alloc', 'RecordLit', `@${ref.addr}`);
        return ref;
      }
      case 'ResultValue':
        return { variant: expr.variant, value: this.eval(expr.value, frame, result, old) };
      case 'MatchResult': {
        const matched = this.eval(expr.value, frame, result, old);
        if (!isResultValue(matched)) {
          throw new AetherFault(this.fault('type_error', 'match expects a Result value', null));
        }
        const scope: Scope = new Map();
        scope.set(matched.variant === 'ok' ? expr.okSymbol : expr.errSymbol, matched.value);
        frame.scopes.push(scope);
        try {
          return this.eval(matched.variant === 'ok' ? expr.ok : expr.err, frame, result, old);
        } finally {
          frame.scopes.pop();
        }
      }
      case 'SeqLit': return expr.items.map((item) => this.eval(item, frame, result, old));
      case 'SeqIndex': {
        const sequence = this.eval(expr.sequence, frame, result, old);
        const index = this.eval(expr.index, frame, result, old);
        if (!isSeqValue(sequence) || typeof index !== 'bigint') {
          throw new AetherFault(this.fault('type_error', 'index expects a sequence and integer', null));
        }
        if (index < 0n || index >= BigInt(sequence.length)) {
          throw new AetherFault(this.fault('type_error', `sequence index ${index} is out of bounds`, null));
        }
        return sequence[Number(index)];
      }
      case 'SeqLength': {
        const sequence = this.eval(expr.sequence, frame, result, old);
        if (!isSeqValue(sequence)) throw new AetherFault(this.fault('type_error', 'length expects a sequence', null));
        return BigInt(sequence.length);
      }
      case 'SeqMap': {
        const sequence = this.eval(expr.sequence, frame, result, old);
        if (!isSeqValue(sequence)) throw new AetherFault(this.fault('type_error', 'map expects a sequence', null));
        return sequence.map((item) => this.callFrom(frame, expr.callee, [item]));
      }
      case 'SeqFold': {
        const sequence = this.eval(expr.sequence, frame, result, old);
        if (!isSeqValue(sequence)) throw new AetherFault(this.fault('type_error', 'fold expects a sequence', null));
        let accumulator = this.eval(expr.initial, frame, result, old);
        for (const item of sequence) accumulator = this.callFrom(frame, expr.callee, [accumulator, item]);
        return accumulator;
      }
      case 'Lambda': {
        const captured = frame.scopes.map((scope) => new Map(scope));
        const envelope = frame.envelope.attenuate(expr.capabilities);
        const preHeap = new Map<number, Map<string, Value>>();
        for (const [addr, record] of this.heap) preHeap.set(addr, new Map(record));
        return {
          closure: true,
          capabilities: [...expr.capabilities],
          invoke: (args: readonly Value[]) => {
            const parameters: Scope = new Map();
            expr.params.forEach((param, index) => parameters.set(param.symbol, args[index] ?? null));
            const closureFrame: Frame = {
              decl: frame.decl,
              scopes: [...captured.map((scope) => new Map(scope)), parameters],
              envelope,
              preHeap,
              preScope: new Map(parameters),
            };
            this.frames.push(closureFrame);
            try {
              return this.eval(expr.body, closureFrame, null, old);
            } finally {
              this.frames.pop();
            }
          },
        };
      }
      case 'Apply': {
        const closure = this.eval(expr.fn, frame, result, old);
        if (!isClosureValue(closure)) {
          throw new AetherFault(this.fault('type_error', 'apply expects a closure', null));
        }
        for (const capability of closure.capabilities) {
          if (!frame.envelope.has(capability)) {
            throw new AetherFault(this.fault('capability_denied', `closure requires ${capability}`, capability));
          }
        }
        return closure.invoke(expr.args.map((arg) => this.eval(arg, frame, result, old)));
      }
      case 'StringOp': {
        const args = expr.args.map((arg) => this.eval(arg, frame, result, old));
        const text = args[0];
        if (typeof text !== 'string') throw new AetherFault(this.fault('type_error', `${expr.op} expects a string`, null));
        switch (expr.op) {
          case 'strlen': return BigInt([...text].length);
          case 'contains':
            if (typeof args[1] !== 'string') throw new AetherFault(this.fault('type_error', 'contains expects a string', null));
            return text.includes(args[1]);
          case 'slice': {
            if (typeof args[1] !== 'bigint' || typeof args[2] !== 'bigint') {
              throw new AetherFault(this.fault('type_error', 'slice expects integer bounds', null));
            }
            return [...text].slice(Number(args[1]), Number(args[2])).join('');
          }
          case 'lower': return text.toLowerCase();
          case 'upper': return text.toUpperCase();
          case 'trim': return text.trim();
        }
      }
      case 'IntCast': {
        const value = this.eval(expr.value, frame, result, old);
        if (typeof value !== 'bigint') throw new AetherFault(this.fault('type_error', 'fixed-width conversion expects an integer', null));
        return normalizeFixed(value, expr.ty, (message) => new AetherFault(this.fault('type_error', message, null)));
      }
      case 'FixedBin': {
        const left = this.eval(expr.left, frame, result, old);
        const right = this.eval(expr.right, frame, result, old);
        if (typeof left !== 'bigint' || typeof right !== 'bigint') {
          throw new AetherFault(this.fault('type_error', 'fixed-width arithmetic expects integers', null));
        }
        if ((expr.op === 'div' || expr.op === 'mod') && right === 0n) {
          throw new AetherFault(this.fault('division_by_zero', `${expr.op} by zero`, null));
        }
        const value = expr.op === 'add' ? left + right
          : expr.op === 'sub' ? left - right
          : expr.op === 'mul' ? left * right
          : expr.op === 'div' ? left / right
          : left % right;
        return normalizeFixed(value, expr.ty, (message) => new AetherFault(this.fault('type_error', message, null)));
      }
      case 'ForAll': {
        const start = this.eval(expr.start, frame, result, old);
        const end = this.eval(expr.end, frame, result, old);
        if (typeof start !== 'bigint' || typeof end !== 'bigint') {
          throw new AetherFault(this.fault('type_error', 'forall bounds must be integers', null));
        }
        const scope: Scope = new Map();
        frame.scopes.push(scope);
        try {
          for (let value = start; value < end; value++) {
            scope.set(expr.symbol, value);
            if (!this.truthy(this.eval(expr.body, frame, result, old))) return false;
          }
          return true;
        } finally {
          frame.scopes.pop();
        }
      }
      case 'Spawn': {
        const captured = frame.scopes.map((scope) => new Map(scope));
        let settled = false;
        let value: Value = null;
        return {
          task: true,
          run: () => {
            if (settled) return value;
            const taskFrame: Frame = { ...frame, scopes: captured.map((scope) => new Map(scope)) };
            this.frames.push(taskFrame);
            try {
              value = this.eval(expr.body, taskFrame, result, old);
              settled = true;
              return value;
            } finally {
              this.frames.pop();
            }
          },
        };
      }
      case 'Await': {
        const task = this.eval(expr.task, frame, result, old);
        if (!isTaskValue(task)) throw new AetherFault(this.fault('type_error', 'await expects a task', null));
        return task.run();
      }
      case 'Call': {
        const virtual = this.virtualForwardSites.get(expr);
        if (virtual) {
          // The caller's Call tick happened above. The archived wrapper has
          // no capability demand; source arguments are evaluated once, before
          // the wrapper call event and its four body transitions.
          const args = expr.args.map((a) => this.eval(a, frame, result, old));
          return this.enterVirtualForward(virtual, args);
        }
        const callee = this.functions.get(expr.callee);
        if (!callee) {
          throw new AetherFault(this.fault('unbound', `${this.name(expr.callee)} is not loaded`, null));
        }
        for (const cap of callee.capabilities) {
          if (frame.envelope.has(cap)) continue;
          throw new AetherFault(this.fault(
            'capability_denied',
            `${this.name(expr.callee)} needs ${cap}, which ${this.name(frame.decl.symbol)} does not hold`,
            cap,
          ));
        }
        const args = expr.args.map((a) => this.eval(a, frame, result, old));
        return this.enter(callee, args);
      }
      case 'Invoke': return this.invoke(expr, frame, result, old);
      default:
        throw new AetherFault(this.fault('type_error', `${expr.kind} is not an expression`, null));
    }
  }

  private callFrom(frame: Frame, symbol: SymbolId, args: readonly Value[]): Value {
    const callee = this.functions.get(symbol);
    if (!callee) throw new AetherFault(this.fault('unbound', `${this.name(symbol)} is not loaded`, null));
    for (const cap of callee.capabilities) {
      if (!frame.envelope.has(cap)) {
        throw new AetherFault(this.fault(
          'capability_denied',
          `${this.name(callee.symbol)} needs ${cap}, which ${this.name(frame.decl.symbol)} does not hold`,
          cap,
        ));
      }
    }
    return this.enter(callee, args);
  }

  private readField(owner: Value, field: string, old: boolean, frame: Frame): Value {
    if (!old) return this.fieldOf(owner, field);
    if (!isRef(owner)) return this.fieldOf(owner, field);
    const snapshot = frame.preHeap.get(owner.addr);
    if (snapshot && snapshot.has(field)) return snapshot.get(field)!;
    return this.fieldOf(owner, field);
  }

  /**
   * The one door to the outside world.
   *
   * Three checks stand between an agent's code and an effect: the capability
   * must be declared by this function, it must be registered, and it must not
   * have been revoked. Revocation is consulted *here*, at the point of use,
   * which is what lets an operator disable a capability globally without
   * rebuilding or redeploying anything (§5).
   */
  private invoke(
    expr: Extract<Term, { kind: 'Invoke' }>,
    frame: Frame,
    result: Value | null,
    old: boolean,
  ): Value {
    if (!frame.envelope.has(expr.capability)) {
      throw new AetherFault(this.fault(
        'capability_denied',
        `${this.name(frame.decl.symbol)} may not invoke ${expr.capability}`,
        expr.capability,
      ));
    }
    if (this.opts.revocations?.isRevoked(expr.capability, this.opts.scope)) {
      throw new AetherFault(this.fault(
        'capability_revoked',
        `${expr.capability} has been revoked by an operator`,
        expr.capability,
      ));
    }
    const descriptor = this.opts.registry.get(expr.capability);
    if (!descriptor) {
      throw new AetherFault(this.fault('capability_denied', `${expr.capability} is not registered`, expr.capability));
    }
    const args = expr.args.map((a) => this.eval(a, frame, result, old));
    this.effectLog.push({ step: this.stepCount, capability: expr.capability, args });
    this.emit('invoke', 'Invoke', `${expr.capability}(${args.map((a) => formatValue(a, this.heap)).join(', ')})`);
    const handler = this.opts.effects?.get(expr.capability);
    if (!handler && !this.opts.effectRouter) return null;
    try {
      return this.opts.effectRouter ? this.opts.effectRouter.invoke(expr.capability, args) : handler!(args, frame.decl.symbol);
    } catch (e) {
      if (e instanceof AetherFault) throw e;
      if (e instanceof EffectInvocationError && e.outcome.state === 'indeterminate') {
        throw new AetherFault({ ...this.fault('effect_indeterminate', e.message, expr.capability), recoveryId: e.outcome.recoveryId });
      }
      throw new AetherFault(this.fault(
        'effect_failed',
        `${expr.capability} failed: ${e instanceof Error ? e.message : String(e)}`,
        expr.capability,
      ));
    }
  }

  private binary(
    op: BinOp,
    expr: Extract<Term, { kind: 'Bin' }>,
    frame: Frame,
    result: Value | null,
    old: boolean,
  ): Value {
    // Short-circuiting matters: `b !== 0 && a / b > 1` must not divide by zero.
    if (op === 'and') {
      return this.truthy(this.eval(expr.left, frame, result, old))
        ? this.truthy(this.eval(expr.right, frame, result, old))
        : false;
    }
    if (op === 'or') {
      return this.truthy(this.eval(expr.left, frame, result, old))
        ? true
        : this.truthy(this.eval(expr.right, frame, result, old));
    }

    const l = this.eval(expr.left, frame, result, old);
    const r = this.eval(expr.right, frame, result, old);

    if (op === 'eq' || op === 'ne') {
      const same = isRef(l) && isRef(r) ? l.addr === r.addr : l === r;
      return op === 'eq' ? same : !same;
    }
    if (op === 'concat') {
      if (typeof l !== 'string' || typeof r !== 'string') {
        throw new AetherFault(this.fault('type_error', '++ needs two strings', null));
      }
      return l + r;
    }
    if (typeof l !== 'bigint' || typeof r !== 'bigint') {
      throw new AetherFault(this.fault(
        'type_error',
        `${op} needs two integers, got ${formatValue(l, this.heap)} and ${formatValue(r, this.heap)}`,
        null,
      ));
    }
    switch (op) {
      case 'add': return l + r;
      case 'sub': return l - r;
      case 'mul': return l * r;
      case 'div':
      case 'mod':
        if (r === 0n) {
          throw new AetherFault(this.fault('division_by_zero', `${op} by zero`, null));
        }
        // Truncating division, matching the axioms the verifier asserts.
        return op === 'div' ? l / r : l % r;
      case 'lt': return l < r;
      case 'le': return l <= r;
      case 'gt': return l > r;
      case 'ge': return l >= r;
      default:
        throw new AetherFault(this.fault('type_error', `unknown operator ${op}`, null));
    }
  }

  /** Render the trace for a human reading a failure report. */
  formatTrace(limit = 40): string {
    return this.events
      .slice(-limit)
      .map((e) => `${String(e.step).padStart(5)} ${'  '.repeat(e.depth)}${e.kind}: ${e.detail}`)
      .join('\n');
  }
}

function normalizeFixed(
  value: bigint,
  ty: Extract<Ty, { t: 'IntN' }>,
  fault: (message: string) => Error,
): bigint {
  const width = 1n << BigInt(ty.bits);
  const min = ty.signed ? -(1n << BigInt(ty.bits - 1)) : 0n;
  const max = ty.signed ? (1n << BigInt(ty.bits - 1)) - 1n : width - 1n;
  if (value >= min && value <= max) return value;
  if (ty.overflow === 'trap') throw fault(`${ty.signed ? 'i' : 'u'}${ty.bits} overflow: ${value}`);
  if (ty.overflow === 'saturate') return value < min ? min : max;
  const wrapped = ((value - min) % width + width) % width + min;
  return wrapped;
}
