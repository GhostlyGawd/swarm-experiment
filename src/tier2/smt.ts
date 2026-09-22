/**
 * The formula layer (FR-2.2).
 *
 * Contracts are compiled into quantifier-free linear integer arithmetic with
 * booleans — QF_LIA — which is decidable and, more to the point, decidable
 * *fast* on the shapes real preconditions take. The representation below is a
 * faithful subset of SMT-LIB 2, so a verification condition can be handed to
 * this repository's own solver or written out and given to Z3 unchanged. That
 * is deliberate: the built-in solver exists so the fabric has no hard external
 * dependency, not to compete with a mature one.
 */

export type Sort = 'Int' | 'Bool';

export type SmtTerm =
  | { k: 'int'; v: bigint }
  | { k: 'var'; name: string; sort: Sort }
  | { k: 'add'; args: readonly SmtTerm[] }
  | { k: 'mul'; args: readonly SmtTerm[] }
  | { k: 'sub'; left: SmtTerm; right: SmtTerm }
  | { k: 'neg'; arg: SmtTerm }
  | { k: 'ite'; cond: SmtFormula; then: SmtTerm; otherwise: SmtTerm };

export type Comparison = 'eq' | 'lt' | 'le' | 'gt' | 'ge';

export type SmtFormula =
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'bool'; name: string }
  | { k: 'not'; arg: SmtFormula }
  | { k: 'and'; args: readonly SmtFormula[] }
  | { k: 'or'; args: readonly SmtFormula[] }
  | { k: 'implies'; left: SmtFormula; right: SmtFormula }
  | { k: 'iff'; left: SmtFormula; right: SmtFormula }
  | { k: 'cmp'; op: Comparison; left: SmtTerm; right: SmtTerm };

// --- constructors ----------------------------------------------------------

export const T: SmtFormula = { k: 'true' };
export const F: SmtFormula = { k: 'false' };
export const num = (v: bigint | number): SmtTerm => ({ k: 'int', v: BigInt(v) });
export const intVar = (name: string): SmtTerm => ({ k: 'var', name, sort: 'Int' });
export const boolVar = (name: string): SmtFormula => ({ k: 'bool', name });
export const add = (...args: SmtTerm[]): SmtTerm => ({ k: 'add', args });
export const mul = (...args: SmtTerm[]): SmtTerm => ({ k: 'mul', args });
export const sub = (left: SmtTerm, right: SmtTerm): SmtTerm => ({ k: 'sub', left, right });
export const neg = (arg: SmtTerm): SmtTerm => ({ k: 'neg', arg });
export const ite = (cond: SmtFormula, then: SmtTerm, otherwise: SmtTerm): SmtTerm =>
  ({ k: 'ite', cond, then, otherwise });

export const cmp = (op: Comparison, left: SmtTerm, right: SmtTerm): SmtFormula =>
  ({ k: 'cmp', op, left, right });
export const eq = (l: SmtTerm, r: SmtTerm) => cmp('eq', l, r);
export const le = (l: SmtTerm, r: SmtTerm) => cmp('le', l, r);
export const lt = (l: SmtTerm, r: SmtTerm) => cmp('lt', l, r);
export const ge = (l: SmtTerm, r: SmtTerm) => cmp('ge', l, r);
export const gt = (l: SmtTerm, r: SmtTerm) => cmp('gt', l, r);

export const not = (arg: SmtFormula): SmtFormula =>
  arg.k === 'not' ? arg.arg : arg.k === 'true' ? F : arg.k === 'false' ? T : { k: 'not', arg };

export function and(...args: SmtFormula[]): SmtFormula {
  const flat = args.flatMap((a) => (a.k === 'and' ? a.args : [a]));
  if (flat.some((a) => a.k === 'false')) return F;
  const kept = flat.filter((a) => a.k !== 'true');
  return kept.length === 0 ? T : kept.length === 1 ? kept[0] : { k: 'and', args: kept };
}

export function or(...args: SmtFormula[]): SmtFormula {
  const flat = args.flatMap((a) => (a.k === 'or' ? a.args : [a]));
  if (flat.some((a) => a.k === 'true')) return T;
  const kept = flat.filter((a) => a.k !== 'false');
  return kept.length === 0 ? F : kept.length === 1 ? kept[0] : { k: 'or', args: kept };
}

export const implies = (left: SmtFormula, right: SmtFormula): SmtFormula =>
  left.k === 'true' ? right : left.k === 'false' ? T : { k: 'implies', left, right };

export const iff = (left: SmtFormula, right: SmtFormula): SmtFormula => ({ k: 'iff', left, right });

// --- inspection ------------------------------------------------------------

export interface Declarations {
  readonly ints: readonly string[];
  readonly bools: readonly string[];
}

export function declarations(formula: SmtFormula): Declarations {
  const ints = new Set<string>();
  const bools = new Set<string>();
  const walkTerm = (t: SmtTerm): void => {
    switch (t.k) {
      case 'int': return;
      case 'var': (t.sort === 'Int' ? ints : bools).add(t.name); return;
      case 'add': case 'mul': t.args.forEach(walkTerm); return;
      case 'sub': walkTerm(t.left); walkTerm(t.right); return;
      case 'neg': walkTerm(t.arg); return;
      case 'ite': walkFormula(t.cond); walkTerm(t.then); walkTerm(t.otherwise); return;
    }
  };
  const walkFormula = (f: SmtFormula): void => {
    switch (f.k) {
      case 'true': case 'false': return;
      case 'bool': bools.add(f.name); return;
      case 'not': walkFormula(f.arg); return;
      case 'and': case 'or': f.args.forEach(walkFormula); return;
      case 'implies': case 'iff': walkFormula(f.left); walkFormula(f.right); return;
      case 'cmp': walkTerm(f.left); walkTerm(f.right); return;
    }
  };
  walkFormula(formula);
  return { ints: [...ints].sort(), bools: [...bools].sort() };
}

// --- SMT-LIB 2 rendering ---------------------------------------------------

const OP_SYMBOL: Record<Comparison, string> = { eq: '=', lt: '<', le: '<=', gt: '>', ge: '>=' };

/** SMT-LIB identifiers are quoted only when they need to be. */
const symbol = (name: string): string =>
  /^[A-Za-z~!@$%^&*_+=<>.?/-][A-Za-z0-9~!@$%^&*_+=<>.?/-]*$/.test(name) ? name : `|${name}|`;

export function termToSmtLib(t: SmtTerm): string {
  switch (t.k) {
    case 'int': return t.v < 0n ? `(- ${-t.v})` : String(t.v);
    case 'var': return symbol(t.name);
    case 'add': return `(+ ${t.args.map(termToSmtLib).join(' ')})`;
    case 'mul': return `(* ${t.args.map(termToSmtLib).join(' ')})`;
    case 'sub': return `(- ${termToSmtLib(t.left)} ${termToSmtLib(t.right)})`;
    case 'neg': return `(- ${termToSmtLib(t.arg)})`;
    case 'ite':
      return `(ite ${formulaToSmtLib(t.cond)} ${termToSmtLib(t.then)} ${termToSmtLib(t.otherwise)})`;
  }
}

export function formulaToSmtLib(f: SmtFormula): string {
  switch (f.k) {
    case 'true': return 'true';
    case 'false': return 'false';
    case 'bool': return symbol(f.name);
    case 'not': return `(not ${formulaToSmtLib(f.arg)})`;
    case 'and': return `(and ${f.args.map(formulaToSmtLib).join(' ')})`;
    case 'or': return `(or ${f.args.map(formulaToSmtLib).join(' ')})`;
    case 'implies': return `(=> ${formulaToSmtLib(f.left)} ${formulaToSmtLib(f.right)})`;
    case 'iff': return `(= ${formulaToSmtLib(f.left)} ${formulaToSmtLib(f.right)})`;
    case 'cmp':
      return `(${OP_SYMBOL[f.op]} ${termToSmtLib(f.left)} ${termToSmtLib(f.right)})`;
  }
}

/**
 * A complete, runnable SMT-LIB 2 script.
 *
 * The point of emitting this is escape velocity: when the built-in solver
 * returns `unknown`, the exact query can be piped to Z3 or CVC5 without
 * re-encoding anything, and the answer means the same thing.
 */
export function toSmtLibScript(
  formula: SmtFormula,
  opts: { logic?: string; getModel?: boolean; comment?: string } = {},
): string {
  const { ints, bools } = declarations(formula);
  const lines: string[] = [];
  if (opts.comment) for (const line of opts.comment.split('\n')) lines.push(`; ${line}`);
  lines.push(`(set-logic ${opts.logic ?? 'QF_LIA'})`);
  for (const name of ints) lines.push(`(declare-const ${symbol(name)} Int)`);
  for (const name of bools) lines.push(`(declare-const ${symbol(name)} Bool)`);
  lines.push(`(assert ${formulaToSmtLib(formula)})`);
  lines.push('(check-sat)');
  if (opts.getModel !== false) lines.push('(get-model)');
  return lines.join('\n') + '\n';
}

/** Evaluate a formula under a total assignment. Used to validate models. */
export function evaluate(
  formula: SmtFormula,
  model: Readonly<Record<string, bigint | boolean>>,
): boolean {
  const term = (t: SmtTerm): bigint => {
    switch (t.k) {
      case 'int': return t.v;
      case 'var': {
        const v = model[t.name];
        if (typeof v !== 'bigint') throw new ReferenceError(`no Int binding for ${t.name}`);
        return v;
      }
      case 'add': return t.args.reduce((n, a) => n + term(a), 0n);
      case 'mul': return t.args.reduce((n, a) => n * term(a), 1n);
      case 'sub': return term(t.left) - term(t.right);
      case 'neg': return -term(t.arg);
      case 'ite': return form(t.cond) ? term(t.then) : term(t.otherwise);
    }
  };
  const form = (f: SmtFormula): boolean => {
    switch (f.k) {
      case 'true': return true;
      case 'false': return false;
      case 'bool': {
        const v = model[f.name];
        if (typeof v !== 'boolean') throw new ReferenceError(`no Bool binding for ${f.name}`);
        return v;
      }
      case 'not': return !form(f.arg);
      case 'and': return f.args.every(form);
      case 'or': return f.args.some(form);
      case 'implies': return !form(f.left) || form(f.right);
      case 'iff': return form(f.left) === form(f.right);
      case 'cmp': {
        const l = term(f.left);
        const r = term(f.right);
        switch (f.op) {
          case 'eq': return l === r;
          case 'lt': return l < r;
          case 'le': return l <= r;
          case 'gt': return l > r;
          case 'ge': return l >= r;
        }
      }
    }
  };
  return form(formula);
}
