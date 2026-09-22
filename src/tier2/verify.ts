/**
 * Contract verification (FR-2.2, NFR 6.2).
 *
 * A function's body is symbolically executed into a set of paths. Each path
 * carries a path condition, a store mapping places to symbolic values, and the
 * value it returned. From those, proof obligations are emitted:
 *
 *   • every `requires` of a callee, at the call site,
 *   • every `assert` in the body,
 *   • every `ensures` of this function, on every returning path,
 *   • for each loop: the invariant on entry, its preservation by the body, and
 *     a variant that strictly decreases and stays non-negative.
 *
 * Loops are handled by the usual rule rather than unrolling: havoc the
 * variables the body writes, assume the invariant, and prove it again. That is
 * what makes verification independent of trip count.
 *
 * ### Tiered rigor (Risk R1)
 *
 * The PRD's mitigation for solver state-space explosion is to spend proof
 * effort where it pays. A clause marked `formal` goes to the solver under a
 * strict budget. A clause marked `property` never goes to the solver at all —
 * it is delegated to the Tier-3 micro-world fuzzer by construction. A `formal`
 * clause the solver cannot settle within budget is *not* silently downgraded:
 * it is reported as `UnprovenFormalContract` and delegated, so the weaker
 * evidence is visible in the report rather than implied by its absence.
 */

import type { Term, Ty } from '../tier1/ast.ts';
import type { InvariantId, NodeRef, SymbolId } from '../tier1/ids.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import type { DischargeProof } from '../tier1/provenance.ts';
import { GraphStore } from '../tier1/store.ts';
import * as S from './smt.ts';
import { DEFAULT_TIMEOUT_MS, prove, type SolverResult } from './solver.ts';
import { underlying } from './typecheck.ts';
import type { ProofCache } from './proof-cache.ts';

export type ObligationKind =
  | 'precondition_at_call'
  | 'assertion'
  | 'postcondition'
  | 'invariant_on_entry'
  | 'invariant_preserved'
  | 'variant_decreases'
  | 'variant_bounded';

export interface Obligation {
  readonly kind: ObligationKind;
  readonly label: string;
  readonly formula: S.SmtFormula;
  readonly rigor: 'formal' | 'property';
  readonly path: readonly string[];
  /**
   * For `precondition_at_call`: whose precondition this is, and which clause.
   * Matching on the rendered label would be brittle, and the production
   * compiler needs this to decide whether a callee's precondition is
   * established at *every* call site before it may stop checking it.
   */
  readonly callee?: SymbolId;
  readonly clause?: string;
}

export type ObligationVerdict = 'proved' | 'refuted' | 'unproven' | 'delegated';

export interface ObligationResult {
  readonly obligation: Obligation;
  readonly verdict: ObligationVerdict;
  readonly solver?: SolverResult;
  /** Present when refuted: variable bindings that break the contract. */
  readonly counterexample?: Readonly<Record<string, bigint | boolean>>;
  readonly smtLib: string;
  readonly elapsedMs: number;
}

/**
 * `proved`    — every obligation discharged by the solver.
 * `delegated` — every *formal* obligation discharged; some clauses were routed
 *               to property testing by design, so the function is only fully
 *               validated once its micro-world suite passes (Tier 3).
 * `unproven`  — a formal clause the solver could not settle inside its budget.
 * `refuted`   — a counterexample exists. This is the only verdict that means
 *               the code is wrong rather than merely unconfirmed.
 */
export type Verdict = 'proved' | 'delegated' | 'unproven' | 'refuted';

export interface VerificationReport {
  readonly symbol: SymbolId | null;
  /** Content address of the exact declaration this report verified. */
  readonly subject: NodeRef;
  /** Exact callee declarations whose contracts were used as proof assumptions. */
  readonly dependencies: readonly VerificationDependency[];
  readonly verdict: Verdict;
  readonly results: readonly ObligationResult[];
  /** Clauses the solver could not settle, now owed to property testing. */
  readonly unprovenFormalContracts: readonly string[];
  /** Clauses routed to fuzzing by design. */
  readonly delegatedToFuzzing: readonly string[];
  readonly frameViolations: readonly string[];
  /**
   * Modelling assumptions the proof rests on. A proof is only as good as these,
   * so they are reported rather than buried in the verifier.
   */
  readonly assumptions: readonly string[];
  readonly elapsedMs: number;
  readonly budgetExhausted: boolean;
  readonly pathsExplored: number;
}

export interface VerificationDependency {
  readonly symbol: SymbolId;
  readonly subject: NodeRef;
}

export interface VerifyOptions {
  readonly symbols?: SymbolSpace;
  /** NFR 6.2: 2,000 ms per function, across all of its obligations. */
  readonly budgetMs?: number;
  /** Refuse to explore more paths than this before falling back to fuzzing. */
  readonly maxPaths?: number;
  /** Contracts of functions this one calls, for modular verification. */
  readonly environment?: ReadonlyMap<SymbolId, Term>;
  /** Reuse a report only when its declaration and every contract dependency match. */
  readonly proofCache?: ProofCache;
}

// ---------------------------------------------------------------------------
// symbolic state
// ---------------------------------------------------------------------------

/** A storage location: a variable, or a field path rooted at one. */
type PlaceKey = string;

interface Path {
  readonly store: Map<PlaceKey, S.SmtTerm>;
  /** Call-entry snapshot used by `old(…)`; absent means function entry. */
  readonly oldStore?: Map<PlaceKey, S.SmtTerm>;
  readonly condition: S.SmtFormula[];
  readonly assumptions: S.SmtFormula[];
  returned: S.SmtTerm | null;
  done: boolean;
}

const clonePath = (p: Path): Path => ({
  store: new Map(p.store),
  oldStore: p.oldStore ? new Map(p.oldStore) : undefined,
  condition: [...p.condition],
  assumptions: [...p.assumptions],
  returned: p.returned,
  done: p.done,
});

class VcBuilder {
  private readonly opts: VerifyOptions;
  private fresh = 0;
  readonly obligations: Obligation[] = [];
  readonly frameViolations: string[] = [];
  readonly dependencies = new Map<SymbolId, NodeRef>();
  /** Snapshot of the entry store, which is what `old(…)` reads. */
  private initial: Map<PlaceKey, S.SmtTerm> = new Map();
  private declaredModifies: Set<PlaceKey> = new Set();
  private locals = new Set<PlaceKey>();
  private truncated = false;
  private hasFrameContract = false;

  constructor(opts: VerifyOptions) {
    this.opts = opts;
  }

  get wasTruncated(): boolean {
    return this.truncated;
  }

  private name(sym: SymbolId): string {
    const base = this.opts.symbols?.nameOf(sym) ?? 'v';
    // The symbol id keeps distinct bindings distinct even when names collide.
    return `${base}#${sym.slice(4, 10)}`;
  }

  private freshVar(prefix: string): S.SmtTerm {
    return S.intVar(`${prefix}!${this.fresh++}`);
  }

  private placeKey(term: Term): PlaceKey | null {
    switch (term.kind) {
      case 'Var': return this.name(term.symbol);
      case 'Place':
        return [this.name(term.symbol), ...term.path].join('.');
      case 'Field': {
        const base = this.placeKey(term.object);
        return base === null ? null : `${base}.${term.field}`;
      }
      default: return null;
    }
  }

  private frameAllows(key: PlaceKey): boolean {
    return [...this.declaredModifies].some((root) => key === root || key.startsWith(`${root}.`));
  }

  private read(path: Path, key: PlaceKey): S.SmtTerm {
    const hit = path.store.get(key);
    if (hit) return hit;
    const v = S.intVar(key);
    path.store.set(key, v);
    if (!this.initial.has(key)) this.initial.set(key, v);
    return v;
  }

  // --- expression translation ----------------------------------------------

  /** Integer-valued translation. Non-arithmetic values become opaque integers. */
  term(expr: Term, path: Path, old = false): S.SmtTerm {
    const store = old ? (path.oldStore ?? this.initial) : path.store;
    switch (expr.kind) {
      case 'Lit':
        if (typeof expr.value === 'bigint') return S.num(expr.value);
        if (typeof expr.value === 'boolean') return S.num(expr.value ? 1 : 0);
        if (typeof expr.value === 'string') {
          // Strings are modelled as opaque constants: only equality matters.
          return S.intVar(`str!${JSON.stringify(expr.value)}`);
        }
        return S.num(0);
      case 'Var':
      case 'Place':
      case 'Field': {
        const key = this.placeKey(expr);
        if (key === null) return this.freshVar('opaque');
        if (old) {
          const snapshot = store.get(key);
          if (snapshot) return snapshot;
          if (path.oldStore) {
            const value = this.freshVar(`old!${key}`);
            path.oldStore.set(key, value);
            return value;
          }
          return this.read(path, key);
        }
        return this.read(path, key);
      }
      case 'Old': return this.term(expr.expr, path, true);
      case 'ResultRef': return path.returned ?? this.freshVar('result');
      case 'Un':
        return expr.op === 'neg'
          ? S.neg(this.term(expr.operand, path, old))
          : S.ite(this.formula(expr, path, old), S.num(1), S.num(0));
      case 'Cond':
        return S.ite(
          this.formula(expr.cond, path, old),
          this.term(expr.then, path, old),
          this.term(expr.otherwise, path, old),
        );
      case 'Bin': {
        const l = this.term(expr.left, path, old);
        const r = this.term(expr.right, path, old);
        switch (expr.op) {
          case 'add': return S.add(l, r);
          case 'sub': return S.sub(l, r);
          case 'mul': return S.mul(l, r);
          case 'div': return this.divide(expr, l, r, path, 'quotient');
          case 'mod': return this.divide(expr, l, r, path, 'remainder');
          case 'concat': return this.freshVar('concat');
          default:
            // A boolean-valued operator used where an integer is wanted.
            return S.ite(this.formula(expr, path, old), S.num(1), S.num(0));
        }
      }
      case 'Call': return this.call(expr, path, old);
      case 'Invoke': return this.freshVar('invoke'); // effects have no value here
      case 'RecordLit': return this.freshVar('record');
      default: return this.freshVar('opaque');
    }
  }

  /**
   * Truncating division and modulo.
   *
   * For a non-zero constant divisor the exact facts `a = q·b + r` and
   * `-|b| < r < |b|` are linear and hold for either sign, so they are asserted
   * rather than abstracted. For a symbolic divisor nothing sound and linear can
   * be said, so the result is an opaque value.
   */
  private divide(
    expr: Term,
    left: S.SmtTerm,
    right: S.SmtTerm,
    path: Path,
    want: 'quotient' | 'remainder',
  ): S.SmtTerm {
    void expr;
    if (right.k !== 'int' || right.v === 0n) return this.freshVar(want);
    const b = right.v;
    const magnitude = b < 0n ? -b : b;
    const q = this.freshVar('q');
    const r = this.freshVar('r');
    path.assumptions.push(
      S.eq(left, S.add(S.mul(S.num(b), q), r)),
      S.lt(r, S.num(magnitude)),
      S.gt(r, S.num(-magnitude)),
      // Truncation, not floor: the remainder takes the sign of the dividend.
      // Without these two, `1 / 100 = 1` satisfies the axioms above and the
      // solver invents counterexamples the runtime cannot reproduce.
      S.or(S.lt(left, S.num(0)), S.ge(r, S.num(0))),
      S.or(S.gt(left, S.num(0)), S.le(r, S.num(0))),
    );
    return want === 'quotient' ? q : r;
  }

  /**
   * A call is replaced by a fresh value constrained by the callee's contract:
   * its preconditions become obligations here, its postconditions become
   * assumptions. This is modular verification — the callee's body is never
   * re-examined, so verification cost does not compound down the call graph.
   */
  private call(expr: Extract<Term, { kind: 'Call' }>, path: Path, old: boolean): S.SmtTerm {
    const callee = this.opts.environment?.get(expr.callee);
    const value = this.freshVar('call');
    if (!callee || callee.kind !== 'FunctionDecl') return value;
    this.dependencies.set(callee.symbol, new GraphStore().intern(callee));
    if (!callee.contract) return value;
    const contract = callee.contract;
    if (contract.kind !== 'Contract') return value;

    // A mutating call has two stores. Preconditions and `old(…)` read the
    // call-entry bindings. Postconditions read fresh values for every declared
    // write, and those values replace the corresponding caller places after
    // the call. Reusing one binding for both states creates contradictions such
    // as `x = x + 1`, from which any later assertion can be proved vacuously.
    const before = new Map<PlaceKey, S.SmtTerm>();
    const after = new Map<PlaceKey, S.SmtTerm>();
    const modified = new Set(
      contract.modifies
        .map((place) => this.placeKey(place))
        .filter((key): key is string => key !== null),
    );
    const isModified = (key: PlaceKey): boolean =>
      [...modified].some((root) => key === root || key.startsWith(`${root}.`));

    const bindPaths = (key: PlaceKey, ty: Ty, argExpr: Term): void => {
      const prior = this.term(argExpr, path, old);
      before.set(key, prior);
      let next = prior;
      if (!old && isModified(key)) {
        next = this.freshVar(`callpost!${key}`);
        const callerKey = this.placeKey(argExpr);
        if (callerKey) {
          if (!this.locals.has(callerKey) && this.hasFrameContract && !this.frameAllows(callerKey)) {
            const message = `${callerKey} is modified by ${this.name(callee.symbol)} but not listed in modifies`;
            if (!this.frameViolations.includes(message)) this.frameViolations.push(message);
          }
          path.store.set(callerKey, next);
        }
      }
      after.set(key, next);
      const base = underlying(ty);
      if (base.t !== 'Record') return;
      for (const [field, fieldTy] of base.fields) {
        bindPaths(`${key}.${field}`, fieldTy, { kind: 'Field', object: argExpr, field });
      }
    };
    callee.params.forEach((p, i) => {
      const arg = expr.args[i];
      if (arg) bindPaths(this.name(p.symbol), p.ty, arg);
    });
    const prePath: Path = {
      store: new Map([...path.store, ...before]),
      oldStore: new Map(before),
      condition: path.condition,
      assumptions: path.assumptions,
      returned: value,
      done: false,
    };
    const callPath: Path = {
      store: new Map([...path.store, ...after]),
      oldStore: new Map(before),
      condition: path.condition,
      assumptions: path.assumptions,
      returned: value,
      done: false,
    };
    for (const clause of contract.requires) {
      if (clause.kind !== 'Clause') continue;
      this.emit({
        kind: 'precondition_at_call',
        label: `${this.name(expr.callee)}.${clause.label}`,
        formula: this.implication(path, this.formula(clause.expr, prePath)),
        rigor: clause.rigor,
        path: ['call', clause.label],
        callee: expr.callee,
        clause: clause.label,
      });
    }
    for (const clause of contract.ensures) {
      if (clause.kind !== 'Clause') continue;
      // Property clauses are not solver facts. Treating one as an axiom would
      // let a caller obtain a formal proof from a callee that was only fuzzed.
      if (clause.rigor !== 'formal') continue;
      path.assumptions.push(this.formula(clause.expr, callPath));
    }
    return value;
  }

  /** Boolean-valued translation. */
  formula(expr: Term, path: Path, old = false): S.SmtFormula {
    switch (expr.kind) {
      case 'Lit':
        if (typeof expr.value === 'boolean') return expr.value ? S.T : S.F;
        return S.gt(this.term(expr, path, old), S.num(0));
      case 'Un':
        if (expr.op === 'not') return S.not(this.formula(expr.operand, path, old));
        return S.gt(this.term(expr, path, old), S.num(0));
      case 'Bin': {
        switch (expr.op) {
          case 'and': return S.and(this.formula(expr.left, path, old), this.formula(expr.right, path, old));
          case 'or': return S.or(this.formula(expr.left, path, old), this.formula(expr.right, path, old));
          case 'eq': return S.eq(this.term(expr.left, path, old), this.term(expr.right, path, old));
          case 'ne': return S.not(S.eq(this.term(expr.left, path, old), this.term(expr.right, path, old)));
          case 'lt': return S.lt(this.term(expr.left, path, old), this.term(expr.right, path, old));
          case 'le': return S.le(this.term(expr.left, path, old), this.term(expr.right, path, old));
          case 'gt': return S.gt(this.term(expr.left, path, old), this.term(expr.right, path, old));
          case 'ge': return S.ge(this.term(expr.left, path, old), this.term(expr.right, path, old));
          default: return S.gt(this.term(expr, path, old), S.num(0));
        }
      }
      case 'Cond':
        return S.or(
          S.and(this.formula(expr.cond, path, old), this.formula(expr.then, path, old)),
          S.and(S.not(this.formula(expr.cond, path, old)), this.formula(expr.otherwise, path, old)),
        );
      case 'Old': return this.formula(expr.expr, path, true);
      default:
        return S.gt(this.term(expr, path, old), S.num(0));
    }
  }

  private implication(path: Path, goal: S.SmtFormula): S.SmtFormula {
    return S.implies(S.and(...path.assumptions, ...path.condition), goal);
  }

  private emit(o: Obligation): void {
    this.obligations.push(o);
  }

  // --- statement execution -------------------------------------------------

  /** Places written anywhere inside a statement, for havocking at a loop head. */
  private writtenPlaces(stmt: Term, into: Set<PlaceKey>): void {
    if (stmt.kind === 'Assign') {
      const key = this.placeKey(stmt.target);
      if (key) into.add(key);
    }
    if (stmt.kind === 'Let') into.add(this.name(stmt.symbol));
    for (const child of childrenOf(stmt)) this.writtenPlaces(child, into);
  }

  execute(stmt: Term, paths: Path[], trail: readonly string[]): Path[] {
    const maxPaths = this.opts.maxPaths ?? 64;
    if (paths.length > maxPaths) {
      this.truncated = true;
      return paths.slice(0, maxPaths);
    }
    switch (stmt.kind) {
      case 'Block': {
        let current = paths;
        stmt.stmts.forEach((s, i) => {
          current = this.execute(s, current, [...trail, `stmts[${i}]`]);
        });
        return current;
      }
      case 'Let':
        for (const p of paths) {
          if (p.done) continue;
          const key = this.name(stmt.symbol);
          this.locals.add(key);
          p.store.set(key, this.term(stmt.init, p));
        }
        return paths;
      case 'Assign':
        for (const p of paths) {
          if (p.done) continue;
          const key = this.placeKey(stmt.target);
          if (key === null) continue;
          const value = this.term(stmt.value, p);
          if (!this.locals.has(key) && this.hasFrameContract && !this.frameAllows(key)) {
            const message = `${key} is assigned but not listed in modifies`;
            if (!this.frameViolations.includes(message)) this.frameViolations.push(message);
          }
          p.store.set(key, value);
        }
        return paths;
      case 'Return':
        for (const p of paths) {
          if (p.done) continue;
          p.returned = this.term(stmt.value, p);
          p.done = true;
        }
        return paths;
      case 'Assert': {
        for (const p of paths) {
          if (p.done) continue;
          this.emit({
            kind: 'assertion',
            label: stmt.label,
            formula: this.implication(p, this.formula(stmt.expr, p)),
            rigor: 'formal',
            path: trail,
            clause: stmt.label,
          });
        }
        return paths;
      }
      case 'ExprStmt':
        for (const p of paths) if (!p.done) this.term(stmt.expr, p);
        return paths;
      case 'If': {
        const out: Path[] = [];
        for (const p of paths) {
          if (p.done) {
            out.push(p);
            continue;
          }
          const test = this.formula(stmt.cond, p);
          const taken = clonePath(p);
          taken.condition.push(test);
          out.push(...this.execute(stmt.then, [taken], [...trail, 'then']));
          const skipped = clonePath(p);
          skipped.condition.push(S.not(test));
          out.push(
            ...(stmt.otherwise
              ? this.execute(stmt.otherwise, [skipped], [...trail, 'otherwise'])
              : [skipped]),
          );
        }
        return out;
      }
      case 'While': return this.loop(stmt, paths, trail);
      default:
        return paths;
    }
  }

  /**
   * The loop rule. Nothing here depends on how many times the loop runs, which
   * is the entire point: unrolling would make verification cost scale with a
   * bound that is usually symbolic anyway.
   */
  private loop(
    stmt: Extract<Term, { kind: 'While' }>,
    paths: Path[],
    trail: readonly string[],
  ): Path[] {
    const modified = new Set<PlaceKey>();
    this.writtenPlaces(stmt.body, modified);

    const out: Path[] = [];
    for (const p of paths) {
      if (p.done) {
        out.push(p);
        continue;
      }

      // 1. The invariant must hold when the loop is reached.
      stmt.invariants.forEach((inv, i) => {
        this.emit({
          kind: 'invariant_on_entry',
          label: `invariant[${i}]`,
          formula: this.implication(p, this.formula(inv, p)),
          rigor: 'formal',
          path: [...trail, `invariants[${i}]`],
        });
      });

      // 2. Havoc everything the body writes, then assume the invariant and the
      //    loop test. This is an arbitrary iteration, not the first one.
      const inside = clonePath(p);
      for (const key of modified) inside.store.set(key, this.freshVar(`havoc!${key}`));
      const invariantsInside = stmt.invariants.map((inv) => this.formula(inv, inside));
      inside.assumptions.push(...invariantsInside);
      const variantBefore = stmt.variant ? this.term(stmt.variant, inside) : null;
      inside.condition.push(this.formula(stmt.cond, inside));

      const after = this.execute(stmt.body, [inside], [...trail, 'body']);
      for (const branch of after) {
        if (branch.done) continue;
        stmt.invariants.forEach((inv, i) => {
          this.emit({
            kind: 'invariant_preserved',
            label: `invariant[${i}]`,
            formula: this.implication(branch, this.formula(inv, branch)),
            rigor: 'formal',
            path: [...trail, 'body', `invariants[${i}]`],
          });
        });
        if (stmt.variant && variantBefore) {
          const variantAfter = this.term(stmt.variant, branch);
          this.emit({
            kind: 'variant_decreases',
            label: 'variant',
            formula: this.implication(branch, S.lt(variantAfter, variantBefore)),
            rigor: 'formal',
            path: [...trail, 'variant'],
          });
          this.emit({
            kind: 'variant_bounded',
            label: 'variant',
            formula: this.implication(branch, S.ge(variantBefore, S.num(0))),
            rigor: 'formal',
            path: [...trail, 'variant'],
          });
        }
      }

      // 3. Continue after the loop knowing only the invariant and ¬cond.
      const exit = clonePath(p);
      for (const key of modified) exit.store.set(key, this.freshVar(`post!${key}`));
      exit.assumptions.push(...stmt.invariants.map((inv) => this.formula(inv, exit)));
      exit.condition.push(S.not(this.formula(stmt.cond, exit)));
      out.push(exit);
    }
    return out;
  }

  /** Build the obligations for a whole declaration. */
  build(decl: Extract<Term, { kind: 'FunctionDecl' }>): number {
    const entry: Path = {
      store: new Map(),
      condition: [],
      assumptions: [],
      returned: null,
      done: false,
    };
    for (const p of decl.params) {
      const key = this.name(p.symbol);
      entry.store.set(key, S.intVar(key));
      this.seedRecordFields(entry, key, p.ty);
    }
    this.initial = new Map(entry.store);

    const contract = decl.contract?.kind === 'Contract' ? decl.contract : null;
    if (contract) {
      this.hasFrameContract = true;
      for (const m of contract.modifies) {
        const key = this.placeKey(m);
        if (key) this.declaredModifies.add(key);
      }
      for (const clause of contract.requires) {
        if (clause.kind !== 'Clause') continue;
        entry.assumptions.push(this.formula(clause.expr, entry));
      }
    }

    if (!decl.body) return 0;
    const finished = this.execute(decl.body, [entry], ['body']);

    if (contract) {
      for (const p of finished) {
        for (const clause of contract.ensures) {
          if (clause.kind !== 'Clause') continue;
          this.emit({
            kind: 'postcondition',
            label: clause.label,
            formula: this.implication(p, this.formula(clause.expr, p)),
            rigor: clause.rigor,
            path: ['ensures', clause.label],
            clause: clause.label,
          });
        }
      }
    }
    return finished.length;
  }

  /** Give record-typed parameters a place for each field up front. */
  private seedRecordFields(path: Path, root: PlaceKey, ty: Ty): void {
    const base = underlying(ty);
    if (base.t !== 'Record') return;
    for (const [field, fieldTy] of base.fields) {
      const key = `${root}.${field}`;
      path.store.set(key, S.intVar(key));
      this.seedRecordFields(path, key, fieldTy);
    }
  }
}

function childrenOf(term: Term): readonly Term[] {
  const out: Term[] = [];
  for (const value of Object.values(term as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && 'kind' in item) out.push(item as Term);
        else if (Array.isArray(item) && item[1] && typeof item[1] === 'object' && 'kind' in item[1]) {
          out.push(item[1] as Term);
        }
      }
    } else if (value && typeof value === 'object' && 'kind' in value) {
      out.push(value as Term);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

/** Verify one function declaration against its contract. */
export function verifyFunction(
  decl: Term,
  opts: VerifyOptions = {},
): VerificationReport {
  const started = Date.now();
  if (decl.kind !== 'FunctionDecl') {
    throw new TypeError(`verifyFunction expects a FunctionDecl, got ${decl.kind}`);
  }
  const subject = new GraphStore().intern(decl);
  const cached = opts.proofCache?.get(subject);
  if (cached) {
    const dependenciesCurrent = cached.dependencies.every((dependency) => {
      const current = opts.environment?.get(dependency.symbol);
      return current?.kind === 'FunctionDecl' && new GraphStore().intern(current) === dependency.subject;
    });
    if (dependenciesCurrent) return cached;
  }
  const budget = opts.budgetMs ?? DEFAULT_TIMEOUT_MS;
  const builder = new VcBuilder(opts);
  const pathsExplored = builder.build(decl);

  const results: ObligationResult[] = [];
  const unproven: string[] = [];
  const delegated: string[] = [];
  let budgetExhausted = false;

  for (const obligation of builder.obligations) {
    const remaining = budget - (Date.now() - started);
    const smtLib = S.toSmtLibScript(S.not(obligation.formula), {
      comment: `${obligation.kind}: ${obligation.label}`,
    });

    // Property-rigor clauses are never sent to the solver at all.
    if (obligation.rigor === 'property') {
      delegated.push(obligation.label);
      results.push({ obligation, verdict: 'delegated', smtLib, elapsedMs: 0 });
      continue;
    }
    if (remaining <= 0) {
      budgetExhausted = true;
      unproven.push(obligation.label);
      results.push({ obligation, verdict: 'unproven', smtLib, elapsedMs: 0 });
      continue;
    }

    const at = Date.now();
    const solved = prove(obligation.formula, { timeoutMs: remaining });
    const elapsedMs = Date.now() - at;
    if (solved.status === 'unsat') {
      results.push({ obligation, verdict: 'proved', solver: solved, smtLib, elapsedMs });
    } else if (solved.status === 'sat') {
      results.push({
        obligation,
        verdict: 'refuted',
        solver: solved,
        counterexample: solved.model,
        smtLib,
        elapsedMs,
      });
    } else {
      if (solved.reason === 'timeout') budgetExhausted = true;
      unproven.push(obligation.label);
      results.push({ obligation, verdict: 'unproven', solver: solved, smtLib, elapsedMs });
    }
  }

  if (builder.wasTruncated) {
    budgetExhausted = true;
    unproven.push('path exploration truncated');
  }

  const verdict: Verdict = builder.frameViolations.length > 0 || results.some((r) => r.verdict === 'refuted')
    ? 'refuted'
    : builder.wasTruncated || results.some((r) => r.verdict === 'unproven')
      ? 'unproven'
      : results.some((r) => r.verdict === 'delegated')
        ? 'delegated'
        : 'proved';

  const report: VerificationReport = {
    symbol: decl.symbol,
    subject,
    dependencies: [...builder.dependencies].map(([symbol, subject]) => ({ symbol, subject })),
    verdict,
    results,
    unprovenFormalContracts: unproven,
    delegatedToFuzzing: delegated,
    frameViolations: builder.frameViolations,
    assumptions: aliasingAssumptions(decl),
    elapsedMs: Date.now() - started,
    budgetExhausted,
    pathsExplored,
  };
  if (!report.budgetExhausted && report.verdict !== 'unproven') opts.proofCache?.put(report);
  return report;
}

/**
 * The verifier gives every `root.field` its own logical variable, which quietly
 * assumes two record parameters are not the same object. For `transfer(a, a, n)`
 * that assumption is false and the debit/credit postconditions genuinely do not
 * hold, so it cannot be left implicit.
 *
 * If the contract already rules the aliasing out — a `requires` disequality
 * between the two roots — there is nothing to report. Otherwise the assumption
 * is attached to the report, and the micro-world suite is expected to exercise
 * the aliased case.
 */
function aliasingAssumptions(decl: Extract<Term, { kind: 'FunctionDecl' }>): string[] {
  const byType = new Map<string, SymbolId[]>();
  for (const p of decl.params) {
    const base = underlying(p.ty);
    if (base.t !== 'Record') continue;
    const list = byType.get(base.name) ?? [];
    list.push(p.symbol);
    byType.set(base.name, list);
  }

  const disequal = new Set<string>();
  const contract = decl.contract?.kind === 'Contract' ? decl.contract : null;
  for (const clause of contract?.requires ?? []) {
    if (clause.kind !== 'Clause') continue;
    const e = clause.expr;
    if (e.kind !== 'Bin' || e.op !== 'ne') continue;
    const root = (t: Term): SymbolId | null =>
      t.kind === 'Var' ? t.symbol : t.kind === 'Field' ? root(t.object) : t.kind === 'Place' ? t.symbol : null;
    const a = root(e.left);
    const b = root(e.right);
    if (a && b && a !== b) disequal.add([a, b].sort().join('|'));
  }

  const out: string[] = [];
  for (const [typeName, symbols] of byType) {
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        if (disequal.has([symbols[i], symbols[j]].sort().join('|'))) continue;
        out.push(
          `parameters of type ${typeName} are assumed not to alias; ` +
            'add a requires-disequality between them, or rely on the micro-world suite ' +
            'to exercise the aliased case',
        );
      }
    }
  }
  return out;
}

/**
 * Mint the evidence a Chesterton's Fence will accept (FR-1.3).
 *
 * Only a fully proved report produces a `proved` verdict; anything resting on
 * property testing is labelled as such, and an architectural guard refuses it.
 */
export function dischargeProof(
  report: VerificationReport,
  invariant: InvariantId,
  subject: NodeRef,
): DischargeProof | null {
  if (
    report.verdict === 'refuted' ||
    report.subject !== subject ||
    report.frameViolations.length > 0 ||
    report.budgetExhausted
  ) return null;
  const proved = report.results.filter((r) => r.verdict === 'proved').length;
  const total = report.results.length;
  // An architectural guard demands `proved`, so an unchecked modelling
  // assumption must downgrade the evidence rather than ride along inside it.
  if (report.verdict === 'proved' && total > 0 && report.assumptions.length === 0) {
    return {
      invariant,
      verdict: 'proved',
      evidence: `${proved}/${total} obligations discharged by the SMT solver in ${report.elapsedMs}ms`,
      subject,
    };
  }
  return {
    invariant,
    verdict: 'property_checked',
    evidence:
      `${proved}/${total} obligations proved; ` +
      `${report.unprovenFormalContracts.length + report.delegatedToFuzzing.length} ` +
      'left to property testing' +
      (report.budgetExhausted ? ' (solver budget exhausted)' : '') +
      (report.assumptions.length ? `; ${report.assumptions.length} modelling assumption(s)` : ''),
    subject,
  };
}

/** A one-screen summary for a human auditor. */
export function formatReport(report: VerificationReport, nameOf?: (s: SymbolId) => string): string {
  const title = report.symbol ? (nameOf?.(report.symbol) ?? report.symbol) : '(anonymous)';
  const lines = [`${title}: ${report.verdict.toUpperCase()} (${report.elapsedMs}ms, ${report.pathsExplored} paths)`];
  for (const r of report.results) {
    const mark = { proved: '✓', refuted: '✗', unproven: '?', delegated: '~' }[r.verdict];
    lines.push(`  ${mark} ${r.obligation.kind} ${r.obligation.label} (${r.elapsedMs}ms)`);
    if (r.counterexample) {
      const bindings = Object.entries(r.counterexample)
        .filter(([k]) => !k.includes('!'))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      lines.push(`      counterexample: ${bindings}`);
    }
  }
  for (const v of report.frameViolations) lines.push(`  ! frame: ${v}`);
  for (const a of report.assumptions) lines.push(`  assumes: ${a}`);
  if (report.unprovenFormalContracts.length) {
    lines.push(`  UnprovenFormalContract: ${report.unprovenFormalContracts.join(', ')}`);
  }
  return lines.join('\n');
}
