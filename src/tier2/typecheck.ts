/**
 * The type and capability checker (FR-2.3).
 *
 * One pass decides three things at once, because in Aether they are the same
 * question — is this term admissible?
 *
 *   • types, including nominal money types that do not silently coerce to Int,
 *   • capability discipline: an `Invoke` is well-typed only inside a function
 *     that declares the capability, and a `Call` only if the callee's
 *     capabilities are a subset of the caller's,
 *   • contract well-formedness: `old(…)` and `result` are legal in an
 *     `ensures` clause and nowhere else.
 *
 * Errors carry the path to the offending node, so an agent can address the
 * exact subtree instead of re-reading a file.
 */

import {
  children,
  linkGroups,
  type Param,
  type Term,
  type Ty,
} from '../tier1/ast.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import { CapabilityEnvelope, type CapabilityRegistry } from './ocap.ts';

export type DiagnosticCode =
  | 'unbound_symbol'
  | 'type_mismatch'
  | 'unknown_field'
  | 'not_a_record'
  | 'arity_mismatch'
  | 'unknown_function'
  | 'capability_not_granted'
  | 'capability_escalation'
  | 'unknown_capability'
  | 'purity_violation'
  | 'contract_only_expression'
  | 'missing_return'
  | 'assign_to_immutable'
  | 'frame_violation'
  | 'separation_violation';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  /** Field path from the checked root to the offending node. */
  readonly path: readonly string[];
  readonly hint?: string;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** Capabilities actually reached by the checked subtree. */
  readonly usedCapabilities: readonly CapabilityName[];
}

export const tyEqual = (a: Ty, b: Ty): boolean => {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'Int': case 'Bool': case 'Str': case 'Unit':
      return true;
    case 'Nominal':
      return a.name === (b as typeof a).name && tyEqual(a.repr, (b as typeof a).repr);
    case 'Record': {
      const other = b as typeof a;
      return (
        a.name === other.name &&
        a.fields.length === other.fields.length &&
        a.fields.every(([n, t], i) => n === other.fields[i][0] && tyEqual(t, other.fields[i][1]))
      );
    }
    case 'Result': {
      const other = b as typeof a;
      return tyEqual(a.ok, other.ok) && tyEqual(a.err, other.err);
    }
    case 'Seq': return tyEqual(a.element, (b as typeof a).element);
    case 'Fn': {
      const other = b as typeof a;
      return a.params.length === other.params.length &&
        a.params.every((param, index) => tyEqual(param, other.params[index])) &&
        tyEqual(a.returns, other.returns) &&
        [...a.capabilities].sort().join('|') === [...other.capabilities].sort().join('|');
    }
    case 'TypeVar': return a.name === (b as typeof a).name;
    case 'IntN': {
      const other = b as typeof a;
      return a.bits === other.bits && a.signed === other.signed && a.overflow === other.overflow;
    }
    case 'Owned': return tyEqual(a.inner, (b as typeof a).inner);
    case 'Task': return tyEqual(a.result, (b as typeof a).result);
  }
};

export function tyToString(t: Ty): string {
  switch (t.t) {
    case 'Int': return 'Int';
    case 'Bool': return 'Bool';
    case 'Str': return 'Str';
    case 'Unit': return 'Unit';
    case 'Nominal': return t.name;
    case 'Record': return t.name;
    case 'Result': return `Result<${tyToString(t.ok)}, ${tyToString(t.err)}>`;
    case 'Seq': return `Seq<${tyToString(t.element)}>`;
    case 'Fn': return `(${t.params.map(tyToString).join(', ')}) => ${tyToString(t.returns)}`;
    case 'TypeVar': return t.name;
    case 'IntN': return `${t.signed ? 'i' : 'u'}${t.bits}/${t.overflow}`;
    case 'Owned': return `Owned<${tyToString(t.inner)}>`;
    case 'Task': return `Task<${tyToString(t.result)}>`;
  }
}

/** Strip nominal wrappers to reach the underlying representation. */
export const underlying = (t: Ty): Ty =>
  t.t === 'Nominal' ? underlying(t.repr)
    : t.t === 'Owned' ? underlying(t.inner)
      : t.t === 'IntN' ? { t: 'Int' } : t;

export function substituteType(ty: Ty, substitutions: ReadonlyMap<string, Ty>): Ty {
  switch (ty.t) {
    case 'TypeVar': return substitutions.get(ty.name) ?? ty;
    case 'Nominal': return { ...ty, repr: substituteType(ty.repr, substitutions) };
    case 'Record': return { ...ty, fields: ty.fields.map(([name, field]) => [name, substituteType(field, substitutions)] as const) };
    case 'Result': return { ...ty, ok: substituteType(ty.ok, substitutions), err: substituteType(ty.err, substitutions) };
    case 'Seq': return { ...ty, element: substituteType(ty.element, substitutions) };
    case 'Fn': return {
      ...ty,
      params: ty.params.map((param) => substituteType(param, substitutions)),
      returns: substituteType(ty.returns, substitutions),
    };
    case 'Owned': return { ...ty, inner: substituteType(ty.inner, substitutions) };
    case 'Task': return { ...ty, result: substituteType(ty.result, substitutions) };
    default: return ty;
  }
}

function unifyType(pattern: Ty, actual: Ty, substitutions: Map<string, Ty>): boolean {
  if (pattern.t === 'TypeVar') {
    const existing = substitutions.get(pattern.name);
    if (!existing) {
      substitutions.set(pattern.name, actual);
      return true;
    }
    return tyEqual(existing, actual);
  }
  if (pattern.t !== actual.t) return false;
  switch (pattern.t) {
    case 'Nominal': return pattern.name === (actual as typeof pattern).name &&
      unifyType(pattern.repr, (actual as typeof pattern).repr, substitutions);
    case 'Record': {
      const other = actual as typeof pattern;
      return pattern.name === other.name && pattern.fields.length === other.fields.length &&
        pattern.fields.every(([name, field], index) =>
          name === other.fields[index][0] && unifyType(field, other.fields[index][1], substitutions));
    }
    case 'Result': {
      const other = actual as typeof pattern;
      return unifyType(pattern.ok, other.ok, substitutions) && unifyType(pattern.err, other.err, substitutions);
    }
    case 'Seq': return unifyType(pattern.element, (actual as typeof pattern).element, substitutions);
    case 'Fn': {
      const other = actual as typeof pattern;
      return pattern.params.length === other.params.length &&
        pattern.params.every((param, index) => unifyType(param, other.params[index], substitutions)) &&
        unifyType(pattern.returns, other.returns, substitutions);
    }
    case 'IntN': return tyEqual(pattern, actual);
    case 'Owned': return unifyType(pattern.inner, actual.t === 'Owned' ? actual.inner : actual, substitutions);
    case 'Task': return unifyType(pattern.result, (actual as typeof pattern).result, substitutions);
    default: return true;
  }
}

interface FnSignature {
  readonly symbol: SymbolId;
  readonly params: readonly Param[];
  readonly returns: Ty;
  readonly capabilities: readonly CapabilityName[];
  readonly purity: 'pure' | 'effectful';
  readonly typeParams: readonly string[];
}

/** Where in a contract we are, which decides whether `old`/`result` are legal. */
type ClauseContext = 'body' | 'requires' | 'ensures' | 'invariant';

interface Scope {
  readonly vars: Map<SymbolId, Ty>;
  readonly parent: Scope | null;
}

const lookup = (scope: Scope | null, sym: SymbolId): Ty | undefined => {
  for (let s = scope; s; s = s.parent) {
    const hit = s.vars.get(sym);
    if (hit) return hit;
  }
  return undefined;
};

export interface CheckOptions {
  readonly registry: CapabilityRegistry;
  readonly symbols?: SymbolSpace;
  /** Capabilities available to the checked root. Defaults to the declaration's own. */
  readonly envelope?: CapabilityEnvelope;
  /** Signatures visible from outside the checked subtree. */
  readonly externals?: readonly FnSignature[];
}

export class TypeChecker {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly used = new Set<CapabilityName>();
  private readonly signatures = new Map<SymbolId, FnSignature>();
  private readonly opts: CheckOptions;

  constructor(opts: CheckOptions) {
    this.opts = opts;
    for (const sig of opts.externals ?? []) this.signatures.set(sig.symbol, sig);
  }

  private show(sym: SymbolId): string {
    return this.opts.symbols?.nameOf(sym) ?? sym;
  }

  private error(code: DiagnosticCode, message: string, path: readonly string[], hint?: string): void {
    this.diagnostics.push({ code, message, path: [...path], hint });
  }

  check(term: Term): CheckResult {
    this.collectSignatures(term);
    this.checkTerm(term, { vars: new Map(), parent: null }, CapabilityEnvelope.empty(), [], 'body');
    return {
      ok: this.diagnostics.length === 0,
      diagnostics: this.diagnostics,
      usedCapabilities: [...this.used].sort(),
    };
  }

  /** Pre-pass so that mutually recursive declarations resolve in either order. */
  private collectSignatures(term: Term): void {
    if (term.kind === 'FunctionDecl') {
      this.signatures.set(term.symbol, {
        symbol: term.symbol,
        params: term.params,
        returns: term.returns,
        capabilities: term.capabilities,
        purity: term.purity,
        typeParams: term.typeParams,
      });
    }
    for (const child of children(term)) this.collectSignatures(child);
  }

  private checkTerm(
    term: Term,
    scope: Scope,
    env: CapabilityEnvelope,
    path: readonly string[],
    ctx: ClauseContext,
  ): void {
    switch (term.kind) {
      case 'Module': {
        const inner: Scope = { vars: new Map(), parent: scope };
        term.members.forEach((m, i) =>
          this.checkTerm(m, inner, env, [...path, `members[${i}]`], ctx));
        return;
      }
      case 'FunctionDecl': {
        const inner: Scope = { vars: new Map(), parent: scope };
        for (const p of term.params) inner.vars.set(p.symbol, p.ty);
        for (const s of term.surfaces) {
          if (s.kind === 'Surface') {
            inner.vars.set(s.symbol, s.domain.d === 'range' ? { t: 'Int' } : { t: 'Str' });
          }
        }

        for (const cap of term.capabilities) {
          if (!this.opts.registry.get(cap)) {
            this.error('unknown_capability', `${cap} is not a registered capability`,
              [...path, 'capabilities']);
          }
        }
        if (term.purity === 'pure' && term.capabilities.length > 0) {
          this.error('purity_violation',
            `${this.show(term.symbol)} is declared pure but demands ${term.capabilities.join(', ')}`,
            path,
            'Either drop the capabilities or declare the function effectful.');
        }

        // A function's body may use exactly the capabilities it declares.
        const fnEnv = CapabilityEnvelope.of(...term.capabilities);

        const outerResult = this.resultType;
        this.resultType = term.returns;
        try {
          if (term.contract) {
            this.checkContract(term.contract, inner, fnEnv, [...path, 'contract']);
          }
          if (term.body) {
            this.checkTerm(term.body, inner, fnEnv, [...path, 'body'], 'body');
            if (!tyEqual(term.returns, { t: 'Unit' }) && !this.alwaysReturns(term.body)) {
              this.error('missing_return',
                `${this.show(term.symbol)} returns ${tyToString(term.returns)} but a path falls off the end`,
                [...path, 'body']);
            }
          }
        } finally {
          this.resultType = outerResult;
        }
        return;
      }
      case 'Contract':
        this.checkContract(term, scope, env, path);
        return;
      case 'Block': {
        const inner: Scope = { vars: new Map(), parent: scope };
        term.stmts.forEach((s, i) => this.checkTerm(s, inner, env, [...path, `stmts[${i}]`], ctx));
        return;
      }
      case 'Let': {
        const actual = this.typeOf(term.init, scope, env, [...path, 'init'], ctx);
        this.expect(term.ty, actual, [...path, 'init'], `initializer of ${this.show(term.symbol)}`);
        scope.vars.set(term.symbol, term.ty);
        return;
      }
      case 'Assign': {
        const target = this.typeOf(term.target, scope, env, [...path, 'target'], ctx);
        const value = this.typeOf(term.value, scope, env, [...path, 'value'], ctx);
        this.expect(target, value, [...path, 'value'], 'assignment');
        return;
      }
      case 'If': {
        this.expect({ t: 'Bool' }, this.typeOf(term.cond, scope, env, [...path, 'cond'], ctx),
          [...path, 'cond'], 'if condition');
        this.checkTerm(term.then, scope, env, [...path, 'then'], ctx);
        if (term.otherwise) this.checkTerm(term.otherwise, scope, env, [...path, 'otherwise'], ctx);
        return;
      }
      case 'While': {
        this.expect({ t: 'Bool' }, this.typeOf(term.cond, scope, env, [...path, 'cond'], ctx),
          [...path, 'cond'], 'loop condition');
        term.invariants.forEach((inv, i) =>
          this.expect({ t: 'Bool' }, this.typeOf(inv, scope, env, [...path, `invariants[${i}]`], 'invariant'),
            [...path, `invariants[${i}]`], 'loop invariant'));
        if (term.variant) {
          this.expect({ t: 'Int' }, underlying(this.typeOf(term.variant, scope, env, [...path, 'variant'], 'invariant')),
            [...path, 'variant'], 'loop variant');
        }
        this.checkTerm(term.body, scope, env, [...path, 'body'], ctx);
        return;
      }
      case 'Return': {
        const actual = this.typeOf(term.value, scope, env, [...path, 'value'], ctx);
        this.expect(this.resultType ?? { t: 'Unit' }, actual, [...path, 'value'], 'return value');
        return;
      }
      case 'Assert':
        this.expect({ t: 'Bool' }, this.typeOf(term.expr, scope, env, [...path, 'expr'], ctx),
          [...path, 'expr'], `assertion "${term.label}"`);
        return;
      case 'ExprStmt':
        this.typeOf(term.expr, scope, env, [...path, 'expr'], ctx);
        return;
      case 'Yield': return;
      case 'Atomic':
        this.checkTerm(term.body, scope, env, [...path, 'body'], ctx);
        return;
      case 'TypeDecl':
      case 'Surface':
      case 'SymbolTable':
      case 'Import':
        return;
      default:
        this.typeOf(term, scope, env, path, ctx);
    }
  }

  private checkContract(
    contract: Term,
    scope: Scope,
    env: CapabilityEnvelope,
    path: readonly string[],
  ): void {
    if (contract.kind !== 'Contract') return;
    const withResult: Scope = { vars: new Map(), parent: scope };
    for (const [field, clauses, ctx] of [
      ['requires', contract.requires, 'requires'],
      ['ensures', contract.ensures, 'ensures'],
    ] as const) {
      clauses.forEach((clause, i) => {
        if (clause.kind !== 'Clause') return;
        const p = [...path, `${field}[${i}]`];
        this.expect(
          { t: 'Bool' },
          this.typeOf(clause.expr, withResult, env, p, ctx),
          p,
          `${field} clause "${clause.label}"`,
        );
      });
    }
    contract.modifies.forEach((m, i) => {
      const p = [...path, `modifies[${i}]`];
      if (m.kind !== 'Place') {
        this.error('frame_violation', 'a modifies entry must be a place expression', p);
        return;
      }
      this.typeOf(m, withResult, env, p, 'ensures');
    });
  }

  /** Does every path through this statement return? Used for exhaustiveness. */
  private alwaysReturns(stmt: Term): boolean {
    switch (stmt.kind) {
      case 'Return': return true;
      case 'Block': return stmt.stmts.some((s) => this.alwaysReturns(s));
      case 'If':
        return stmt.otherwise !== null &&
          this.alwaysReturns(stmt.then) && this.alwaysReturns(stmt.otherwise);
      default: return false;
    }
  }

  private expect(expected: Ty, actual: Ty, path: readonly string[], what: string): void {
    if (tyEqual(expected, actual)) return;
    // The most common real mistake is mixing a nominal quantity with its bare
    // representation, so say that rather than restating the two type names.
    const nominal = expected.t === 'Nominal' ? expected : actual.t === 'Nominal' ? actual : null;
    const other = nominal === expected ? actual : expected;
    const confusable = nominal !== null && tyEqual(underlying(nominal), other);
    this.error('type_mismatch',
      `${what} has type ${tyToString(actual)}, expected ${tyToString(expected)}`,
      path,
      confusable
        ? `${tyToString(nominal!)} is a distinct money type, not an alias for ` +
          `${tyToString(other)}; convert explicitly if that is really intended.`
        : undefined);
  }

  private typeOf(
    term: Term,
    scope: Scope,
    env: CapabilityEnvelope,
    path: readonly string[],
    ctx: ClauseContext,
  ): Ty {
    switch (term.kind) {
      case 'Lit': return term.ty;
      case 'Var': {
        const ty = lookup(scope, term.symbol);
        if (!ty) {
          this.error('unbound_symbol', `${this.show(term.symbol)} is not in scope`, path);
          return { t: 'Unit' };
        }
        return ty;
      }
      case 'Place': {
        let ty = lookup(scope, term.symbol);
        if (!ty) {
          this.error('unbound_symbol', `${this.show(term.symbol)} is not in scope`, path);
          return { t: 'Unit' };
        }
        for (const seg of term.path) ty = this.fieldType(ty, seg, path);
        return ty;
      }
      case 'Field':
        return this.fieldType(this.typeOf(term.object, scope, env, [...path, 'object'], ctx), term.field, path);
      case 'Un': {
        const operand = this.typeOf(term.operand, scope, env, [...path, 'operand'], ctx);
        if (term.op === 'not') {
          this.expect({ t: 'Bool' }, operand, path, 'operand of !');
          return { t: 'Bool' };
        }
        this.expect({ t: 'Int' }, underlying(operand), path, 'operand of unary -');
        return operand;
      }
      case 'Bin': return this.binType(term, scope, env, path, ctx);
      case 'Cond': {
        this.expect({ t: 'Bool' }, this.typeOf(term.cond, scope, env, [...path, 'cond'], ctx),
          [...path, 'cond'], 'conditional test');
        const a = this.typeOf(term.then, scope, env, [...path, 'then'], ctx);
        const b = this.typeOf(term.otherwise, scope, env, [...path, 'otherwise'], ctx);
        this.expect(a, b, [...path, 'otherwise'], 'conditional branches');
        return a;
      }
      case 'RecordLit': {
        if (term.ty.t !== 'Record') {
          this.error('not_a_record', `record literal annotated ${tyToString(term.ty)}`, path);
          return term.ty;
        }
        const declared = new Map(term.ty.fields);
        for (const [name, value] of term.fields) {
          const expected = declared.get(name);
          const actual = this.typeOf(value, scope, env, [...path, `fields.${name}`], ctx);
          if (!expected) {
            this.error('unknown_field', `${tyToString(term.ty)} has no field ${name}`, path);
            continue;
          }
          this.expect(expected, actual, [...path, `fields.${name}`], `field ${name}`);
        }
        for (const [name] of term.ty.fields) {
          if (!term.fields.some(([n]) => n === name)) {
            this.error('unknown_field', `record literal omits field ${name}`, path);
          }
        }
        return term.ty;
      }
      case 'ResultValue': {
        const expected = term.variant === 'ok' ? term.ty.ok : term.ty.err;
        const actual = this.typeOf(term.value, scope, env, [...path, 'value'], ctx);
        this.expect(expected, actual, [...path, 'value'], `${term.variant} payload`);
        return term.ty;
      }
      case 'MatchResult': {
        const value = this.typeOf(term.value, scope, env, [...path, 'value'], ctx);
        if (value.t !== 'Result') {
          this.error('type_mismatch', `match expects Result, got ${tyToString(value)}`, [...path, 'value']);
          return { t: 'Unit' };
        }
        const okScope: Scope = { vars: new Map([[term.okSymbol, value.ok]]), parent: scope };
        const errScope: Scope = { vars: new Map([[term.errSymbol, value.err]]), parent: scope };
        const ok = this.typeOf(term.ok, okScope, env, [...path, 'ok'], ctx);
        const err = this.typeOf(term.err, errScope, env, [...path, 'err'], ctx);
        this.expect(ok, err, [...path, 'err'], 'match branches');
        return ok;
      }
      case 'SeqLit':
        term.items.forEach((item, i) => {
          const actual = this.typeOf(item, scope, env, [...path, `items[${i}]`], ctx);
          this.expect(term.ty.element, actual, [...path, `items[${i}]`], 'sequence element');
        });
        return term.ty;
      case 'SeqIndex': {
        const sequence = this.typeOf(term.sequence, scope, env, [...path, 'sequence'], ctx);
        const index = this.typeOf(term.index, scope, env, [...path, 'index'], ctx);
        this.expect({ t: 'Int' }, underlying(index), [...path, 'index'], 'sequence index');
        if (sequence.t !== 'Seq') {
          this.error('type_mismatch', `index expects Seq, got ${tyToString(sequence)}`, [...path, 'sequence']);
          return { t: 'Unit' };
        }
        return sequence.element;
      }
      case 'SeqLength': {
        const sequence = this.typeOf(term.sequence, scope, env, [...path, 'sequence'], ctx);
        if (sequence.t !== 'Seq') {
          this.error('type_mismatch', `length expects Seq, got ${tyToString(sequence)}`, [...path, 'sequence']);
        }
        return { t: 'Int' };
      }
      case 'SeqMap': {
        const sequence = this.typeOf(term.sequence, scope, env, [...path, 'sequence'], ctx);
        const signature = this.signatures.get(term.callee);
        if (sequence.t !== 'Seq' || !signature || signature.params.length !== 1) {
          this.error('type_mismatch', 'map expects a sequence and a unary function', path);
          return { t: 'Seq', element: { t: 'Unit' } };
        }
        this.expect(signature.params[0].ty, sequence.element, [...path, 'sequence'], 'map input');
        for (const cap of signature.capabilities) {
          if (!env.has(cap)) this.error('capability_escalation', `map callback requires ${cap}`, path);
          this.used.add(cap);
        }
        return { t: 'Seq', element: signature.returns };
      }
      case 'SeqFold': {
        const sequence = this.typeOf(term.sequence, scope, env, [...path, 'sequence'], ctx);
        const initial = this.typeOf(term.initial, scope, env, [...path, 'initial'], ctx);
        const signature = this.signatures.get(term.callee);
        if (sequence.t !== 'Seq' || !signature || signature.params.length !== 2) {
          this.error('type_mismatch', 'fold expects a sequence and a binary function', path);
          return initial;
        }
        this.expect(signature.params[0].ty, initial, [...path, 'initial'], 'fold accumulator');
        this.expect(signature.params[1].ty, sequence.element, [...path, 'sequence'], 'fold element');
        this.expect(signature.params[0].ty, signature.returns, path, 'fold callback result');
        for (const cap of signature.capabilities) {
          if (!env.has(cap)) this.error('capability_escalation', `fold callback requires ${cap}`, path);
          this.used.add(cap);
        }
        return initial;
      }
      case 'Lambda': {
        const inner: Scope = { vars: new Map(), parent: scope };
        for (const param of term.params) inner.vars.set(param.symbol, param.ty);
        for (const capability of term.capabilities) {
          if (!this.opts.registry.get(capability)) {
            this.error('unknown_capability', `${capability} is not registered`, path);
          }
          if (!env.has(capability)) {
            this.error('capability_escalation', `closure captures ${capability}, which is not in scope`, path);
          }
        }
        const closureEnv = env.attenuate(term.capabilities);
        const body = this.typeOf(term.body, inner, closureEnv, [...path, 'body'], ctx);
        this.expect(term.returns, body, [...path, 'body'], 'closure result');
        return {
          t: 'Fn', params: term.params.map((param) => param.ty), returns: term.returns,
          capabilities: term.capabilities,
        };
      }
      case 'Apply': {
        const fn = this.typeOf(term.fn, scope, env, [...path, 'fn'], ctx);
        if (fn.t !== 'Fn') {
          this.error('type_mismatch', `apply expects a function, got ${tyToString(fn)}`, [...path, 'fn']);
          return { t: 'Unit' };
        }
        if (fn.params.length !== term.args.length) {
          this.error('arity_mismatch', `closure takes ${fn.params.length} arguments, got ${term.args.length}`, path);
        }
        term.args.forEach((arg, index) => {
          const actual = this.typeOf(arg, scope, env, [...path, `args[${index}]`], ctx);
          if (fn.params[index]) this.expect(fn.params[index], actual, [...path, `args[${index}]`], 'closure argument');
        });
        for (const capability of fn.capabilities) {
          if (!env.has(capability)) {
            this.error('capability_escalation', `closure application requires ${capability}`, path);
          }
          this.used.add(capability);
        }
        return fn.returns;
      }
      case 'StringOp': {
        const arity = { strlen: 1, contains: 2, slice: 3, lower: 1, upper: 1, trim: 1 }[term.op];
        if (term.args.length !== arity) {
          this.error('arity_mismatch', `${term.op} takes ${arity} arguments, got ${term.args.length}`, path);
        }
        term.args.forEach((arg, index) => {
          const actual = this.typeOf(arg, scope, env, [...path, `args[${index}]`], ctx);
          const expected: Ty = term.op === 'slice' && index > 0 ? { t: 'Int' } : { t: 'Str' };
          this.expect(expected, underlying(actual), [...path, `args[${index}]`], `${term.op} argument`);
        });
        if (term.op === 'strlen') return { t: 'Int' };
        if (term.op === 'contains') return { t: 'Bool' };
        return { t: 'Str' };
      }
      case 'IntCast': {
        const actual = this.typeOf(term.value, scope, env, [...path, 'value'], ctx);
        this.expect({ t: 'Int' }, underlying(actual), [...path, 'value'], 'fixed-width conversion');
        return term.ty;
      }
      case 'FixedBin': {
        const left = this.typeOf(term.left, scope, env, [...path, 'left'], ctx);
        const right = this.typeOf(term.right, scope, env, [...path, 'right'], ctx);
        this.expect(term.ty, left, [...path, 'left'], 'fixed-width left operand');
        this.expect(term.ty, right, [...path, 'right'], 'fixed-width right operand');
        return term.ty;
      }
      case 'ForAll': {
        const start = this.typeOf(term.start, scope, env, [...path, 'start'], ctx);
        const end = this.typeOf(term.end, scope, env, [...path, 'end'], ctx);
        this.expect({ t: 'Int' }, underlying(start), [...path, 'start'], 'forall lower bound');
        this.expect({ t: 'Int' }, underlying(end), [...path, 'end'], 'forall upper bound');
        const inner: Scope = { vars: new Map([[term.symbol, { t: 'Int' }]]), parent: scope };
        const body = this.typeOf(term.body, inner, env, [...path, 'body'], ctx);
        this.expect({ t: 'Bool' }, body, [...path, 'body'], 'forall body');
        return { t: 'Bool' };
      }
      case 'Spawn':
        return { t: 'Task', result: this.typeOf(term.body, scope, env, [...path, 'body'], ctx) };
      case 'Await': {
        const task = this.typeOf(term.task, scope, env, [...path, 'task'], ctx);
        if (task.t !== 'Task') {
          this.error('type_mismatch', `await expects Task, got ${tyToString(task)}`, [...path, 'task']);
          return { t: 'Unit' };
        }
        return task.result;
      }
      case 'Old':
        if (ctx !== 'ensures') {
          this.error('contract_only_expression', 'old(…) is only meaningful in an ensures clause', path,
            'A precondition already speaks about the pre-state.');
        }
        return this.typeOf(term.expr, scope, env, [...path, 'expr'], ctx);
      case 'ResultRef':
        if (ctx !== 'ensures') {
          this.error('contract_only_expression', 'result is only bound in an ensures clause', path);
        }
        return this.resultType ?? { t: 'Unit' };
      case 'Call': {
        const sig = this.signatures.get(term.callee);
        if (!sig) {
          this.error('unknown_function', `${this.show(term.callee)} is not declared`, path);
          return { t: 'Unit' };
        }
        if (sig.params.length !== term.args.length) {
          this.error('arity_mismatch',
            `${this.show(term.callee)} takes ${sig.params.length} arguments, got ${term.args.length}`, path);
        }
        const substitutions = new Map<string, Ty>();
        term.args.forEach((arg, i) => {
          const actual = this.typeOf(arg, scope, env, [...path, `args[${i}]`], ctx);
          if (sig.params[i]) {
            const expected = sig.params[i].ty;
            const assignable = expected.t === 'Owned' ? expected.inner : expected;
            if (sig.typeParams.length) {
              if (!unifyType(assignable, actual, substitutions)) {
                this.error('type_mismatch',
                  `argument ${i} of ${this.show(term.callee)} has type ${tyToString(actual)}, ` +
                  `which is inconsistent with ${tyToString(assignable)}`,
                  [...path, `args[${i}]`]);
              }
            } else {
              this.expect(assignable, actual, [...path, `args[${i}]`],
                `argument ${i} of ${this.show(term.callee)}`);
            }
          }
        });
        this.checkSeparation(sig, term.args, path);
        // Authority flows downwards only: a callee may not need more than its caller has.
        for (const cap of sig.capabilities) {
          if (!env.has(cap)) {
            this.error('capability_escalation',
              `${this.show(term.callee)} requires ${cap}, which the caller does not hold`,
              path,
              `Add ${cap} to the calling function's capability list, and to every caller above it.`);
          }
          this.used.add(cap);
        }
        return substituteType(sig.returns, substitutions);
      }
      case 'Invoke': {
        const descriptor = this.opts.registry.get(term.capability);
        if (!descriptor) {
          this.error('unknown_capability', `${term.capability} is not a registered capability`, path);
        } else if (descriptor.arity !== term.args.length) {
          this.error('arity_mismatch',
            `${term.capability} takes ${descriptor.arity} arguments, got ${term.args.length}`, path);
        }
        if (!env.has(term.capability)) {
          this.error('capability_not_granted',
            `this function may not invoke ${term.capability}`,
            path,
            'Capabilities are not ambient. Declare it on the function and pass it from every caller.');
        }
        this.used.add(term.capability);
        term.args.forEach((arg, i) => this.typeOf(arg, scope, env, [...path, `args[${i}]`], ctx));
        return { t: 'Unit' };
      }
      default:
        this.checkTerm(term, scope, env, path, ctx);
        return { t: 'Unit' };
    }
  }

  /** The declared return type of the function whose contract is being checked. */
  private resultType: Ty | null = null;

  private checkSeparation(sig: FnSignature, args: readonly Term[], path: readonly string[]): void {
    const root = (term: Term): SymbolId | null =>
      term.kind === 'Var' || term.kind === 'Place' ? term.symbol
        : term.kind === 'Field' ? root(term.object) : null;
    for (let i = 0; i < sig.params.length; i++) {
      if (sig.params[i].ty.t !== 'Owned') continue;
      const ownedRoot = args[i] ? root(args[i]) : null;
      if (!ownedRoot) continue;
      for (let j = 0; j < args.length; j++) {
        if (i !== j && root(args[j]) === ownedRoot) {
          this.error(
            'separation_violation',
            `argument ${i} transfers ownership but aliases argument ${j}`,
            [...path, `args[${i}]`],
          );
        }
      }
    }
  }

  private fieldType(owner: Ty, field: string, path: readonly string[]): Ty {
    const base = underlying(owner);
    if (base.t !== 'Record') {
      this.error('not_a_record', `${tyToString(owner)} has no fields`, path);
      return { t: 'Unit' };
    }
    const hit = base.fields.find(([n]) => n === field);
    if (!hit) {
      this.error('unknown_field', `${tyToString(owner)} has no field ${field}`, path,
        `Known fields: ${base.fields.map(([n]) => n).join(', ')}`);
      return { t: 'Unit' };
    }
    return hit[1];
  }

  private binType(
    term: Extract<Term, { kind: 'Bin' }>,
    scope: Scope,
    env: CapabilityEnvelope,
    path: readonly string[],
    ctx: ClauseContext,
  ): Ty {
    const left = this.typeOf(term.left, scope, env, [...path, 'left'], ctx);
    const right = this.typeOf(term.right, scope, env, [...path, 'right'], ctx);
    switch (term.op) {
      case 'and': case 'or':
        this.expect({ t: 'Bool' }, left, [...path, 'left'], `operand of ${term.op}`);
        this.expect({ t: 'Bool' }, right, [...path, 'right'], `operand of ${term.op}`);
        return { t: 'Bool' };
      case 'concat':
        this.expect({ t: 'Str' }, underlying(left), [...path, 'left'], 'operand of ++');
        this.expect({ t: 'Str' }, underlying(right), [...path, 'right'], 'operand of ++');
        return left;
      case 'eq': case 'ne':
        this.expect(left, right, [...path, 'right'], `operands of ${term.op}`);
        return { t: 'Bool' };
      case 'lt': case 'le': case 'gt': case 'ge':
        this.expect(left, right, [...path, 'right'], `operands of ${term.op}`);
        this.expect({ t: 'Int' }, underlying(left), [...path, 'left'], `operands of ${term.op}`);
        return { t: 'Bool' };
      case 'add': case 'sub': {
        // Nominal money types stay nominal through arithmetic and do not mix:
        // adding Cents to a bare Int is the bug this type system exists to catch.
        this.expect(left, right, [...path, 'right'], `operands of ${term.op}`);
        this.expect({ t: 'Int' }, underlying(left), [...path, 'left'], `operands of ${term.op}`);
        return left;
      }
      case 'mul': case 'div': case 'mod': {
        // Scaling is dimensionally sound: Cents * 3 is Cents, and Cents / Cents
        // is a dimensionless ratio. Cents * Cents is not a quantity at all.
        this.expect({ t: 'Int' }, underlying(left), [...path, 'left'], `operands of ${term.op}`);
        this.expect({ t: 'Int' }, underlying(right), [...path, 'right'], `operands of ${term.op}`);
        const leftScalar = left.t !== 'Nominal';
        const rightScalar = right.t !== 'Nominal';
        if (leftScalar && rightScalar) return { t: 'Int' };
        if (rightScalar) return left;
        if (leftScalar) {
          if (term.op === 'mul') return right;
          this.error('type_mismatch',
            `cannot ${term.op} a scalar by ${tyToString(right)}`,
            [...path, 'right'],
            'Only multiplication is commutative across a dimensioned type.');
          return right;
        }
        if (tyEqual(left, right)) {
          if (term.op === 'div') return { t: 'Int' }; // a ratio is dimensionless
          if (term.op === 'mod') return left;
        }
        this.error('type_mismatch',
          `${tyToString(left)} ${term.op} ${tyToString(right)} is not a quantity`,
          path,
          'Multiply or divide a dimensioned value by a scalar, not by another dimensioned value.');
        return left;
      }
    }
  }

}

/** Type- and capability-check a term. */
export function typecheck(term: Term, opts: CheckOptions): CheckResult {
  return new TypeChecker(opts).check(term);
}

export { linkGroups };
