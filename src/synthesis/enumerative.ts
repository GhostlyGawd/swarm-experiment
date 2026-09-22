/**
 * A reference synthesizer: counterexample-guided inductive synthesis (CEGIS).
 *
 * This exists so the loop in `loop.ts` can be exercised, demonstrated and
 * regression-tested without a language model in the loop. It is not a
 * pretender to one — it enumerates small expressions over the function's own
 * parameters and a handful of constants. What makes it more than brute force
 * is the feedback channel: every counterexample the verifier or the
 * micro-world produces is kept, and candidates are filtered against the whole
 * accumulated set before they are proposed.
 *
 * That is the same shape a model-backed agent has. The interesting part of
 * `Synthesizer` is not how candidates are invented; it is that every candidate
 * must survive the type checker, the solver and the simulators, and that the
 * evidence from each failure comes back in a form the next attempt can use.
 */

import * as b from '../tier1/build.ts';
import { size, type Param, type Term, type Ty } from '../tier1/ast.ts';
import { underlying } from '../tier2/typecheck.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { Runtime } from '../tier3/runtime.ts';
import { generateCase, materialise, type Plain } from '../tier3/generate.ts';
import { rng } from '../util/rng.ts';
import type { Feedback, Synthesizer } from './loop.ts';

export interface EnumerativeOptions {
  readonly registry: CapabilityRegistry;
  /** Largest expression the enumerator will consider. */
  readonly maxDepth?: number;
  /** Ceiling on candidates examined per proposal. */
  readonly maxCandidates?: number;
  /** Literals available to the search, beyond those found in the contract. */
  readonly constants?: readonly bigint[];
  readonly seed?: string;
}

const DEFAULT_CONSTANTS: readonly bigint[] = [0n, 1n, 2n, -1n, 100n];

/**
 * Candidate bodies, smallest first.
 *
 * Ordering by size matters: it makes the search deterministic, and it means
 * the first body that satisfies the contract is also the simplest one that
 * does, which is what a reviewer would have wanted anyway.
 */
function* enumerateExpressions(
  atoms: readonly Term[],
  depth: number,
): Generator<Term> {
  if (depth === 0) {
    yield* atoms;
    return;
  }
  const smaller = [...enumerateExpressions(atoms, depth - 1)];
  yield* smaller;

  for (const left of smaller) {
    for (const right of smaller) {
      yield b.add(left, right);
      yield b.sub(left, right);
      yield b.mul(left, right);
    }
  }
  yield* smaller.map((e) => b.neg(e));

  // Conditionals come last at each depth: prefer a straight-line answer.
  for (const left of smaller) {
    for (const right of smaller) {
      for (const op of ['lt', 'le', 'gt', 'ge', 'eq'] as const) {
        const test = b.bin(op, left, right);
        for (const then of smaller) {
          for (const otherwise of smaller) {
            if (then === otherwise) continue;
            yield b.cond(test, then, otherwise);
          }
        }
      }
    }
  }
}

export class EnumerativeSynthesizer implements Synthesizer {
  readonly name = 'enumerative-cegis';
  private readonly opts: EnumerativeOptions;
  /** Inputs on which some earlier candidate broke the contract. */
  private readonly examples: Plain[][] = [];
  /** Candidates already proposed, so each attempt offers something new. */
  private readonly proposed = new Set<string>();
  /** The body handed back last time, so its failure can be turned into inputs. */
  private lastCandidate: Term | null = null;

  constructor(opts: EnumerativeOptions) {
    this.opts = opts;
  }

  /** Every counterexample the loop has reported so far, as runnable inputs. */
  get exampleCount(): number {
    return this.examples.length;
  }

  propose(
    spec: Extract<Term, { kind: 'FunctionDecl' }>,
    feedback: readonly Feedback[],
    attempt: number,
  ): Term | null {
    this.absorb(spec, feedback);
    this.seedExamples(spec);

    const atoms = this.atomsFor(spec.params, spec.returns);
    if (atoms.length === 0) return null;

    const maxDepth = this.opts.maxDepth ?? 2;
    const maxCandidates = this.opts.maxCandidates ?? 20_000;
    let examined = 0;

    for (let depth = 0; depth <= maxDepth; depth++) {
      for (const expr of enumerateExpressions(atoms, depth)) {
        if (++examined > maxCandidates) return null;
        const body = b.block(b.ret(expr));
        const key = JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
        if (this.proposed.has(key)) continue;
        if (!this.satisfiesExamples(spec, body)) continue;
        this.proposed.add(key);
        this.lastCandidate = body;
        return body;
      }
    }
    void attempt;
    return null;
  }

  /** Turn reported failures into inputs the next candidate must survive. */
  private absorb(spec: Extract<Term, { kind: 'FunctionDecl' }>, feedback: readonly Feedback[]): void {
    for (const item of feedback) {
      if (item.stage === 'microworld') {
        for (const failure of item.failures) {
          const parsed = this.parseArguments(spec.params, failure.arguments);
          if (parsed) this.addExample(parsed);
        }
      }
      if (item.stage === 'verification' && this.lastCandidate) {
        this.harvestExamples(spec, this.lastCandidate);
      }
    }
  }

  /**
   * Seed a handful of random inputs so the very first proposal is already
   * filtered. Without this the search would hand over its smallest candidate
   * — usually a bare constant — and waste a whole verification cycle.
   */
  private seedExamples(spec: Extract<Term, { kind: 'FunctionDecl' }>): void {
    if (this.examples.length > 0) return;
    const random = rng(this.opts.seed ?? 'enumerative');
    for (let i = 0; i < 12; i++) {
      this.addExample(generateCase(spec.params, random.fork(`seed/${i}`), { size: 32 }));
    }
  }

  private addExample(args: Plain[]): void {
    const key = JSON.stringify(args, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
    if (this.examples.some((e) => JSON.stringify(e, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)) === key)) {
      return;
    }
    this.examples.push(args);
  }

  /** Run a candidate against every known example. Cheap: no solver involved. */
  private satisfiesExamples(spec: Extract<Term, { kind: 'FunctionDecl' }>, body: Term): boolean {
    const candidate: Term = { ...spec, body };
    for (const example of this.examples) {
      const rt = new Runtime({ registry: this.opts.registry, maxSteps: 5000 });
      rt.load(candidate);
      const args = materialise(example, rt);
      const result = rt.callDeclaration(candidate as Extract<Term, { kind: 'FunctionDecl' }>, args);
      if (result.ok) continue;
      // A precondition failure means this input was never in scope.
      if (result.fault.kind === 'precondition') continue;
      return false;
    }
    return true;
  }

  /** Parameters and their integer-typed fields, plus the constant pool. */
  private atomsFor(params: readonly Param[], returns: Ty): Term[] {
    const atoms: Term[] = [];
    const wanted = underlying(returns);

    for (const param of params) {
      const base = underlying(param.ty);
      if (base.t === 'Int') {
        atoms.push(b.v(param.symbol));
        continue;
      }
      if (base.t === 'Record') {
        for (const [field, fieldTy] of base.fields) {
          if (underlying(fieldTy).t === 'Int') atoms.push(b.field(b.v(param.symbol), field));
        }
      }
    }
    if (wanted.t !== 'Int') return atoms;

    const constants = this.opts.constants ?? DEFAULT_CONSTANTS;
    // Literals carry the return type, so a nominal money result stays nominal.
    for (const c of constants) atoms.push(b.typed(returns, c));
    return atoms.sort((x, y) => size(x) - size(y));
  }

  /** Recover a runnable case from a micro-world's rendered arguments. */
  private parseArguments(params: readonly Param[], rendered: readonly string[]): Plain[] | null {
    if (rendered.length !== params.length) return null;
    const out: Plain[] = [];
    for (let i = 0; i < params.length; i++) {
      const parsed = this.parseRendered(params[i].ty, rendered[i], out);
      if (!parsed) return null;
      out.push(parsed);
    }
    return out;
  }

  private parseRendered(ty: Ty, text: string, earlier: readonly Plain[]): Plain | null {
    const base = underlying(ty);
    const aliasMatch = /^<same as argument (\d+)>$/.exec(text);
    if (aliasMatch) {
      const index = Number(aliasMatch[1]);
      return earlier[index] ? { k: 'alias', index } : null;
    }
    switch (base.t) {
      case 'Int': return /^-?\d+$/.test(text) ? { k: 'int', v: BigInt(text) } : null;
      case 'Bool': return text === 'true' || text === 'false' ? { k: 'bool', v: text === 'true' } : null;
      case 'Str':
        try {
          return { k: 'str', v: JSON.parse(text) as string };
        } catch {
          return null;
        }
      case 'Unit': return { k: 'unit' };
      case 'Record': {
        const inner = /^\{\s*(.*)\s*\}$/.exec(text);
        if (!inner) return null;
        const fields: Record<string, Plain> = {};
        // Field renderings never contain a comma at top level for these types.
        for (const part of splitTopLevel(inner[1])) {
          const colon = part.indexOf(':');
          if (colon < 0) return null;
          const name = part.slice(0, colon).trim();
          const declared = base.fields.find(([n]) => n === name);
          if (!declared) return null;
          const value = this.parseRendered(declared[1], part.slice(colon + 1).trim(), earlier);
          if (!value) return null;
          fields[name] = value;
        }
        if (Object.keys(fields).length !== base.fields.length) return null;
        return { k: 'record', ty, fields };
      }
      default: return null;
    }
  }

  /**
   * Harvest a concrete failing input for the last candidate.
   *
   * The solver's counterexample is a flat model over mangled variable names,
   * which is the wrong shape to replay: it says `sender.balance = 0` without
   * saying which argument `sender` was. Rather than reconstruct it, the
   * synthesizer finds its own witness by running the rejected candidate over
   * generated inputs. Any input on which it breaks is equally good as a CEGIS
   * constraint, and this one is runnable by construction.
   */
  private harvestExamples(spec: Extract<Term, { kind: 'FunctionDecl' }>, body: Term): void {
    const candidate = { ...spec, body } as Extract<Term, { kind: 'FunctionDecl' }>;
    const random = rng(`${this.opts.seed ?? 'enumerative'}/harvest/${this.examples.length}`);
    let found = 0;
    for (let i = 0; i < 400 && found < 4; i++) {
      const args = generateCase(spec.params, random.fork(`case/${i}`), { size: 64 });
      const rt = new Runtime({ registry: this.opts.registry, maxSteps: 5000 });
      rt.load(candidate);
      const result = rt.callDeclaration(candidate, materialise(args, rt));
      if (result.ok || result.fault.kind === 'precondition') continue;
      this.addExample(args);
      found++;
    }
  }
}

/** Split on commas that are not inside braces. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}
