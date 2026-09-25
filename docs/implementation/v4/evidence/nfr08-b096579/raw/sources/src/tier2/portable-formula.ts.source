/** Checked propositional case coverage and linear normalization. No proof search. */
import type { SmtFormula, SmtTerm } from './smt.ts';
import { domainDigest, type Digest } from '../fabric/identity.ts';
import { bounded, PROOF_LIMITS, type LinearBound, type LinearClaim } from './portable-linear-kernel.ts';
import { exactObject, validString } from '../fabric/encoding.ts';
import { types as nodeTypes } from 'node:util';

export const FORMULA_PROFILE = Object.freeze({ format: 'aether.portable-formula-profile/1', calculus: 'integer-farkas-propositional/1', maxNodes: 20_000, maxDepth: 128, maxCases: 512, maxTerms: 128, linear: PROOF_LIMITS });
interface Linear { terms: Map<string, bigint>; constant: bigint }
interface Alternative { guards: SmtFormula[]; value: Linear }
interface Branch { rows: LinearBoundInternal[]; bools: Map<string, boolean> }
interface LinearBoundInternal { value: Linear; bound: bigint }
export interface FormulaCase {
  readonly index: number;
  readonly booleanLiterals: readonly (readonly [string, boolean])[];
  readonly claim: LinearClaim;
}
const scalar = (constant: bigint): Linear => ({ terms: new Map(), constant: bounded(constant) });
function plus(a: Linear, b: Linear): Linear {
  const terms = new Map(a.terms);
  for (const [name, value] of b.terms) { const sum = bounded((terms.get(name) ?? 0n) + value); if (sum === 0n) terms.delete(name); else terms.set(name, sum); }
  if (terms.size > PROOF_LIMITS.maxVariables) throw new RangeError('portable formula variable limit');
  return { terms, constant: bounded(a.constant + b.constant) };
}
function scale(value: Linear, factor: bigint): Linear {
  return { terms: new Map([...value.terms].map(([name, n]) => [name, bounded(n * factor)] as const).filter(([, n]) => n !== 0n)), constant: bounded(value.constant * factor) };
}
const empty = (): Branch => ({ rows: [], bools: new Map() });

/** Copy a typed mathematical goal without invoking accessors or proxy traps. */
function snapshotFormula(input: SmtFormula): SmtFormula {
  let nodes = 0;
  const active = new Set<object>();
  const name = (value: unknown): string => { validString(value); if (!value.length || value.length > 256) throw new TypeError('invalid portable variable name'); return value; };
  const array = <T>(value: unknown, item: (value: unknown) => T): T[] => {
    if (nodeTypes.isProxy(value) || !Array.isArray(value) || value.length > FORMULA_PROFILE.maxTerms) throw new TypeError('invalid portable formula array');
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('sparse or extended portable formula array');
    return Array.from({ length: value.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !('value' in d)) throw new TypeError('portable formula accessor'); return item(d.value); });
  };
  const visit = (input: unknown, term: boolean, depth: number): SmtFormula | SmtTerm => {
    if (++nodes > FORMULA_PROFILE.maxNodes || depth > FORMULA_PROFILE.maxDepth) throw new RangeError('portable formula traversal limit');
    if (nodeTypes.isProxy(input) || !input || typeof input !== 'object' || Array.isArray(input) || active.has(input)) throw new TypeError('opaque or cyclic portable formula');
    const descriptor = Object.getOwnPropertyDescriptor(input, 'k');
    if (!descriptor || !('value' in descriptor)) throw new TypeError('portable formula accessor or missing kind');
    const k = descriptor.value;
    const schema: Record<string, readonly string[] | undefined> = term ? { int: ['k', 'v'], var: ['k', 'name', 'sort'], add: ['k', 'args'], mul: ['k', 'args'], sub: ['k', 'left', 'right'], neg: ['k', 'arg'], ite: ['k', 'cond', 'then', 'otherwise'], app: ['k', 'name', 'args'] }
      : { true: ['k'], false: ['k'], bool: ['k', 'name'], not: ['k', 'arg'], and: ['k', 'args'], or: ['k', 'args'], implies: ['k', 'left', 'right'], iff: ['k', 'left', 'right'], cmp: ['k', 'op', 'left', 'right'] };
    if (typeof k !== 'string' || !Object.hasOwn(schema, k)) throw new TypeError('unknown portable formula kind');
    const value = exactObject(input, schema[k]!);
    active.add(input);
    const t = (value: unknown) => visit(value, true, depth + 1) as SmtTerm;
    const f = (value: unknown) => visit(value, false, depth + 1) as SmtFormula;
    try {
      switch (k) {
        case 'int': if (typeof value.v !== 'bigint') throw new TypeError('portable integer literal required'); return { k, v: bounded(value.v) };
        case 'var': if (value.sort !== 'Int' && value.sort !== 'Bool') throw new TypeError('unknown portable sort'); return { k, name: name(value.name), sort: value.sort };
        case 'add': case 'mul': return { k, args: array(value.args, t) };
        case 'sub': return { k, left: t(value.left), right: t(value.right) };
        case 'neg': return { k, arg: t(value.arg) };
        case 'ite': return { k, cond: f(value.cond), then: t(value.then), otherwise: t(value.otherwise) };
        case 'app': return { k, name: name(value.name), args: array(value.args, t) };
        case 'true': case 'false': return { k };
        case 'bool': return { k, name: name(value.name) };
        case 'not': return { k, arg: f(value.arg) };
        case 'and': case 'or': return { k, args: array(value.args, f) };
        case 'implies': case 'iff': return { k, left: f(value.left), right: f(value.right) };
        case 'cmp':
          if (!['eq', 'lt', 'le', 'gt', 'ge'].includes(value.op as string)) throw new TypeError('unknown portable comparison');
          return { k, op: value.op as Extract<SmtFormula, { k: 'cmp' }>['op'], left: t(value.left), right: t(value.right) };
        default: throw new TypeError('unknown portable formula kind');
      }
    } finally { active.delete(input); }
  };
  return visit(input, false, 0) as SmtFormula;
}

/** Enumerates every counterexample case of a universally quantified formula.
 * Contradictory Boolean literals become an explicit impossible arithmetic row;
 * they are never silently omitted from certificate coverage. */
export function formulaCounterexampleCases(formula: SmtFormula, executionManifest: Digest): readonly FormulaCase[] {
  formula = snapshotFormula(formula);
  let nodes = 0;
  const tick = (depth: number): void => { if (++nodes > FORMULA_PROFILE.maxNodes || depth > FORMULA_PROFILE.maxDepth) throw new RangeError('portable formula traversal limit'); };
  const limit = <T>(items: T[]): T[] => { if (items.length > FORMULA_PROFILE.maxCases) throw new RangeError('portable formula case limit'); return items; };
  const combine = (left: Branch[], right: Branch[]): Branch[] => {
    if (left.length * right.length > FORMULA_PROFILE.maxCases) throw new RangeError('portable formula case limit');
    return left.flatMap(a => right.map(b => {
      const rows = [...a.rows, ...b.rows], bools = new Map(a.bools);
      for (const [name, value] of b.bools) {
        if (bools.has(name) && bools.get(name) !== value) rows.push({ value: scalar(0n), bound: -1n });
        bools.set(name, value);
      }
      if (rows.length > PROOF_LIMITS.maxAssumptions) throw new RangeError('portable formula premise limit');
      return { rows, bools };
    }));
  };
  const terms = (term: SmtTerm, depth: number): Alternative[] => {
    tick(depth);
    switch (term.k) {
      case 'int': if (typeof term.v !== 'bigint') throw new TypeError('portable integer literal required'); return [{ guards: [], value: scalar(term.v) }];
      case 'var':
        if (term.sort !== 'Int' || typeof term.name !== 'string' || !term.name.length || term.name.length > 256) throw new TypeError('portable integer variable required');
        return [{ guards: [], value: { terms: new Map([[term.name, 1n]]), constant: 0n } }];
      case 'neg': return terms(term.arg, depth + 1).map(a => ({ guards: a.guards, value: scale(a.value, -1n) }));
      case 'ite': return limit([...terms(term.then, depth + 1).map(a => ({ ...a, guards: [term.cond, ...a.guards] })), ...terms(term.otherwise, depth + 1).map(a => ({ ...a, guards: [{ k: 'not', arg: term.cond } as SmtFormula, ...a.guards] }))]);
      case 'sub': return arithmetic([term.left, { k: 'neg', arg: term.right }], false, depth);
      case 'add': case 'mul': return arithmetic(term.args, term.k === 'mul', depth);
      default: throw new TypeError('unsupported portable arithmetic theory');
    }
  };
  const arithmetic = (args: readonly SmtTerm[], multiply: boolean, depth: number): Alternative[] => {
    if (!Array.isArray(args) || args.length > FORMULA_PROFILE.maxTerms) throw new RangeError('portable arithmetic arity limit');
    let alternatives: Alternative[] = [{ guards: [], value: scalar(multiply ? 1n : 0n) }];
    for (const term of args) {
      const next = terms(term, depth + 1);
      if (alternatives.length * next.length > FORMULA_PROFILE.maxCases) throw new RangeError('portable term case limit');
      alternatives = alternatives.flatMap(a => next.map(b => {
        if (multiply && a.value.terms.size && b.value.terms.size) throw new TypeError('nonlinear arithmetic remains unproved');
        const value = multiply ? a.value.terms.size ? scale(a.value, b.value.constant) : scale(b.value, a.value.constant) : plus(a.value, b.value);
        return { guards: [...a.guards, ...b.guards], value };
      }));
    }
    return alternatives;
  };
  const cases = (f: SmtFormula, truth: boolean, depth: number): Branch[] => {
    tick(depth);
    switch (f.k) {
      case 'true': return truth ? [empty()] : [];
      case 'false': return truth ? [] : [empty()];
      case 'bool': {
        if (typeof f.name !== 'string' || !f.name.length || f.name.length > 256) throw new TypeError('invalid portable Boolean variable');
        return [{ rows: [], bools: new Map([[f.name, truth]]) }];
      }
      case 'not': return cases(f.arg, !truth, depth + 1);
      case 'and': case 'or': {
        if (!Array.isArray(f.args) || f.args.length > FORMULA_PROFILE.maxTerms) throw new RangeError('portable Boolean arity limit');
        const conjunction = (f.k === 'and') === truth;
        if (conjunction) return f.args.reduce((acc, child) => combine(acc, cases(child, truth, depth + 1)), [empty()]);
        return limit(f.args.flatMap(child => cases(child, truth, depth + 1)));
      }
      case 'implies': return cases({ k: 'or', args: [{ k: 'not', arg: f.left }, f.right] }, truth, depth + 1);
      case 'iff': return cases({ k: 'or', args: [{ k: 'and', args: [f.left, f.right] }, { k: 'and', args: [{ k: 'not', arg: f.left }, { k: 'not', arg: f.right }] }] }, truth, depth + 1);
      case 'cmp': {
        if (!['eq', 'le', 'lt', 'ge', 'gt'].includes(f.op)) throw new TypeError('unknown portable comparison');
        if (f.op === 'eq') {
          const cmp = (op: 'le' | 'ge'): SmtFormula => ({ ...f, op });
          return truth ? combine(cases(cmp('le'), true, depth + 1), cases(cmp('ge'), true, depth + 1))
            : limit([...cases(cmp('le'), false, depth + 1), ...cases(cmp('ge'), false, depth + 1)]);
        }
        const positiveOp = truth ? f.op : ({ le: 'gt', lt: 'ge', ge: 'lt', gt: 'le' } as const)[f.op];
        const left = terms(f.left, depth + 1), right = terms(f.right, depth + 1);
        if (left.length * right.length > FORMULA_PROFILE.maxCases) throw new RangeError('portable comparison case limit');
        let result: Branch[] = [];
        for (const a of left) for (const b of right) {
          const diff = plus(a.value, scale(b.value, -1n));
          const value = positiveOp === 'gt' || positiveOp === 'ge' ? scale(diff, -1n) : diff;
          const bound = positiveOp === 'lt' || positiveOp === 'gt' ? -1n : 0n;
          const guards = [...a.guards, ...b.guards].reduce((acc, guard) => combine(acc, cases(guard, true, depth + 1)), [empty()]);
          result = limit([...result, ...combine(guards, [{ rows: [{ value, bound }], bools: new Map() }])]);
        }
        return result;
      }
      default: throw new TypeError('unsupported portable proposition');
    }
  };
  // Normalize subtraction structurally before the linear visitor, preserving all
  // children and bounded traversal rather than relying on a solver rewrite.
  const normalizeTerm = (term: SmtTerm, depth: number): SmtTerm => {
    tick(depth);
    if (term.k === 'sub') return { k: 'add', args: [normalizeTerm(term.left, depth + 1), { k: 'neg', arg: normalizeTerm(term.right, depth + 1) }] };
    if (term.k === 'add' || term.k === 'mul') {
      if (term.args.length > FORMULA_PROFILE.maxTerms) throw new RangeError('portable term arity limit');
      return { ...term, args: term.args.map(a => normalizeTerm(a, depth + 1)) };
    }
    if (term.k === 'neg') return { ...term, arg: normalizeTerm(term.arg, depth + 1) };
    if (term.k === 'ite') return { ...term, cond: normalizeFormula(term.cond, depth + 1), then: normalizeTerm(term.then, depth + 1), otherwise: normalizeTerm(term.otherwise, depth + 1) };
    return term;
  };
  const normalizeFormula = (f: SmtFormula, depth: number): SmtFormula => {
    tick(depth);
    if (f.k === 'cmp') return { ...f, left: normalizeTerm(f.left, depth + 1), right: normalizeTerm(f.right, depth + 1) };
    if (f.k === 'not') return { ...f, arg: normalizeFormula(f.arg, depth + 1) };
    if (f.k === 'and' || f.k === 'or') {
      if (f.args.length > FORMULA_PROFILE.maxTerms) throw new RangeError('portable Boolean arity limit');
      return { ...f, args: f.args.map(a => normalizeFormula(a, depth + 1)) };
    }
    if (f.k === 'implies' || f.k === 'iff') return { ...f, left: normalizeFormula(f.left, depth + 1), right: normalizeFormula(f.right, depth + 1) };
    return f;
  };
  return cases(normalizeFormula(formula, 0), false, 0).map((branch, index) => {
    const variables = [...new Set(branch.rows.flatMap(row => [...row.value.terms.keys()]))].sort();
    if (variables.length > PROOF_LIMITS.maxVariables) throw new RangeError('portable formula variable limit');
    const assumptions: LinearBound[] = branch.rows.map(row => ({ coefficients: variables.map(name => String(row.value.terms.get(name) ?? 0n)), bound: String(bounded(row.bound - row.value.constant)) }));
    return { index, booleanLiterals: [...branch.bools].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), claim: { format: 'aether.linear-claim/1', executionManifest, variables, assumptions, goal: { coefficients: variables.map(() => '0'), bound: '-1' } } };
  });
}

export function formulaCasesDigest(cases: readonly FormulaCase[]): Digest { return domainDigest('aether.portable-formula-cases/1', cases, { maxFrameBytes: 4 * 1024 * 1024, maxDecompressedBytes: 4 * 1024 * 1024, maxObjects: 500_000, maxDepth: 32 }); }
