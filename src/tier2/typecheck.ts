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
  | 'frame_violation';

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
  }
}

/** Strip nominal wrappers to reach the underlying representation. */
export const underlying = (t: Ty): Ty => (t.t === 'Nominal' ? underlying(t.repr) : t);

interface FnSignature {
  readonly symbol: SymbolId;
  readonly params: readonly Param[];
  readonly returns: Ty;
  readonly capabilities: readonly CapabilityName[];
  readonly purity: 'pure' | 'effectful';
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
        } finally {
          this.resultType = outerResult;
        }
        if (term.body) {
          this.checkTerm(term.body, inner, fnEnv, [...path, 'body'], 'body');
          if (!tyEqual(term.returns, { t: 'Unit' }) && !this.alwaysReturns(term.body)) {
            this.error('missing_return',
              `${this.show(term.symbol)} returns ${tyToString(term.returns)} but a path falls off the end`,
              [...path, 'body']);
          }
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
      case 'Return':
        this.typeOf(term.value, scope, env, [...path, 'value'], ctx);
        return;
      case 'Assert':
        this.expect({ t: 'Bool' }, this.typeOf(term.expr, scope, env, [...path, 'expr'], ctx),
          [...path, 'expr'], `assertion "${term.label}"`);
        return;
      case 'ExprStmt':
        this.typeOf(term.expr, scope, env, [...path, 'expr'], ctx);
        return;
      case 'TypeDecl':
      case 'Surface':
      case 'SymbolTable':
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
        term.args.forEach((arg, i) => {
          const actual = this.typeOf(arg, scope, env, [...path, `args[${i}]`], ctx);
          if (sig.params[i]) this.expect(sig.params[i].ty, actual, [...path, `args[${i}]`],
            `argument ${i} of ${this.show(term.callee)}`);
        });
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
        return sig.returns;
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
