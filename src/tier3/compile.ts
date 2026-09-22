/**
 * The production runtime (Risk R2).
 *
 * The development runtime in `runtime.ts` journals every state change with its
 * inverse, so that an agent can rewind, fork and inspect. That is exactly the
 * overhead you do not want in production, and the PRD's mitigation for it is a
 * dual-runtime model: one engine for agents to debug in, another that emits a
 * stripped artifact with no trace machinery at all.
 *
 * This is that second engine. Three things go away:
 *
 *   1. **The journal.** No deltas, no checkpoints, no rewind. Mutation is a
 *      direct write.
 *   2. **The interpreter loop.** Each node is compiled once into a closure, so
 *      execution is a tree of direct calls rather than a `switch` over node
 *      kinds. Names are resolved to frame slots at compile time; there is no
 *      scope chain to walk at runtime.
 *   3. **Contract checks that were already proved.**
 *
 * The third is the interesting one, and it is where Tier 2 pays for itself.
 *
 * ### The elision policy: pay for what you could not prove
 *
 * A postcondition the SMT solver discharged cannot fail, so checking it in
 * production buys nothing. A clause that was only property-checked *can* fail,
 * so it is kept. The compiler therefore takes the verification reports as
 * input and elides exactly the obligations that came back `proved`, recording
 * a decision and a reason for every clause — which is the artifact an auditor
 * needs to answer "what does production not check, and why is that safe?".
 *
 * **Preconditions are different, and are kept by default.** A function's own
 * preconditions are *assumptions* during its verification, discharged at each
 * call site instead. Eliding one is only sound if every possible caller is
 * known and verified, which is false for anything an external client can
 * reach. So a precondition is elided only when the caller explicitly declares
 * the module's entry points and every internal call site proved it.
 *
 * What does *not* go away is security. Capability discipline is not telemetry:
 * the static grant is checked at compile time as before, and the operator's
 * revocation list is still consulted at the point of use, because §5 requires
 * revocation to take effect without a redeploy.
 */

import { children, type BinOp, type Param, type Term, type Ty } from '../tier1/ast.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import { GraphStore } from '../tier1/store.ts';
import { CapabilityEnvelope, type CapabilityRegistry, type RevocationList } from '../tier2/ocap.ts';
import { underlying } from '../tier2/typecheck.ts';
import type { VerificationReport } from '../tier2/verify.ts';
import type { ExecutionResult, Fault, FaultKind } from './runtime.ts';
import { formatValue, isClosureValue, isRef, isResultValue, isSeqValue, type Ref, type Value } from './values.ts';

// ---------------------------------------------------------------------------
// compiled representation
// ---------------------------------------------------------------------------

/** A record in the production heap. A plain object, not a Map. */
type HeapRecord = Record<string, Value>;

interface Frame {
  /** Locals, resolved to indices at compile time. */
  readonly s: Value[];
  /** Pre-state values for `old(…)`, evaluated at entry when any are needed. */
  o: readonly Value[];
  /** The returned value, bound only while postconditions run. */
  r: Value;
}

type ExprFn = (f: Frame) => Value;

/** A statement returns a value if it returned, or FALLTHROUGH if it did not. */
const FALLTHROUGH: unique symbol = Symbol('fallthrough');
type StmtFn = (f: Frame) => Value | typeof FALLTHROUGH;

class ProductionFault extends Error {
  readonly kind: FaultKind;
  readonly label: string | null;
  constructor(kind: FaultKind, message: string, label: string | null = null) {
    super(message);
    this.name = 'ProductionFault';
    this.kind = kind;
    this.label = label;
  }
}

interface CompiledFunction {
  readonly symbol: SymbolId;
  readonly slots: number;
  readonly params: readonly Param[];
  readonly preconditions: ReadonlyArray<{ label: string; test: ExprFn }>;
  /** `old(…)` subterms, evaluated at entry. Empty when no postcondition needs one. */
  readonly olds: readonly ExprFn[];
  readonly body: StmtFn;
  readonly postconditions: ReadonlyArray<{ label: string; test: ExprFn }>;
}

// ---------------------------------------------------------------------------
// compilation report
// ---------------------------------------------------------------------------

export type ClauseKind = 'precondition' | 'postcondition' | 'assertion';
export type Decision = 'kept' | 'elided';

export interface ClauseDecision {
  readonly function: string;
  readonly kind: ClauseKind;
  readonly label: string;
  readonly decision: Decision;
  readonly reason: string;
}

export interface CompilationReport {
  readonly functions: number;
  readonly clausesKept: number;
  readonly clausesElided: number;
  readonly decisions: readonly ClauseDecision[];
  readonly policy: ElisionPolicy;
}

/**
 * `verified_elision` — drop exactly what the solver proved.
 * `enforce`          — check everything, whatever was proved.
 * `elide`            — check nothing. Fastest, and explicitly a risk decision.
 */
export type ElisionPolicy = 'verified_elision' | 'enforce' | 'elide';

export interface CompileOptions {
  readonly registry: CapabilityRegistry;
  readonly symbols?: SymbolSpace;
  readonly revocations?: RevocationList;
  readonly effects?: ReadonlyMap<CapabilityName, (args: readonly Value[]) => Value>;
  /** Verification results, keyed by function symbol. Required for elision. */
  readonly verification?: ReadonlyMap<SymbolId, VerificationReport>;
  readonly policy?: ElisionPolicy;
  /**
   * Functions reachable from outside this artifact. Anything *not* listed can
   * have its preconditions elided when every internal call site proved them.
   * Omitted means "assume every function is externally reachable", which is
   * the safe default and elides no precondition at all.
   */
  readonly entryPoints?: readonly SymbolId[];
  readonly scope?: string;
}

// ---------------------------------------------------------------------------
// the runtime
// ---------------------------------------------------------------------------

export class ProductionRuntime {
  private readonly heap: HeapRecord[] = [{}]; // index 0 is never a valid address
  private readonly compiled = new Map<SymbolId, CompiledFunction>();
  private readonly opts: CompileOptions;
  private readonly decisions: ClauseDecision[] = [];
  private readonly declarations = new Map<SymbolId, Extract<Term, { kind: 'FunctionDecl' }>>();
  private reportCache: CompilationReport | null = null;

  private constructor(opts: CompileOptions) {
    this.opts = opts;
  }

  /**
   * Compile a module into a stripped artifact.
   *
   * Two passes, because a call's capability requirement has to be checkable
   * before the callee's own body has been compiled — mutual recursion would
   * otherwise decide which checks happen by declaration order.
   */
  static compile(module: Term, opts: CompileOptions): ProductionRuntime {
    const rt = new ProductionRuntime(opts);
    const declarations: Array<Extract<Term, { kind: 'FunctionDecl' }>> = [];
    const collect = (t: Term): void => {
      if (t.kind === 'FunctionDecl') {
        rt.declaredCapabilities.set(t.symbol, t.capabilities);
        rt.declarations.set(t.symbol, t);
        for (const cap of t.capabilities) {
          if (!opts.registry.get(cap)) {
            throw new TypeError(`${rt.name(t.symbol)} declares unregistered capability ${cap}`);
          }
        }
        if (t.body !== null) declarations.push(t);
      }
      if (t.kind === 'Module') for (const m of t.members) collect(m);
    };
    collect(module);
    for (const decl of declarations) rt.compileFunction(decl);
    return rt;
  }

  get report(): CompilationReport {
    if (!this.reportCache) {
      this.reportCache = {
        functions: this.compiled.size,
        clausesKept: this.decisions.filter((d) => d.decision === 'kept').length,
        clausesElided: this.decisions.filter((d) => d.decision === 'elided').length,
        decisions: this.decisions,
        policy: this.opts.policy ?? 'verified_elision',
      };
    }
    return this.reportCache;
  }

  private name(symbol: SymbolId): string {
    return this.opts.symbols?.nameOf(symbol) ?? symbol;
  }

  // --- heap ----------------------------------------------------------------

  allocateRecord(ty: Ty, fields: Record<string, Value>): Ref {
    const base = underlying(ty);
    if (base.t !== 'Record') throw new TypeError(`${ty.t} is not a record type`);
    const record: HeapRecord = {};
    for (const [name] of base.fields) record[name] = fields[name] ?? null;
    this.heap.push(record);
    return { addr: this.heap.length - 1 };
  }

  readRecord(ref: Ref): ReadonlyMap<string, Value> {
    const record = this.heap[ref.addr];
    if (!record) throw new RangeError(`no record at @${ref.addr}`);
    return new Map(Object.entries(record));
  }

  /**
   * Heap snapshot in the same shape — and with the same rendering — the
   * development runtime reports, so the two can be compared directly. The
   * equivalence test is only meaningful if both sides format values through
   * the same function rather than through two that happen to agree today.
   */
  snapshot(): Record<string, Record<string, string>> {
    const view = new Map<number, Map<string, Value>>();
    for (let addr = 1; addr < this.heap.length; addr++) {
      view.set(addr, new Map(Object.entries(this.heap[addr])));
    }
    const out: Record<string, Record<string, string>> = {};
    for (const [addr, record] of view) {
      out[`@${addr}`] = Object.fromEntries(
        [...record.entries()].map(([k, v]) => [k, formatValue(v, view)]),
      );
    }
    return out;
  }

  // --- calling -------------------------------------------------------------

  call(symbol: SymbolId, args: readonly Value[]): ExecutionResult {
    const fn = this.compiled.get(symbol);
    if (!fn) {
      return {
        ok: false,
        fault: this.fault('unbound', `${this.name(symbol)} is not compiled into this artifact`, null),
        steps: 0,
      };
    }
    try {
      return { ok: true, value: this.enter(fn, args), steps: 0 };
    } catch (e) {
      if (e instanceof ProductionFault) {
        return { ok: false, fault: this.fault(e.kind, e.message, e.label), steps: 0 };
      }
      throw e;
    }
  }

  /**
   * Faults carry no binding snapshot here. Collecting one is development
   * telemetry, and this runtime exists precisely to not pay for that; the
   * clause label and the fault kind are what a production alert needs.
   */
  private fault(kind: FaultKind, message: string, label: string | null): Fault {
    return { kind, message, label, step: 0, bindings: {} };
  }

  private enter(fn: CompiledFunction, args: readonly Value[]): Value {
    const slots = new Array<Value>(fn.slots).fill(null);
    for (let i = 0; i < fn.params.length; i++) slots[i] = args[i] ?? null;
    const frame: Frame = { s: slots, o: [], r: null };

    for (const pre of fn.preconditions) {
      if (pre.test(frame) !== true) {
        throw new ProductionFault('precondition', `precondition ${pre.label} does not hold`, pre.label);
      }
    }
    if (fn.olds.length) frame.o = fn.olds.map((e) => e(frame));

    const outcome = fn.body(frame);
    const returned = outcome === FALLTHROUGH ? null : outcome;

    if (fn.postconditions.length) {
      frame.r = returned;
      for (const post of fn.postconditions) {
        if (post.test(frame) !== true) {
          throw new ProductionFault('postcondition', `postcondition ${post.label} does not hold`, post.label);
        }
      }
    }
    return returned;
  }

  // --- compilation ---------------------------------------------------------

  private compileFunction(decl: Extract<Term, { kind: 'FunctionDecl' }>): void {
    if (this.compiled.has(decl.symbol)) return;

    const slots = new Map<SymbolId, number>();
    for (const p of decl.params) slots.set(p.symbol, slots.size);
    for (const s of decl.surfaces) {
      if (s.kind === 'Surface') slots.set(s.symbol, slots.size);
    }
    // Locals are allocated a slot each; reuse across sibling blocks is a
    // register-allocation problem this compiler does not need to solve.
    const allocate = (t: Term): void => {
      if (t.kind === 'Let') slots.set(t.symbol, slots.size);
      if (t.kind === 'MatchResult') {
        slots.set(t.okSymbol, slots.size);
        slots.set(t.errSymbol, slots.size);
      }
      if (t.kind === 'Lambda') for (const param of t.params) slots.set(param.symbol, slots.size);
      if (t.kind === 'ForAll') slots.set(t.symbol, slots.size);
      for (const child of childTerms(t)) allocate(child);
    };
    if (decl.body) allocate(decl.body);

    const olds: ExprFn[] = [];
    const ctx: Ctx = {
      slots,
      olds,
      envelope: CapabilityEnvelope.of(...decl.capabilities),
      functionName: this.name(decl.symbol),
      keptAssertions: this.keptClauses(decl, 'assertion'),
    };

    const contract = decl.contract?.kind === 'Contract' ? decl.contract : null;
    const keptPre = this.keptClauses(decl, 'precondition');
    const keptPost = this.keptClauses(decl, 'postcondition');

    const preconditions: Array<{ label: string; test: ExprFn }> = [];
    for (const clause of contract?.requires ?? []) {
      if (clause.kind !== 'Clause') continue;
      if (!keptPre.has(clause.label)) continue;
      preconditions.push({ label: clause.label, test: this.expr(clause.expr, ctx) });
    }

    const postconditions: Array<{ label: string; test: ExprFn }> = [];
    for (const clause of contract?.ensures ?? []) {
      if (clause.kind !== 'Clause') continue;
      if (!keptPost.has(clause.label)) continue;
      postconditions.push({ label: clause.label, test: this.expr(clause.expr, ctx) });
    }

    // Seed surfaces into their slots via a prelude, so a tuned parameter is a
    // constant load rather than a lookup.
    const surfaceInit: Array<[number, Value]> = [];
    for (const s of decl.surfaces) {
      if (s.kind !== 'Surface') continue;
      surfaceInit.push([slots.get(s.symbol)!, s.current]);
    }

    const compiledBody = decl.body ? this.stmt(decl.body, ctx) : (() => FALLTHROUGH) as StmtFn;
    const body: StmtFn = surfaceInit.length
      ? (f) => {
          for (const [slot, value] of surfaceInit) f.s[slot] = value;
          return compiledBody(f);
        }
      : compiledBody;

    this.compiled.set(decl.symbol, {
      symbol: decl.symbol,
      slots: slots.size,
      params: decl.params,
      preconditions,
      olds,
      body,
      postconditions,
    });
  }

  /** Why a report cannot authorize removal of runtime checks. */
  private reportProblem(
    decl: Extract<Term, { kind: 'FunctionDecl' }>,
    report: VerificationReport,
  ): string | null {
    if (report.symbol !== decl.symbol) return 'verification result belongs to a different symbol';
    const subject = new GraphStore().intern(decl);
    if (report.subject !== subject) return 'verification result belongs to different declaration contents';
    if (report.budgetExhausted) return 'verification was incomplete';
    if (report.assumptions.length) return 'verification rests on unenforced modelling assumptions';
    if (report.frameViolations.length) return 'verification reported frame violations';
    if (report.verdict === 'refuted' || report.verdict === 'unproven') {
      return `verification verdict was ${report.verdict}`;
    }
    for (const dependency of report.dependencies) {
      const current = this.declarations.get(dependency.symbol);
      if (!current || new GraphStore().intern(current) !== dependency.subject) {
        return `callee ${this.name(dependency.symbol)} changed after verification`;
      }
      const depReport = this.opts.verification?.get(dependency.symbol);
      if (!depReport || depReport.subject !== dependency.subject || depReport.budgetExhausted ||
          depReport.assumptions.length || depReport.frameViolations.length ||
          depReport.verdict === 'refuted' || depReport.verdict === 'unproven') {
        return `callee ${this.name(dependency.symbol)} has no admissible verification result`;
      }
    }
    return null;
  }

  /**
   * Which clauses of a kind survive into the artifact.
   *
   * Under `verified_elision` a clause is dropped only if the verifier came
   * back `proved` for it. `unproven`, `delegated` and `refuted` all keep the
   * check — a clause resting on property evidence is exactly the one you want
   * a runtime guard on.
   */
  private keptClauses(
    decl: Extract<Term, { kind: 'FunctionDecl' }>,
    kind: ClauseKind,
  ): Set<string> {
    const contract = decl.contract?.kind === 'Contract' ? decl.contract : null;
    const labels = new Set<string>();
    if (kind === 'precondition') for (const c of contract?.requires ?? []) {
      if (c.kind === 'Clause') labels.add(c.label);
    }
    if (kind === 'postcondition') for (const c of contract?.ensures ?? []) {
      if (c.kind === 'Clause') labels.add(c.label);
    }
    if (kind === 'assertion') collectAssertLabels(decl.body, labels);

    const fnName = this.name(decl.symbol);
    const policy = this.opts.policy ?? 'verified_elision';
    const record = (label: string, decision: Decision, reason: string) => {
      this.decisions.push({ function: fnName, kind, label, decision, reason });
    };

    if (policy === 'enforce') {
      for (const label of labels) record(label, 'kept', 'policy: enforce');
      return labels;
    }
    if (policy === 'elide') {
      for (const label of labels) record(label, 'elided', 'policy: elide (unchecked by choice)');
      return new Set();
    }

    const report = this.opts.verification?.get(decl.symbol);
    if (!report) {
      for (const label of labels) record(label, 'kept', 'no verification result for this function');
      return labels;
    }
    const reportProblem = this.reportProblem(decl, report);
    if (reportProblem) {
      for (const label of labels) record(label, 'kept', reportProblem);
      return labels;
    }

    const proved = new Set<string>();
    for (const result of report.results) {
      if (result.verdict !== 'proved') continue;
      const o = result.obligation;
      if (kind === 'postcondition' && o.kind === 'postcondition' && o.clause) proved.add(o.clause);
      if (kind === 'assertion' && o.kind === 'assertion' && o.clause) proved.add(o.clause);
    }

    const kept = new Set<string>();
    for (const label of labels) {
      if (kind === 'precondition') {
        const verdict = this.precondition(decl.symbol, label, fnName);
        if (verdict.elide) record(label, 'elided', verdict.reason);
        else {
          record(label, 'kept', verdict.reason);
          kept.add(label);
        }
        continue;
      }
      if (proved.has(label)) {
        record(label, 'elided', 'discharged by the SMT solver; it cannot fail');
        continue;
      }
      const result = report.results.find((r) => r.obligation.clause === label);
      record(
        label,
        'kept',
        result ? `verdict was ${result.verdict}, not proved` : 'no obligation was emitted for it',
      );
      kept.add(label);
    }
    return kept;
  }

  /**
   * A precondition may only be elided when nobody outside the artifact can
   * call the function, and every call site inside it proved the clause.
   */
  private precondition(
    symbol: SymbolId,
    label: string,
    fnName: string,
  ): { elide: boolean; reason: string } {
    void fnName;
    const entryPoints = this.opts.entryPoints;
    if (!entryPoints) {
      return { elide: false, reason: 'entry points not declared; assume an external caller' };
    }
    if (entryPoints.includes(symbol)) {
      return { elide: false, reason: 'an entry point; its callers are outside this artifact' };
    }

    let sites = 0;
    for (const caller of this.declarations.values()) {
      const expected = countCalls(caller.body, symbol);
      if (expected === 0) continue;
      const report = this.opts.verification?.get(caller.symbol);
      if (!report) return { elide: false, reason: `caller ${this.name(caller.symbol)} was not verified` };
      const problem = this.reportProblem(caller, report);
      if (problem) return { elide: false, reason: `caller ${this.name(caller.symbol)}: ${problem}` };
      const matching = report.results.filter((result) => {
        const o = result.obligation;
        return o.kind === 'precondition_at_call' && o.callee === symbol && o.clause === label;
      });
      if (matching.length !== expected) {
        return { elide: false, reason: `caller ${this.name(caller.symbol)} has incomplete call-site evidence` };
      }
      sites += expected;
      const failed = matching.find((result) => result.verdict !== 'proved');
      if (failed) return { elide: false, reason: `a call site left it ${failed.verdict}` };
    }
    if (sites === 0) {
      return { elide: false, reason: 'not an entry point, but no verified call site was found either' };
    }
    return { elide: true, reason: `established at all ${sites} verified call site(s)` };
  }

  // --- expression compilation ----------------------------------------------

  private expr(term: Term, ctx: Ctx): ExprFn {
    switch (term.kind) {
      case 'Lit': {
        const value = term.value;
        return () => value;
      }
      case 'Var': {
        const slot = this.slotOf(term.symbol, ctx);
        return (f) => f.s[slot];
      }
      case 'Place': {
        const slot = this.slotOf(term.symbol, ctx);
        if (term.path.length === 0) return (f) => f.s[slot];
        const path = [...term.path];
        const heap = this.heap;
        return (f) => {
          let cursor = f.s[slot];
          for (const seg of path) cursor = readField(heap, cursor, seg);
          return cursor;
        };
      }
      case 'Field': {
        const object = this.expr(term.object, ctx);
        const field = term.field;
        const heap = this.heap;
        return (f) => readField(heap, object(f), field);
      }
      case 'Old': {
        // Evaluated once at entry; the body reads the slot, not the heap.
        const inner = this.expr(term.expr, ctx);
        const index = ctx.olds.length;
        ctx.olds.push(inner);
        return (f) => f.o[index];
      }
      case 'ResultRef':
        return (f) => f.r;
      case 'Un': {
        const operand = this.expr(term.operand, ctx);
        if (term.op === 'not') return (f) => !asBool(operand(f));
        return (f) => -asInt(operand(f), 'unary -');
      }
      case 'Cond': {
        const cond = this.expr(term.cond, ctx);
        const then = this.expr(term.then, ctx);
        const otherwise = this.expr(term.otherwise, ctx);
        return (f) => (asBool(cond(f)) ? then(f) : otherwise(f));
      }
      case 'Bin': return this.binary(term, ctx);
      case 'RecordLit': {
        const ty = term.ty;
        const fields = term.fields.map(([n, v]) => [n, this.expr(v, ctx)] as const);
        return (f) => {
          const values: Record<string, Value> = {};
          for (const [n, fn] of fields) values[n] = fn(f);
          return this.allocateRecord(ty, values);
        };
      }
      case 'ResultValue': {
        const value = this.expr(term.value, ctx);
        const variant = term.variant;
        return (f) => ({ variant, value: value(f) });
      }
      case 'MatchResult': {
        const value = this.expr(term.value, ctx);
        const ok = this.expr(term.ok, ctx);
        const err = this.expr(term.err, ctx);
        const okSlot = this.slotOf(term.okSymbol, ctx);
        const errSlot = this.slotOf(term.errSymbol, ctx);
        return (f) => {
          const matched = value(f);
          if (!isResultValue(matched)) throw new ProductionFault('type_error', 'match expects a Result value');
          if (matched.variant === 'ok') {
            f.s[okSlot] = matched.value;
            return ok(f);
          }
          f.s[errSlot] = matched.value;
          return err(f);
        };
      }
      case 'SeqLit': {
        const items = term.items.map((item) => this.expr(item, ctx));
        return (f) => items.map((item) => item(f));
      }
      case 'SeqIndex': {
        const sequence = this.expr(term.sequence, ctx);
        const index = this.expr(term.index, ctx);
        return (f) => {
          const values = sequence(f);
          const at = index(f);
          if (!isSeqValue(values) || typeof at !== 'bigint') {
            throw new ProductionFault('type_error', 'index expects a sequence and integer');
          }
          if (at < 0n || at >= BigInt(values.length)) {
            throw new ProductionFault('type_error', `sequence index ${at} is out of bounds`);
          }
          return values[Number(at)];
        };
      }
      case 'SeqLength': {
        const sequence = this.expr(term.sequence, ctx);
        return (f) => {
          const values = sequence(f);
          if (!isSeqValue(values)) throw new ProductionFault('type_error', 'length expects a sequence');
          return BigInt(values.length);
        };
      }
      case 'SeqMap': {
        const sequence = this.expr(term.sequence, ctx);
        const callback = this.callback(term.callee, ctx);
        return (f) => {
          const values = sequence(f);
          if (!isSeqValue(values)) throw new ProductionFault('type_error', 'map expects a sequence');
          return values.map((item) => callback([item]));
        };
      }
      case 'SeqFold': {
        const sequence = this.expr(term.sequence, ctx);
        const initial = this.expr(term.initial, ctx);
        const callback = this.callback(term.callee, ctx);
        return (f) => {
          const values = sequence(f);
          if (!isSeqValue(values)) throw new ProductionFault('type_error', 'fold expects a sequence');
          let accumulator = initial(f);
          for (const item of values) accumulator = callback([accumulator, item]);
          return accumulator;
        };
      }
      case 'Lambda': {
        for (const capability of term.capabilities) {
          if (!ctx.envelope.has(capability)) {
            throw new TypeError(`${ctx.functionName} cannot capture ${capability}`);
          }
        }
        const body = this.expr(term.body, ctx);
        const paramSlots = term.params.map((param) => this.slotOf(param.symbol, ctx));
        const capabilities = [...term.capabilities];
        return (frame) => {
          const captured = [...frame.s];
          return {
            closure: true,
            capabilities,
            invoke: (args: readonly Value[]) => {
              const slots = [...captured];
              paramSlots.forEach((slot, index) => { slots[slot] = args[index] ?? null; });
              return body({ s: slots, o: frame.o, r: null });
            },
          };
        };
      }
      case 'Apply': {
        const closure = this.expr(term.fn, ctx);
        const args = term.args.map((arg) => this.expr(arg, ctx));
        const envelope = ctx.envelope;
        return (frame) => {
          const value = closure(frame);
          if (!isClosureValue(value)) throw new ProductionFault('type_error', 'apply expects a closure');
          for (const capability of value.capabilities) {
            if (!envelope.has(capability)) throw new ProductionFault('capability_denied', `closure requires ${capability}`);
          }
          return value.invoke(args.map((arg) => arg(frame)));
        };
      }
      case 'StringOp': {
        const args = term.args.map((arg) => this.expr(arg, ctx));
        const op = term.op;
        return (frame) => {
          const values = args.map((arg) => arg(frame));
          const value = values[0];
          if (typeof value !== 'string') throw new ProductionFault('type_error', `${op} expects a string`);
          switch (op) {
            case 'strlen': return BigInt([...value].length);
            case 'contains':
              if (typeof values[1] !== 'string') throw new ProductionFault('type_error', 'contains expects a string');
              return value.includes(values[1]);
            case 'slice':
              if (typeof values[1] !== 'bigint' || typeof values[2] !== 'bigint') {
                throw new ProductionFault('type_error', 'slice expects integer bounds');
              }
              return [...value].slice(Number(values[1]), Number(values[2])).join('');
            case 'lower': return value.toLowerCase();
            case 'upper': return value.toUpperCase();
            case 'trim': return value.trim();
          }
        };
      }
      case 'IntCast': {
        const value = this.expr(term.value, ctx);
        const ty = term.ty;
        return (frame) => {
          const integer = value(frame);
          if (typeof integer !== 'bigint') throw new ProductionFault('type_error', 'fixed-width conversion expects an integer');
          return normalizeFixed(integer, ty);
        };
      }
      case 'FixedBin': {
        const left = this.expr(term.left, ctx);
        const right = this.expr(term.right, ctx);
        const op = term.op;
        const ty = term.ty;
        return (frame) => {
          const l = left(frame);
          const r = right(frame);
          if (typeof l !== 'bigint' || typeof r !== 'bigint') {
            throw new ProductionFault('type_error', 'fixed-width arithmetic expects integers');
          }
          if ((op === 'div' || op === 'mod') && r === 0n) throw new ProductionFault('division_by_zero', `${op} by zero`);
          const value = op === 'add' ? l + r : op === 'sub' ? l - r : op === 'mul' ? l * r : op === 'div' ? l / r : l % r;
          return normalizeFixed(value, ty);
        };
      }
      case 'ForAll': {
        const start = this.expr(term.start, ctx);
        const end = this.expr(term.end, ctx);
        const body = this.expr(term.body, ctx);
        const slot = this.slotOf(term.symbol, ctx);
        return (frame) => {
          const lower = start(frame);
          const upper = end(frame);
          if (typeof lower !== 'bigint' || typeof upper !== 'bigint') {
            throw new ProductionFault('type_error', 'forall bounds must be integers');
          }
          for (let value = lower; value < upper; value++) {
            frame.s[slot] = value;
            if (body(frame) !== true) return false;
          }
          return true;
        };
      }
      case 'Call': {
        const args = term.args.map((a) => this.expr(a, ctx));
        const callee = term.callee;
        for (const cap of this.calleeCapabilities(callee)) {
          if (ctx.envelope.has(cap)) continue;
          throw new TypeError(
            `${ctx.functionName} calls ${this.name(callee)}, which needs ${cap}, without holding it`,
          );
        }
        let target: CompiledFunction | undefined;
        return (f) => {
          target ??= this.compiled.get(callee);
          if (!target) throw new ProductionFault('unbound', `${this.name(callee)} is not compiled`);
          return this.enter(target, args.map((a) => a(f)));
        };
      }
      case 'Invoke': {
        // The static grant is settled here, at compile time. Only revocation
        // is dynamic, because §5 requires it to work without a redeploy.
        if (!ctx.envelope.has(term.capability)) {
          throw new TypeError(`${ctx.functionName} may not invoke ${term.capability}`);
        }
        const capability = term.capability;
        const args = term.args.map((a) => this.expr(a, ctx));
        const descriptor = this.opts.registry.get(capability);
        if (!descriptor) throw new TypeError(`${capability} is not registered`);
        if (descriptor.arity !== args.length) {
          throw new TypeError(`${capability} takes ${descriptor.arity} arguments, got ${args.length}`);
        }
        const handler = this.opts.effects?.get(capability);
        const revocations = this.opts.revocations;
        const scope = this.opts.scope;
        return (f) => {
          if (revocations?.isRevoked(capability, scope)) {
            throw new ProductionFault(
              'capability_revoked',
              `${capability} has been revoked by an operator`,
              capability,
            );
          }
          const values = args.map((a) => a(f));
          if (!handler) return null;
          try {
            return handler(values);
          } catch (e) {
            if (e instanceof ProductionFault) throw e;
            throw new ProductionFault(
              'effect_failed',
              `${capability} failed: ${e instanceof Error ? e.message : String(e)}`,
              capability,
            );
          }
        };
      }
      default:
        throw new TypeError(`${term.kind} is not an expression`);
    }
  }

  /** Populated in the first pass, so a call can be checked before its callee compiles. */
  private readonly declaredCapabilities = new Map<SymbolId, readonly CapabilityName[]>();

  private calleeCapabilities(symbol: SymbolId): readonly CapabilityName[] {
    return this.declaredCapabilities.get(symbol) ?? [];
  }

  private callback(symbol: SymbolId, ctx: Ctx): (args: readonly Value[]) => Value {
    for (const cap of this.calleeCapabilities(symbol)) {
      if (!ctx.envelope.has(cap)) {
        throw new TypeError(`${ctx.functionName} callback ${this.name(symbol)} needs ${cap}`);
      }
    }
    let target: CompiledFunction | undefined;
    return (args) => {
      target ??= this.compiled.get(symbol);
      if (!target) throw new ProductionFault('unbound', `${this.name(symbol)} is not compiled`);
      return this.enter(target, args);
    };
  }

  private slotOf(symbol: SymbolId, ctx: Ctx): number {
    const slot = ctx.slots.get(symbol);
    if (slot === undefined) {
      throw new TypeError(`${this.name(symbol)} is not bound in ${ctx.functionName}`);
    }
    return slot;
  }

  private binary(term: Extract<Term, { kind: 'Bin' }>, ctx: Ctx): ExprFn {
    const left = this.expr(term.left, ctx);
    const right = this.expr(term.right, ctx);
    const op: BinOp = term.op;
    switch (op) {
      // Short-circuiting is semantics, not an optimization.
      case 'and': return (f) => (asBool(left(f)) ? asBool(right(f)) : false);
      case 'or': return (f) => (asBool(left(f)) ? true : asBool(right(f)));
      case 'eq': return (f) => sameValue(left(f), right(f));
      case 'ne': return (f) => !sameValue(left(f), right(f));
      case 'concat': return (f) => asStr(left(f)) + asStr(right(f));
      case 'add': return (f) => asInt(left(f), 'add') + asInt(right(f), 'add');
      case 'sub': return (f) => asInt(left(f), 'sub') - asInt(right(f), 'sub');
      case 'mul': return (f) => asInt(left(f), 'mul') * asInt(right(f), 'mul');
      case 'div': return (f) => divide(asInt(left(f), 'div'), asInt(right(f), 'div'), 'div');
      case 'mod': return (f) => divide(asInt(left(f), 'mod'), asInt(right(f), 'mod'), 'mod');
      case 'lt': return (f) => asInt(left(f), 'lt') < asInt(right(f), 'lt');
      case 'le': return (f) => asInt(left(f), 'le') <= asInt(right(f), 'le');
      case 'gt': return (f) => asInt(left(f), 'gt') > asInt(right(f), 'gt');
      case 'ge': return (f) => asInt(left(f), 'ge') >= asInt(right(f), 'ge');
    }
  }

  // --- statement compilation -----------------------------------------------

  private stmt(term: Term, ctx: Ctx): StmtFn {
    switch (term.kind) {
      case 'Block': {
        const stmts = term.stmts.map((s) => this.stmt(s, ctx));
        if (stmts.length === 0) return () => FALLTHROUGH;
        if (stmts.length === 1) return stmts[0];
        return (f) => {
          for (const s of stmts) {
            const out = s(f);
            if (out !== FALLTHROUGH) return out;
          }
          return FALLTHROUGH;
        };
      }
      case 'Let': {
        const slot = this.slotOf(term.symbol, ctx);
        const init = this.expr(term.init, ctx);
        return (f) => {
          f.s[slot] = init(f);
          return FALLTHROUGH;
        };
      }
      case 'Assign': return this.assign(term, ctx);
      case 'If': {
        const cond = this.expr(term.cond, ctx);
        const then = this.stmt(term.then, ctx);
        if (term.otherwise === null) {
          return (f) => (asBool(cond(f)) ? then(f) : FALLTHROUGH);
        }
        const otherwise = this.stmt(term.otherwise, ctx);
        return (f) => (asBool(cond(f)) ? then(f) : otherwise(f));
      }
      case 'While': {
        // Loop invariants and the variant are verification artifacts. They
        // have no runtime meaning and are not compiled.
        const cond = this.expr(term.cond, ctx);
        const body = this.stmt(term.body, ctx);
        return (f) => {
          while (asBool(cond(f))) {
            const out = body(f);
            if (out !== FALLTHROUGH) return out;
          }
          return FALLTHROUGH;
        };
      }
      case 'Return': {
        const value = this.expr(term.value, ctx);
        return (f) => value(f);
      }
      case 'Assert': {
        if (!ctx.keptAssertions.has(term.label)) return () => FALLTHROUGH;
        const test = this.expr(term.expr, ctx);
        const label = term.label;
        return (f) => {
          if (asBool(test(f))) return FALLTHROUGH;
          throw new ProductionFault('assertion', `assertion ${label} failed`, label);
        };
      }
      case 'ExprStmt': {
        const expr = this.expr(term.expr, ctx);
        return (f) => {
          expr(f);
          return FALLTHROUGH;
        };
      }
      default: {
        const expr = this.expr(term, ctx);
        return (f) => {
          expr(f);
          return FALLTHROUGH;
        };
      }
    }
  }

  private assign(term: Extract<Term, { kind: 'Assign' }>, ctx: Ctx): StmtFn {
    const value = this.expr(term.value, ctx);
    const target = term.target;
    const heap = this.heap;

    if (target.kind === 'Place') {
      const slot = this.slotOf(target.symbol, ctx);
      if (target.path.length === 0) {
        return (f) => {
          f.s[slot] = value(f);
          return FALLTHROUGH;
        };
      }
      const prefix = target.path.slice(0, -1);
      const last = target.path[target.path.length - 1];
      return (f) => {
        let cursor = f.s[slot];
        for (const seg of prefix) cursor = readField(heap, cursor, seg);
        writeField(heap, cursor, last, value(f));
        return FALLTHROUGH;
      };
    }
    if (target.kind === 'Field') {
      const object = this.expr(target.object, ctx);
      const field = target.field;
      return (f) => {
        writeField(heap, object(f), field, value(f));
        return FALLTHROUGH;
      };
    }
    if (target.kind === 'Var') {
      const slot = this.slotOf(target.symbol, ctx);
      return (f) => {
        f.s[slot] = value(f);
        return FALLTHROUGH;
      };
    }
    throw new TypeError(`${target.kind} is not assignable`);
  }

}

interface Ctx {
  readonly slots: Map<SymbolId, number>;
  readonly olds: ExprFn[];
  readonly envelope: CapabilityEnvelope;
  readonly functionName: string;
  readonly keptAssertions: Set<string>;
}

// ---------------------------------------------------------------------------
// value helpers — deliberately small and monomorphic
// ---------------------------------------------------------------------------

function asBool(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  throw new ProductionFault('type_error', `expected a boolean, got ${String(v)}`);
}

function normalizeFixed(value: bigint, ty: Extract<Ty, { t: 'IntN' }>): bigint {
  const width = 1n << BigInt(ty.bits);
  const min = ty.signed ? -(1n << BigInt(ty.bits - 1)) : 0n;
  const max = ty.signed ? (1n << BigInt(ty.bits - 1)) - 1n : width - 1n;
  if (value >= min && value <= max) return value;
  if (ty.overflow === 'trap') throw new ProductionFault('type_error', `${ty.signed ? 'i' : 'u'}${ty.bits} overflow: ${value}`);
  if (ty.overflow === 'saturate') return value < min ? min : max;
  return ((value - min) % width + width) % width + min;
}

function asInt(v: Value, op: string): bigint {
  if (typeof v === 'bigint') return v;
  throw new ProductionFault('type_error', `${op} needs an integer, got ${String(v)}`);
}

function asStr(v: Value): string {
  if (typeof v === 'string') return v;
  throw new ProductionFault('type_error', `++ needs a string, got ${String(v)}`);
}

function divide(l: bigint, r: bigint, op: 'div' | 'mod'): bigint {
  if (r === 0n) throw new ProductionFault('division_by_zero', `${op} by zero`);
  // Truncating, matching both the development runtime and the solver axioms.
  return op === 'div' ? l / r : l % r;
}

const sameValue = (l: Value, r: Value): boolean =>
  isRef(l) && isRef(r) ? l.addr === r.addr : l === r;

function readField(heap: readonly HeapRecord[], owner: Value, field: string): Value {
  if (!isRef(owner)) {
    throw new ProductionFault('type_error', `cannot read .${field} of a non-record`);
  }
  const record = heap[owner.addr];
  if (!record || !(field in record)) {
    throw new ProductionFault('type_error', `no field ${field} at @${owner.addr}`);
  }
  return record[field];
}

function writeField(heap: HeapRecord[], owner: Value, field: string, value: Value): void {
  if (!isRef(owner)) {
    throw new ProductionFault('type_error', `cannot write .${field} of a non-record`);
  }
  const record = heap[owner.addr];
  if (!record) throw new ProductionFault('type_error', `no record at @${owner.addr}`);
  record[field] = value;
}

function collectAssertLabels(term: Term | null, into: Set<string>): void {
  if (!term) return;
  if (term.kind === 'Assert') into.add(term.label);
  for (const child of childTerms(term)) collectAssertLabels(child, into);
}

function childTerms(term: Term): readonly Term[] {
  const out: Term[] = [];
  for (const value of Object.values(term as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && 'kind' in item) out.push(item as Term);
      }
    } else if (value && typeof value === 'object' && 'kind' in value) {
      out.push(value as Term);
    }
  }
  return out;
}

function countCalls(term: Term | null, callee: SymbolId): number {
  if (!term) return 0;
  let total = term.kind === 'Call' && term.callee === callee ? 1 : 0;
  for (const child of children(term)) total += countCalls(child, callee);
  return total;
}

/** A one-screen summary of what production will and will not check. */
export function formatCompilation(report: CompilationReport): string {
  const lines = [
    `compiled ${report.functions} function(s) under policy "${report.policy}": ` +
      `${report.clausesElided} clause(s) elided, ${report.clausesKept} kept`,
  ];
  for (const d of report.decisions) {
    const mark = d.decision === 'elided' ? '−' : '✓';
    lines.push(`  ${mark} ${d.function}.${d.label} [${d.kind}] — ${d.reason}`);
  }
  return lines.join('\n');
}
