/**
 * A QF_LIA decision procedure (FR-2.2, NFR 6.2).
 *
 * Architecture is lazy DPLL(T):
 *
 *   1. Arithmetic atoms are normalised into a canonical linear form, so that
 *      `a >= b` and `b <= a` become the same atom and negation stays inside
 *      the atom language (over integers, `¬(t ≤ 0)` is `t ≥ 1`, which is
 *      strictly stronger than the rational negation — free tightening).
 *   2. The boolean skeleton is Tseitin-encoded to CNF and solved by DPLL with
 *      unit propagation.
 *   3. Each propositional model is handed to the theory solver, which runs
 *      Fourier–Motzkin elimination over the rationals. A theory conflict is
 *      fed back as a blocking clause and the search resumes.
 *
 * What the result words mean, exactly:
 *
 *   • `unsat`   — sound. Rational infeasibility implies integer infeasibility,
 *                 so this is a real proof, and it is the answer `prove` needs.
 *   • `sat`     — a candidate model, *validated by evaluation* before it is
 *                 returned. If the rational solution has no integer witness we
 *                 report `unknown` rather than a counterexample nobody can run.
 *   • `unknown` — out of budget, or beyond the fragment (see below).
 *
 * Beyond the fragment: a product of two variables, or division by a
 * non-constant, is abstracted to a fresh variable, congruently — the same
 * subterm always maps to the same variable. Abstraction only *weakens* the
 * constraint system, so `unsat` stays sound; `sat` becomes a candidate that
 * validation may reject. Division and modulo by a positive constant are not
 * abstracted away entirely: they carry the linear facts `a = q·b + r` and
 * `-b < r < b`, which hold for truncating division at either sign.
 */

import {
  and as fAnd,
  declarations,
  eq as fEq,
  evaluate,
  implies as fImplies,
  intVar,
  not as fNot,
  termToSmtLib,
  type Comparison,
  type SmtFormula,
  type SmtTerm,
} from './smt.ts';

// ---------------------------------------------------------------------------
// exact rational arithmetic
// ---------------------------------------------------------------------------

interface Rat {
  readonly n: bigint;
  readonly d: bigint; // always > 0
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    [x, y] = [y, x % y];
  }
  return x;
}

function rat(n: bigint, d: bigint = 1n): Rat {
  if (d === 0n) throw new RangeError('rational with zero denominator');
  const sign = d < 0n ? -1n : 1n;
  const nn = n * sign;
  const dd = d * sign;
  const g = gcd(nn, dd) || 1n;
  return { n: nn / g, d: dd / g };
}

const R0 = rat(0n);
const rAdd = (a: Rat, b: Rat) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const rSub = (a: Rat, b: Rat) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const rMul = (a: Rat, b: Rat) => rat(a.n * b.n, a.d * b.d);
const rDiv = (a: Rat, b: Rat) => rat(a.n * b.d, a.d * b.n);
const rNeg = (a: Rat) => rat(-a.n, a.d);
const rSign = (a: Rat) => (a.n > 0n ? 1 : a.n < 0n ? -1 : 0);
const rCmp = (a: Rat, b: Rat) => rSign(rSub(a, b));
const rIsZero = (a: Rat) => a.n === 0n;

function rFloor(r: Rat): bigint {
  const q = r.n / r.d;
  return r.n % r.d !== 0n && r.n < 0n ? q - 1n : q;
}

function rCeil(r: Rat): bigint {
  const q = r.n / r.d;
  return r.n % r.d !== 0n && r.n > 0n ? q + 1n : q;
}

// ---------------------------------------------------------------------------
// linear forms
// ---------------------------------------------------------------------------

/** `Σ coeff·var + constant`, with zero coefficients dropped. */
interface Linear {
  readonly coeffs: ReadonlyMap<string, Rat>;
  readonly constant: Rat;
}

const linConst = (c: Rat): Linear => ({ coeffs: new Map(), constant: c });
const linVar = (name: string): Linear => ({ coeffs: new Map([[name, rat(1n)]]), constant: R0 });

function linAdd(a: Linear, b: Linear): Linear {
  const coeffs = new Map(a.coeffs);
  for (const [v, c] of b.coeffs) {
    const next = rAdd(coeffs.get(v) ?? R0, c);
    if (rIsZero(next)) coeffs.delete(v);
    else coeffs.set(v, next);
  }
  return { coeffs, constant: rAdd(a.constant, b.constant) };
}

function linScale(a: Linear, k: Rat): Linear {
  if (rIsZero(k)) return linConst(R0);
  const coeffs = new Map<string, Rat>();
  for (const [v, c] of a.coeffs) coeffs.set(v, rMul(c, k));
  return { coeffs, constant: rMul(a.constant, k) };
}

const linSub = (a: Linear, b: Linear): Linear => linAdd(a, linScale(b, rat(-1n)));
const linIsConst = (a: Linear): boolean => a.coeffs.size === 0;

/** Canonical text form, so equal atoms are recognised as equal. */
function linKey(a: Linear): string {
  const parts = [...a.coeffs.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return parts.map(([v, c]) => `${c.n}/${c.d}*${v}`).join('+') + `|${a.constant.n}/${a.constant.d}`;
}

/**
 * An atom is `form ≤ 0` (non-strict) or `form < 0` (strict).
 * Every comparison in the input normalises into one of these.
 */
interface Atom {
  readonly form: Linear;
  readonly strict: boolean;
}

const atomKey = (a: Atom): string => `${a.strict ? '<' : '<='}${linKey(a.form)}`;

/** Are all variables in this form integer-sorted? Controls tightening. */
type IntegerCheck = (name: string) => boolean;

/**
 * Negate `form ≤ 0`. Over the rationals that is `form > 0`, i.e. `-form < 0`.
 * When every variable is an integer and all coefficients are integral, it is
 * `-form + 1 ≤ 0`, which is strictly stronger and still sound.
 */
function negateAtom(a: Atom, allInt: IntegerCheck): Atom {
  const flipped = linScale(a.form, rat(-1n));
  if (a.strict) return { form: flipped, strict: false }; // ¬(f < 0) is f ≥ 0
  const integral =
    [...a.form.coeffs.entries()].every(([v, c]) => c.d === 1n && allInt(v)) &&
    a.form.constant.d === 1n;
  return integral
    ? { form: linAdd(flipped, linConst(rat(1n))), strict: false }
    : { form: flipped, strict: true };
}

// ---------------------------------------------------------------------------
// Fourier–Motzkin with integer tightening
// ---------------------------------------------------------------------------

interface Constraint {
  readonly form: Linear;
  readonly strict: boolean;
}

/**
 * Sharpen `Σ aᵢxᵢ + c ≤ 0` using the fact that every xᵢ is an integer.
 *
 * Clear denominators, divide through by the gcd of the coefficients, and round
 * the bound inwards. This is what turns `2x ≤ 1` into `x ≤ 0` — the step that
 * separates integer reasoning from rational reasoning, and the reason
 * `2x = 1` comes back unsatisfiable rather than "no integer model found".
 * Tightening only ever removes non-integer points, so it cannot make a
 * satisfiable system look unsatisfiable.
 */
function tightenIntegral(c: Constraint, allInt: IntegerCheck): Constraint {
  if (c.form.coeffs.size === 0) return c;
  if (![...c.form.coeffs.keys()].every(allInt)) return c;

  let lcm = 1n;
  for (const [, k] of c.form.coeffs) lcm = (lcm / gcd(lcm, k.d)) * k.d;
  lcm = (lcm / gcd(lcm, c.form.constant.d)) * c.form.constant.d;

  const scaled = new Map<string, bigint>();
  for (const [v, k] of c.form.coeffs) scaled.set(v, k.n * (lcm / k.d));
  const constant = c.form.constant.n * (lcm / c.form.constant.d);

  let g = 0n;
  for (const [, a] of scaled) g = gcd(g, a);
  if (g === 0n) return c;

  // A strict integer inequality `f < 0` is exactly `f + 1 ≤ 0`.
  const adjusted = c.strict ? constant + 1n : constant;
  const bound = rFloor(rat(-adjusted, g));
  const coeffs = new Map<string, Rat>();
  for (const [v, a] of scaled) coeffs.set(v, rat(a / g));
  return { form: { coeffs, constant: rat(-bound) }, strict: false };
}

interface Elimination {
  readonly v: string;
  /** `v + U ≤ 0`, i.e. an upper bound `v ≤ -U`. */
  readonly uppers: readonly Constraint[];
  /** `-v + L ≤ 0`, i.e. a lower bound `v ≥ L`. */
  readonly lowers: readonly Constraint[];
}

/** Why the theory solver gave up, so the caller can report it accurately. */
export type IncompleteReason = 'timeout' | 'too_large' | 'no_integer_model';

type TheoryResult =
  | { status: 'unsat' }
  | { status: 'unknown'; reason: IncompleteReason }
  | { status: 'sat'; model: ReadonlyMap<string, bigint> };

/**
 * Decide a conjunction of linear constraints and, when satisfiable, build an
 * integer witness.
 *
 * Elimination order is recorded so the model can be recovered by
 * back-substitution: the last variable eliminated is bounded only by constants,
 * so it is assigned first, and each earlier variable is then bounded by
 * variables that already have values.
 */
function fourierMotzkin(
  atoms: readonly Atom[],
  deadline: number,
  allInt: IntegerCheck,
): TheoryResult {
  let current: Constraint[] = atoms.map((a) => tightenIntegral(a, allInt));
  const vars = new Set<string>();
  for (const a of current) for (const v of a.form.coeffs.keys()) vars.add(v);

  const infeasible = (c: Constraint): boolean => {
    const s = rSign(c.form.constant);
    return s > 0 || (s === 0 && c.strict);
  };
  for (const c of current) {
    if (linIsConst(c.form) && infeasible(c)) return { status: 'unsat' };
  }

  const eliminations: Elimination[] = [];
  const remaining = [...vars];

  while (remaining.length) {
    if (Date.now() > deadline) return { status: 'unknown', reason: 'timeout' };

    // Eliminate whichever variable produces the fewest new constraints.
    let best: { v: string; cost: number } | null = null;
    for (const v of remaining) {
      let pos = 0;
      let neg = 0;
      for (const c of current) {
        const k = c.form.coeffs.get(v);
        if (!k) continue;
        if (rSign(k) > 0) pos++;
        else neg++;
      }
      const cost = pos * neg - (pos + neg);
      if (!best || cost < best.cost) best = { v, cost };
    }
    const v = best!.v;
    remaining.splice(remaining.indexOf(v), 1);

    const uppers: Constraint[] = [];
    const lowers: Constraint[] = [];
    const rest: Constraint[] = [];
    for (const c of current) {
      const k = c.form.coeffs.get(v);
      if (!k) {
        rest.push(c);
        continue;
      }
      // Scale so the coefficient of v is exactly ±1.
      const magnitude = rat(k.n < 0n ? -k.n : k.n, k.d);
      const scaled = { form: linScale(c.form, rDiv(rat(1n), magnitude)), strict: c.strict };
      (rSign(k) > 0 ? uppers : lowers).push(scaled);
    }
    eliminations.push({ v, uppers, lowers });

    const next = rest;
    for (const u of uppers) {
      for (const l of lowers) {
        // (v + U ≤ 0) and (-v + L ≤ 0) combine to (U + L ≤ 0): v cancels.
        const combined = tightenIntegral(
          { form: linAdd(u.form, l.form), strict: u.strict || l.strict },
          allInt,
        );
        if (linIsConst(combined.form)) {
          if (infeasible(combined)) return { status: 'unsat' };
          continue;
        }
        next.push(combined);
      }
    }
    current = [];
    for (const c of next) {
      if (linIsConst(c.form)) {
        if (infeasible(c)) return { status: 'unsat' };
        continue;
      }
      current.push(c);
    }
    // Elimination blew up: this is the quadratic blow-up Fourier-Motzkin is
    // known for, and the honest answer is that the query is out of reach here.
    if (current.length > 4000) return { status: 'unknown', reason: 'too_large' };
  }

  for (const c of current) if (infeasible(c)) return { status: 'unsat' };

  // --- back-substitution -----------------------------------------------------
  const model = new Map<string, bigint>();
  const evalForm = (f: Linear, skip: string): Rat | null => {
    let total = f.constant;
    for (const [name, k] of f.coeffs) {
      if (name === skip) continue;
      const value = model.get(name);
      if (value === undefined) return null;
      total = rAdd(total, rMul(k, rat(value)));
    }
    return total;
  };

  for (let i = eliminations.length - 1; i >= 0; i--) {
    const { v, uppers, lowers } = eliminations[i];
    let hi: bigint | null = null;
    let lo: bigint | null = null;

    for (const u of uppers) {
      const rest = evalForm(u.form, v);
      if (rest === null) return { status: 'unknown', reason: 'no_integer_model' };
      // v ≤ -rest, or v < -rest when strict.
      const bound = rNeg(rest);
      const candidate = u.strict ? rCeil(bound) - 1n : rFloor(bound);
      hi = hi === null || candidate < hi ? candidate : hi;
    }
    for (const l of lowers) {
      const rest = evalForm(l.form, v);
      if (rest === null) return { status: 'unknown', reason: 'no_integer_model' };
      // -v + rest ≤ 0 means v ≥ rest, or v > rest when strict.
      const candidate = l.strict ? rFloor(rest) + 1n : rCeil(rest);
      lo = lo === null || candidate > lo ? candidate : lo;
    }

    if (lo !== null && hi !== null && lo > hi) {
      // Rationally feasible, but no integer point in this slot.
      return { status: 'unknown', reason: 'no_integer_model' };
    }
    model.set(v, lo ?? hi ?? 0n);
  }

  return { status: 'sat', model };
}

// ---------------------------------------------------------------------------
// term normalisation (formula -> atoms + boolean skeleton)
// ---------------------------------------------------------------------------

type Literal = number; // +(atomIndex+1) or -(atomIndex+1); boolean vars share the space

class Normalizer {
  readonly atoms: Atom[] = [];
  private readonly atomIndex = new Map<string, number>();
  /** Propositional variables: arithmetic atoms first, then boolean vars. */
  readonly boolNames = new Map<string, number>();
  /** Variables introduced to stand for terms outside the fragment. */
  readonly abstractions = new Map<string, SmtTerm>();
  /** Definitional axioms generated while linearizing (currently `ite`). */
  readonly sideConditions: SmtFormula[] = [];
  private abstractCounter = 0;
  private readonly intVars = new Set<string>();
  private readonly iteDefined = new Set<string>();

  constructor(declaredInts: readonly string[]) {
    for (const v of declaredInts) this.intVars.add(v);
  }

  isInt = (name: string): boolean => this.intVars.has(name);

  atomFor(a: Atom): number {
    const key = atomKey(a);
    const hit = this.atomIndex.get(key);
    if (hit !== undefined) return hit;
    this.atomIndex.set(key, this.atoms.length);
    this.atoms.push(a);
    return this.atoms.length - 1;
  }

  boolFor(name: string): number {
    const hit = this.boolNames.get(name);
    if (hit !== undefined) return hit;
    const idx = this.atoms.length + this.boolNames.size;
    this.boolNames.set(name, idx);
    return idx;
  }

  /**
   * A fresh integer variable standing for a term the theory cannot see into.
   * The key is the term's own canonical rendering, so the *same* subterm always
   * maps to the same variable — congruence, which is what lets `x*y = x*y`
   * still be recognised as trivially true.
   */
  private abstractTerm(t: SmtTerm, prefix: string): Linear {
    const name = `${prefix}!${termToSmtLib(t)}`;
    if (!this.abstractions.has(name)) {
      this.abstractions.set(name, t);
      this.intVars.add(name);
      this.abstractCounter++;
    }
    return linVar(name);
  }

  get abstractedCount(): number {
    return this.abstractCounter;
  }

  linearize(t: SmtTerm): Linear {
    switch (t.k) {
      case 'int': return linConst(rat(t.v));
      case 'var':
        if (t.sort === 'Int') this.intVars.add(t.name);
        return linVar(t.name);
      case 'add': return t.args.map((a) => this.linearize(a)).reduce(linAdd, linConst(R0));
      case 'sub': return linSub(this.linearize(t.left), this.linearize(t.right));
      case 'neg': return linScale(this.linearize(t.arg), rat(-1n));
      case 'mul': {
        let acc = linConst(rat(1n));
        const nonConst: Linear[] = [];
        for (const arg of t.args) {
          const lin = this.linearize(arg);
          if (linIsConst(lin)) acc = linScale(acc, lin.constant);
          else nonConst.push(lin);
        }
        if (nonConst.length === 0) return acc;
        if (nonConst.length === 1) return linScale(nonConst[0], acc.constant);
        // A genuine product of unknowns: abstract it congruently.
        return this.abstractTerm(t, 'nl');
      }
      case 'ite': {
        // Not a linear form, but exactly definable: introduce `w` and assert
        // `c → w = then` and `¬c → w = otherwise`. No precision is lost.
        const name = `ite!${termToSmtLib(t)}`;
        if (!this.iteDefined.has(name)) {
          this.iteDefined.add(name);
          this.intVars.add(name);
          const w = intVar(name);
          this.sideConditions.push(
            fAnd(
              fImplies(t.cond, fEq(w, t.then)),
              fImplies(fNot(t.cond), fEq(w, t.otherwise)),
            ),
          );
        }
        return linVar(name);
      }
    }
  }

  atomFromComparison(op: Comparison, left: SmtTerm, right: SmtTerm): { atom: Atom; negated: boolean } | 'split' {
    const l = this.linearize(left);
    const r = this.linearize(right);
    const diff = linSub(l, r);
    switch (op) {
      case 'le': return { atom: { form: diff, strict: false }, negated: false };
      case 'lt': return { atom: { form: this.tighten(diff), strict: false }, negated: false };
      case 'ge': return { atom: { form: linScale(diff, rat(-1n)), strict: false }, negated: false };
      case 'gt': return { atom: { form: this.tighten(linScale(diff, rat(-1n))), strict: false }, negated: false };
      case 'eq': return 'split'; // handled as (≤ ∧ ≥) by the caller
    }
  }

  /** `f < 0` over integers with integral coefficients is `f + 1 ≤ 0`. */
  private tighten(f: Linear): Linear {
    const integral =
      [...f.coeffs.entries()].every(([v, c]) => c.d === 1n && this.isInt(v)) && f.constant.d === 1n;
    return integral ? linAdd(f, linConst(rat(1n))) : f;
  }
}

// ---------------------------------------------------------------------------
// Tseitin CNF + DPLL
// ---------------------------------------------------------------------------

/**
 * A clause under construction. Variable ids are not final while encoding runs
 * — Tseitin variables are numbered after the atom count settles — so sign is
 * carried alongside the id rather than folded into it. Folding it in early is
 * how you end up with literal `0`, which has no sign.
 */
interface RawLit {
  /** Non-negative: an atom or boolean variable. Negative: a Tseitin placeholder. */
  readonly v: number;
  readonly sign: boolean;
}

class CnfBuilder {
  readonly clauses: RawLit[][] = [];
  add(...clause: RawLit[]): void {
    this.clauses.push(clause);
  }
}

const raw = (v: number, sign: boolean): RawLit => ({ v, sign });
const lit = (v: number, positive: boolean): Literal => (positive ? v + 1 : -(v + 1));
const litVar = (l: Literal): number => Math.abs(l) - 1;
const litSign = (l: Literal): boolean => l > 0;

/** DPLL with unit propagation. Returns a total assignment or null. */
function dpll(
  clauses: readonly Literal[][],
  varCount: number,
  deadline: number,
  onModel: (assign: Int8Array) => Literal[] | null,
): Int8Array | null | 'timeout' {
  const working: Literal[][] = clauses.map((c) => [...c]);
  const assign = new Int8Array(varCount).fill(0); // 0 unassigned, 1 true, -1 false

  const satisfied = (clause: readonly Literal[]): boolean =>
    clause.some((l) => assign[litVar(l)] === (litSign(l) ? 1 : -1));
  const unassignedIn = (clause: readonly Literal[]): Literal[] =>
    clause.filter((l) => assign[litVar(l)] === 0);

  const propagate = (trail: number[]): boolean => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const clause of working) {
        if (satisfied(clause)) continue;
        const open = unassignedIn(clause);
        if (open.length === 0) return false;
        if (open.length === 1) {
          const l = open[0];
          assign[litVar(l)] = litSign(l) ? 1 : -1;
          trail.push(litVar(l));
          changed = true;
        }
      }
    }
    return true;
  };

  const search = (): boolean | 'timeout' => {
    if (Date.now() > deadline) return 'timeout';
    const trail: number[] = [];
    if (!propagate(trail)) {
      for (const v of trail) assign[v] = 0;
      return false;
    }
    let pick = -1;
    for (let v = 0; v < varCount; v++) {
      if (assign[v] === 0) {
        pick = v;
        break;
      }
    }
    if (pick === -1) {
      const blocking = onModel(assign);
      if (blocking === null) return true; // theory agrees
      working.push(blocking);
      for (const v of trail) assign[v] = 0;
      return false;
    }
    for (const value of [1, -1] as const) {
      assign[pick] = value;
      const result = search();
      if (result === 'timeout') return 'timeout';
      if (result) return true;
      assign[pick] = 0;
    }
    for (const v of trail) assign[v] = 0;
    return false;
  };

  // The blocking-clause loop restarts the search whenever the theory rejects a
  // model, so a failed search may simply mean "try again with more clauses".
  for (;;) {
    const before = working.length;
    const result = search();
    if (result === 'timeout') return 'timeout';
    if (result) return assign;
    if (working.length === before) return null; // genuinely unsatisfiable
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export type SolverStatus = 'sat' | 'unsat' | 'unknown';

export interface SolverResult {
  readonly status: SolverStatus;
  /** Present when `status` is `sat`; validated by evaluation before return. */
  readonly model?: Readonly<Record<string, bigint | boolean>>;
  /** Why the answer is `unknown`. */
  readonly reason?: IncompleteReason | 'nonlinear';
  readonly elapsedMs: number;
  /** Subterms abstracted away, which is what makes `sat` only a candidate. */
  readonly abstractedTerms: number;
}

export interface SolveOptions {
  /** NFR 6.2 fixes this at 2,000 ms per function. */
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 2000;

/** Is `formula` satisfiable? */
export function checkSat(formula: SmtFormula, opts: SolveOptions = {}): SolverResult {
  const started = Date.now();
  const deadline = started + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const decls = declarations(formula);
  const norm = new Normalizer(decls.ints);

  // --- encode the boolean skeleton -----------------------------------------
  const builder = new CnfBuilder();
  const encode = (f: SmtFormula): number => {
    switch (f.k) {
      case 'true': {
        const v = reserve();
        builder.add(raw(v, true));
        return v;
      }
      case 'false': {
        const v = reserve();
        builder.add(raw(v, false));
        return v;
      }
      case 'bool': return norm.boolFor(f.name);
      case 'not': {
        const inner = encode(f.arg);
        const v = reserve();
        builder.add(raw(v, false), raw(inner, false));
        builder.add(raw(v, true), raw(inner, true));
        return v;
      }
      case 'and': {
        const parts = f.args.map(encode);
        const v = reserve();
        for (const p of parts) builder.add(raw(v, false), raw(p, true));
        builder.add(raw(v, true), ...parts.map((p) => raw(p, false)));
        return v;
      }
      case 'or': {
        const parts = f.args.map(encode);
        const v = reserve();
        for (const p of parts) builder.add(raw(v, true), raw(p, false));
        builder.add(raw(v, false), ...parts.map((p) => raw(p, true)));
        return v;
      }
      case 'implies': return encode({ k: 'or', args: [{ k: 'not', arg: f.left }, f.right] });
      case 'iff': {
        const a = encode(f.left);
        const b = encode(f.right);
        const v = reserve();
        builder.add(raw(v, false), raw(a, false), raw(b, true));
        builder.add(raw(v, false), raw(b, false), raw(a, true));
        builder.add(raw(v, true), raw(a, true), raw(b, true));
        builder.add(raw(v, true), raw(a, false), raw(b, false));
        return v;
      }
      case 'cmp': {
        if (f.op === 'eq') {
          return encode({
            k: 'and',
            args: [
              { k: 'cmp', op: 'le', left: f.left, right: f.right },
              { k: 'cmp', op: 'ge', left: f.left, right: f.right },
            ],
          });
        }
        const built = norm.atomFromComparison(f.op, f.left, f.right);
        if (built === 'split') throw new Error('unreachable: eq handled above');
        return norm.atomFor(built.atom);
      }
    }
  };

  // Propositional variable ids: atoms and boolean names occupy the low range,
  // Tseitin variables the high range. `reserve` allocates above both, and the
  // low range can still grow while encoding, so it is resized at the end.
  const tseitin: number[] = [];
  const reserve = (): number => {
    const v = -(tseitin.length + 1); // placeholder, remapped below
    tseitin.push(v);
    return v;
  };

  const roots: number[] = [encode(formula)];

  // Encoding can *generate* side conditions (an `ite` met for the first time
  // defines a new variable), and a side condition can contain another `ite`.
  // Keep encoding until the queue stops growing, then compute the remap once.
  for (let next = 0; next < norm.sideConditions.length; next++) {
    roots.push(encode(norm.sideConditions[next]));
  }

  // Remap placeholders now that the atom/bool count is final.
  const base = norm.atoms.length + norm.boolNames.size;
  const remap = (v: number): number => (v < 0 ? base + (-v - 1) : v);
  const varCount = base + tseitin.length;
  const clauses = builder.clauses.map((c) => c.map((l) => lit(remap(l.v), l.sign)));
  for (const root of roots) clauses.push([lit(remap(root), true)]);

  if (varCount > 20000 || clauses.length > 200000) {
    return {
      status: 'unknown',
      reason: 'too_large',
      elapsedMs: Date.now() - started,
      abstractedTerms: norm.abstractedCount,
    };
  }

  // --- search --------------------------------------------------------------
  let theoryModel: ReadonlyMap<string, bigint> = new Map();
  let theoryIncomplete: IncompleteReason | null = null;
  const onModel = (assign: Int8Array): Literal[] | null => {
    const active: Atom[] = [];
    const involved: Literal[] = [];
    for (let i = 0; i < norm.atoms.length; i++) {
      if (assign[i] === 0) continue;
      const positive = assign[i] === 1;
      active.push(positive ? norm.atoms[i] : negateAtom(norm.atoms[i], norm.isInt));
      involved.push(lit(i, !positive)); // the blocking clause flips this literal
    }
    const verdict = fourierMotzkin(active, deadline, norm.isInt);
    if (verdict.status === 'sat') {
      theoryModel = verdict.model;
      theoryIncomplete = null;
      return null;
    }
    if (verdict.status === 'unknown') {
      theoryModel = new Map();
      theoryIncomplete = verdict.reason;
      return null; // let model validation have the last word
    }
    // An unsatisfiable theory state with no literals at all cannot happen:
    // a constant-only conflict is caught before the search begins.
    return involved.length ? involved : [];
  };

  const assignment = dpll(clauses, varCount, deadline, onModel);
  const elapsedMs = () => Date.now() - started;

  if (assignment === 'timeout') {
    return { status: 'unknown', reason: 'timeout', elapsedMs: elapsedMs(), abstractedTerms: norm.abstractedCount };
  }
  if (assignment === null) {
    return { status: 'unsat', elapsedMs: elapsedMs(), abstractedTerms: norm.abstractedCount };
  }

  // --- assemble the model and validate it ----------------------------------
  const model = assembleModel(formula, norm, assignment, theoryModel);
  if (theoryIncomplete === null && evaluate(formula, model)) {
    return { status: 'sat', model, elapsedMs: elapsedMs(), abstractedTerms: norm.abstractedCount };
  }
  return {
    status: 'unknown',
    // The theory's own reason wins: reporting `no_integer_model` for what was
    // really a deadline would send an agent looking for the wrong problem.
    reason: theoryIncomplete ?? (norm.abstractedCount > 0 ? 'nonlinear' : 'no_integer_model'),
    elapsedMs: elapsedMs(),
    abstractedTerms: norm.abstractedCount,
  };
}

/**
 * Combine the boolean assignment and the theory's integer witness into a total
 * model over the formula's declared variables.
 *
 * The result is validated by evaluation before it is ever returned as a
 * counterexample. An unvalidated model is worse than none: it sends an agent
 * chasing a failure that does not reproduce.
 */
function assembleModel(
  formula: SmtFormula,
  norm: Normalizer,
  assignment: Int8Array,
  theoryModel: ReadonlyMap<string, bigint>,
): Record<string, bigint | boolean> {
  const decls = declarations(formula);
  const model: Record<string, bigint | boolean> = {};
  for (const [name, idx] of norm.boolNames) model[name] = assignment[idx] === 1;
  for (const [name, value] of theoryModel) {
    if (!norm.abstractions.has(name)) model[name] = value;
  }
  for (const name of decls.ints) if (!(name in model)) model[name] = 0n;
  for (const name of decls.bools) if (!(name in model)) model[name] = false;
  return model;
}

/**
 * Is `formula` valid — true under every assignment?
 *
 * Implemented as unsatisfiability of its negation, which is the only direction
 * this solver is allowed to answer authoritatively. A `sat` result comes back
 * as a counterexample the caller can run.
 */
export function prove(formula: SmtFormula, opts: SolveOptions = {}): SolverResult {
  const result = checkSat({ k: 'not', arg: formula }, opts);
  switch (result.status) {
    case 'unsat': return { ...result, status: 'unsat' }; // valid
    case 'sat': return { ...result, status: 'sat' }; // counterexample
    default: return result;
  }
}
