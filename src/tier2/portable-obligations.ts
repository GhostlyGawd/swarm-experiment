/** Independent AST -> scalar Hoare obligations for portable certificates.
 * This module deliberately imports no verifier, solver, evidence-report or
 * proof-producer implementation. Every returned formula must be universally
 * valid. A consumer must reject a bundle if ANY unsupported item is present.
 *
 * The statement is safety and total return of pure Int/Bool functions under
 * formal entry preconditions in aether-reference/1. Specification text is an
 * exact identity binding; its natural-language meaning is not parsed/proved.
 * Caller entry preconditions remain runtime admission obligations. Compiler
 * correctness, resource exhaustion and host scheduling are outside this model.
 */
import { types as nodeTypes } from 'node:util';
import { children, LINK_SCHEMA, type Term, type Ty } from '../tier1/ast.ts';
import { GraphStore } from '../tier1/store.ts';
import { isNodeRef, type SymbolId } from '../tier1/ids.ts';
import { encodeCanonical, exactObject, identifier, validString } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import * as smt from './smt.ts';
import type { SmtFormula, SmtTerm } from './smt.ts';

export interface PortableDerivationLimits {
  readonly maxAstNodes: number;
  readonly maxDepth: number;
  readonly maxDeclarations: number;
  readonly maxPaths: number;
  readonly maxObligations: number;
  readonly maxFormulaNodes: number;
  readonly maxIntegerDigits: number;
  readonly maxBytes: number;
}
export const DEFAULT_PORTABLE_DERIVATION_LIMITS: Readonly<PortableDerivationLimits> = Object.freeze({ maxAstNodes: 10_000, maxDepth: 64, maxDeclarations: 128, maxPaths: 256, maxObligations: 4096, maxFormulaNodes: 20_000, maxIntegerDigits: 256, maxBytes: 4 * 1024 * 1024 });
const semanticProfile = { format: 'aether.portable-derivation/1', semantics: 'aether-reference/1', fragment: 'pure-int-bool-acyclic-calls-inductive-while', specification: 'opaque-text-identity-plus-formal-AST-contracts', totality: 'return-and-loop-ranking', frame: 'empty-heap-and-effects', arithmetic: 'unbounded-integer-linear' };
export const PORTABLE_DERIVATION_PROFILE_DIGEST = domainDigest('aether.portable-derivation-profile/1', { ...semanticProfile, limits: DEFAULT_PORTABLE_DERIVATION_LIMITS });
export interface ResolvedPortableDependency { readonly symbol: SymbolId; readonly declaration: Term }
export interface PortableDerivationOptions {
  readonly manifest: ExecutionManifestV1;
  readonly expectedManifest: ExecutionManifestV1;
  readonly specification: string;
  readonly dependencies?: readonly ResolvedPortableDependency[];
  /** May tighten the fixed reference profile, never raise its resource limits. */
  readonly limits?: Partial<PortableDerivationLimits>;
}
export interface PortableObligation { readonly id: Digest; readonly symbol: SymbolId; readonly kind: string; readonly formula: SmtFormula }
export interface PortableObligationSet {
  readonly format: 'aether.portable-obligations/1';
  readonly manifestDigest: Digest;
  readonly profileDigest: Digest;
  readonly obligations: readonly PortableObligation[];
  readonly unsupported: readonly { readonly symbol: SymbolId; readonly reason: string }[];
}
type Declaration = Extract<Term, { kind: 'FunctionDecl' }>;
type Scalar = { sort: 'Int'; value: SmtTerm } | { sort: 'Bool'; value: SmtFormula };
type Environment = Map<SymbolId, Scalar>;
interface Path { env: Environment; condition: SmtFormula; returned?: Scalar }
interface Eval { path: Path; value: Scalar }
interface ExpressionContext { old: Environment; result?: Scalar; mode: 'body' | 'requires' | 'ensures' | 'invariant' }
class Unsupported extends Error {}
const unsupported = (reason: string): never => { throw new Unsupported(reason); };
const int = (value: SmtTerm): Scalar => ({ sort: 'Int', value });
const bool = (value: SmtFormula): Scalar => ({ sort: 'Bool', value });
const asInt = (value: Scalar): SmtTerm => value.sort === 'Int' ? value.value : unsupported('expected Int expression');
const asBool = (value: Scalar): SmtFormula => value.sort === 'Bool' ? value.value : unsupported('expected Bool expression');
const fork = (path: Path, guard: SmtFormula = smt.T): Path => ({ env: new Map(path.env), condition: smt.and(path.condition, guard), ...(path.returned ? { returned: path.returned } : {}) });
const isType = (ty: Ty): 'Int' | 'Bool' => { if (!ty || (ty.t !== 'Int' && ty.t !== 'Bool')) return unsupported('unsupported scalar type'); exactObject(ty, ['t']); return ty.t; };
const sameSort = (left: Scalar, right: Scalar): void => { if (left.sort !== right.sort) unsupported('expression sort mismatch'); };
const compare = (left: Scalar, right: Scalar): SmtFormula => { sameSort(left, right); return left.sort === 'Bool' ? smt.iff(left.value, asBool(right)) : smt.eq(left.value, asInt(right)); };

/** Bounded detached copy before any recursive AST hashing; no getter, proxy
 * prototype, sparse array, cycle or unpaired Unicode enters the trusted graph. */
function copyInput<T>(input: T, limits: PortableDerivationLimits): T {
  let count = 0;
  const active = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++count > limits.maxAstNodes * 32 || depth > limits.maxDepth + 16) throw new RangeError('portable AST value limit');
    if (typeof value === 'bigint') { if (String(value).replace('-', '').length > limits.maxIntegerDigits) throw new RangeError('portable AST integer limit'); return value; }
    if (typeof value === 'string') { validString(value); if (value.length > limits.maxBytes) throw new RangeError('portable AST string limit'); return value; }
    if (value === null || typeof value === 'boolean' || value === undefined) return value;
    if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('invalid portable AST number'); return value; }
    if (!value || typeof value !== 'object' || active.has(value)) throw new TypeError('cyclic or opaque portable AST value');
    if (nodeTypes.isProxy(value)) throw new TypeError('proxy portable AST value');
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('sparse portable AST array');
        const result: unknown[] = [];
        for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !('value' in d)) throw new TypeError('portable AST accessor'); result.push(visit(d.value, depth + 1)); }
        return result;
      }
      const names = Object.keys(value); exactObject(value, names);
      const result: Record<string, unknown> = {};
      for (const name of names) {
        validString(name); if (name === '__proto__') throw new TypeError('reserved portable AST field');
        const item = (value as Record<string, unknown>)[name];
        if (item !== undefined) Object.defineProperty(result, name, { value: visit(item, depth + 1), enumerable: true });
      }
      return result;
    } finally { active.delete(value); }
  };
  const copied = visit(input, 0);
  encodeCanonical(wire(copied), { maxFrameBytes: limits.maxBytes, maxDecompressedBytes: limits.maxBytes, maxDepth: Math.min(256, limits.maxDepth * 2 + 32), maxObjects: limits.maxAstNodes * 64 });
  return copied as T;
}
function wire(value: unknown): unknown {
  if (typeof value === 'bigint') return { integer: String(value) };
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, wire(item)]));
  return value;
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
const nodeFields: Readonly<Record<string, readonly string[]>> = {
  Lit: ['kind', 'ty', 'value'], Var: ['kind', 'symbol'], Place: ['kind', 'symbol', 'path'],
  Bin: ['kind', 'op', 'left', 'right'], Un: ['kind', 'op', 'operand'], Cond: ['kind', 'cond', 'then', 'otherwise'],
  Call: ['kind', 'callee', 'args'], Old: ['kind', 'expr'], ResultRef: ['kind'],
  Let: ['kind', 'symbol', 'ty', 'init'], Assign: ['kind', 'target', 'value'], If: ['kind', 'cond', 'then', 'otherwise'],
  While: ['kind', 'cond', 'invariants', 'variant', 'body'], Return: ['kind', 'value'], Assert: ['kind', 'expr', 'label'],
  ExprStmt: ['kind', 'expr'], Block: ['kind', 'stmts'], Clause: ['kind', 'expr', 'label', 'rigor'],
  Contract: ['kind', 'requires', 'ensures', 'modifies'],
  FunctionDecl: ['kind', 'symbol', 'typeParams', 'params', 'returns', 'capabilities', 'purity', 'contract', 'body', 'surfaces', 'provenance'],
  Module: ['kind', 'symbol', 'members', 'symbolTable', 'provenance'], SymbolTable: ['kind', 'entries'], Import: ['kind', 'module', 'symbols'],
};
function validateShape(node: Term): void {
  const fields = nodeFields[node.kind];
  if (fields) exactObject(node, fields);
  for (const { field, arity } of LINK_SCHEMA[node.kind]) {
    const value = (node as unknown as Record<string, unknown>)[field];
    if (arity === 'many' || arity === 'pairs') { if (!Array.isArray(value)) throw new TypeError('malformed portable AST child group'); }
    if (arity === 'one' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new TypeError('malformed portable AST child');
    if (arity === 'opt' && value !== null && (!value || typeof value !== 'object' || Array.isArray(value))) throw new TypeError('malformed optional portable AST child');
  }
  switch (node.kind) {
    case 'FunctionDecl':
      identifier(node.symbol);
      for (const value of [node.params, node.typeParams, node.capabilities, node.surfaces]) if (!Array.isArray(value)) throw new TypeError('malformed portable declaration array');
      node.typeParams.forEach(identifier); node.capabilities.forEach(identifier);
      for (const param of node.params) { exactObject(param, ['symbol', 'ty']); identifier(param.symbol); }
      if (node.purity !== 'pure' && node.purity !== 'effectful') throw new TypeError('malformed declaration purity');
      if (node.provenance !== null) identifier(node.provenance);
      return;
    case 'Module': identifier(node.symbol); if (node.provenance !== null) identifier(node.provenance); return;
    case 'Var': case 'Let': identifier(node.symbol); return;
    case 'Place': identifier(node.symbol); if (!Array.isArray(node.path)) throw new TypeError('malformed scalar place path'); node.path.forEach(identifier); return;
    case 'Call': identifier(node.callee); return;
    case 'Clause': identifier(node.label); if (node.rigor !== 'formal' && node.rigor !== 'property') throw new TypeError('malformed clause rigor'); return;
    case 'Assert': identifier(node.label); return;
    case 'Import':
      if (!isNodeRef(node.module) || !Array.isArray(node.symbols)) throw new TypeError('malformed portable import'); node.symbols.forEach(identifier); return;
    case 'SymbolTable':
      if (!Array.isArray(node.entries)) throw new TypeError('malformed portable symbol table');
      for (const entry of node.entries) { if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('malformed portable symbol entry'); identifier(entry[0]); validString(entry[1]); } return;
    default: return;
  }
}
function walk(term: Term, limits: PortableDerivationLimits, callback: (node: Term) => void): void {
  let count = 0;
  const visit = (node: Term, depth: number): void => {
    if (++count > limits.maxAstNodes || depth > limits.maxDepth) throw new RangeError('portable AST traversal limit');
    if (!node || typeof node !== 'object' || !Object.hasOwn(LINK_SCHEMA, node.kind)) throw new TypeError('invalid portable AST node');
    validateShape(node); callback(node); for (const child of children(node)) visit(child, depth + 1);
  };
  visit(term, 0);
}
function calls(term: Term, limits: PortableDerivationLimits): SymbolId[] {
  const found = new Set<SymbolId>();
  walk(term, limits, node => { if (node.kind === 'Call' || node.kind === 'SeqMap' || node.kind === 'SeqFold') { identifier(node.callee); found.add(node.callee); } });
  return [...found].sort();
}
function assigned(term: Term, limits: PortableDerivationLimits): Set<SymbolId> {
  const found = new Set<SymbolId>();
  walk(term, limits, node => { if (node.kind === 'Assign' && node.target.kind === 'Place' && node.target.path.length === 0) found.add(node.target.symbol); });
  return found;
}

class FunctionDeriver {
  private serial = 0;
  private nodes = 0;
  readonly obligations: PortableObligation[] = [];
  private readonly limits: PortableDerivationLimits;
  private readonly functions: Map<SymbolId, Declaration>;
  private readonly decl: Declaration;
  private readonly manifest: Digest;
  private readonly profile: Digest;
  private readonly formulaBudget: { remaining: number };
  constructor(decl: Declaration, functions: Map<SymbolId, Declaration>, limits: PortableDerivationLimits, manifest: Digest, profile: Digest, formulaBudget: { remaining: number }) { this.decl = decl; this.functions = functions; this.limits = limits; this.manifest = manifest; this.profile = profile; this.formulaBudget = formulaBudget; }
  private tick(): void { if (++this.nodes > this.limits.maxAstNodes * this.limits.maxPaths) throw new RangeError('portable symbolic traversal limit'); }
  private boundPaths<T>(values: T[]): T[] { if (values.length > this.limits.maxPaths) throw new RangeError('portable path limit'); return values; }
  private fresh(sort: 'Int' | 'Bool', role: string): Scalar {
    const name = `v!${domainDigest('aether.portable-variable/1', { symbol: this.decl.symbol, index: this.serial++, role }).split(':').at(-1)}`;
    return sort === 'Int' ? int(smt.intVar(name)) : bool(smt.boolVar(name));
  }
  private emit(kind: string, condition: SmtFormula, goal: SmtFormula): void {
    if (this.obligations.length >= this.limits.maxObligations) throw new RangeError('portable obligation count limit');
    const formula = smt.implies(condition, goal);
    let count = 0;
    const visit = (value: unknown, depth: number): void => {
      if (++count > this.limits.maxFormulaNodes || --this.formulaBudget.remaining < 0 || depth > this.limits.maxDepth * 2) throw new RangeError('portable formula limit');
      if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1);
    };
    visit(formula, 0);
    const id = domainDigest('aether.portable-obligation/1', { manifest: this.manifest, profile: this.profile, symbol: this.decl.symbol, index: this.obligations.length, kind, formula: wire(formula) }, { maxFrameBytes: this.limits.maxBytes, maxDecompressedBytes: this.limits.maxBytes, maxDepth: 256, maxObjects: this.limits.maxFormulaNodes * 4 });
    this.obligations.push({ id, symbol: this.decl.symbol, kind, formula });
  }
  private contract(decl: Declaration): Extract<Term, { kind: 'Contract' }> | null {
    if (decl.contract === null) return null;
    if (decl.contract.kind !== 'Contract' || decl.contract.modifies.length) return unsupported('nonempty or unsupported contract frame');
    for (const clause of [...decl.contract.requires, ...decl.contract.ensures]) if (clause.kind !== 'Clause' || clause.rigor !== 'formal') unsupported('property or malformed contract clause');
    return decl.contract;
  }
  private checkDeclaration(decl: Declaration): void {
    if (decl.purity !== 'pure' || decl.capabilities.length || decl.typeParams.length || decl.surfaces.length) unsupported('effectful, generic or tunable declaration');
    if (!decl.body) unsupported('declaration has no executable body');
    isType(decl.returns); const names = new Set<SymbolId>();
    for (const param of decl.params) { identifier(param.symbol); isType(param.ty); if (names.has(param.symbol)) unsupported('duplicate parameter symbol'); names.add(param.symbol); }
    // Reject even unsupported syntax after an unconditional return. Such syntax
    // must not become accidentally admitted by a proof of a smaller program.
    const expressions = new Set(['Lit', 'Var', 'Place', 'Bin', 'Un', 'Cond', 'Call', 'Old', 'ResultRef']);
    const statements = new Set(['Let', 'Assign', 'If', 'While', 'Return', 'Assert', 'ExprStmt', 'Block']);
    walk(decl.body!, this.limits, node => {
      if (!expressions.has(node.kind) && !statements.has(node.kind)) unsupported(`unsupported body node ${node.kind}`);
      if (node.kind === 'Let') { identifier(node.symbol); isType(node.ty); if (names.has(node.symbol)) unsupported('shadowed or repeated local symbol'); names.add(node.symbol); }
      if (node.kind === 'Place' && node.path.length) unsupported('record or heap place');
      if (node.kind === 'Lit') { const sort = isType(node.ty); if ((sort === 'Int' && typeof node.value !== 'bigint') || (sort === 'Bool' && typeof node.value !== 'boolean')) unsupported('literal value/type mismatch'); }
      if (node.kind === 'Bin' && !['add', 'sub', 'mul', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or'].includes(node.op)) unsupported('unsupported arithmetic theory');
      if (node.kind === 'Un' && node.op !== 'not' && node.op !== 'neg') unsupported('unsupported unary operator');
      if (node.kind === 'While' && (!node.variant || !node.invariants.length)) unsupported('while requires formal invariants and an integer ranking function');
      if (node.kind === 'Old' || node.kind === 'ResultRef') unsupported('old/result outside a postcondition');
    });
    this.contract(decl);
    this.validateLexical(decl);
  }
  /** Independent lexical/type validation visits every statement, including
   * dead tails. Hoare path termination must never skip language admission. */
  private validateLexical(decl: Declaration): void {
    type Sort = 'Int' | 'Bool';
    type Scope = Map<SymbolId, Sort>;
    const initial: Scope = new Map(decl.params.map(param => [param.symbol, isType(param.ty)]));
    const constantSyntax = (term: Term): boolean => term.kind === 'Lit' && term.ty.t === 'Int' && typeof term.value === 'bigint'
      || term.kind === 'Un' && term.op === 'neg' && constantSyntax(term.operand)
      || term.kind === 'Bin' && ['add', 'sub', 'mul'].includes(term.op) && constantSyntax(term.left) && constantSyntax(term.right);
    const expect = (actual: Sort, wanted: Sort): Sort => { if (actual !== wanted) unsupported('scalar static sort mismatch'); return actual; };
    const expression = (term: Term, scope: Scope, mode: ExpressionContext['mode']): Sort => {
      this.tick();
      switch (term.kind) {
        case 'Lit': { const sort = isType(term.ty); if ((sort === 'Int' && typeof term.value !== 'bigint') || (sort === 'Bool' && typeof term.value !== 'boolean')) unsupported('literal static sort mismatch'); return sort; }
        case 'Var': case 'Place': {
          if (term.kind === 'Place' && term.path.length) return unsupported('static heap place');
          return scope.get(term.symbol) ?? unsupported('unbound scalar symbol in static preflight');
        }
        case 'Old': if (mode !== 'ensures') return unsupported('old outside static postcondition'); return expression(term.expr, initial, 'requires');
        case 'ResultRef': if (mode !== 'ensures') return unsupported('result outside static postcondition'); return isType(decl.returns);
        case 'Un': { const sort = expression(term.operand, scope, mode); if (term.op === 'not') return expect(sort, 'Bool'); if (term.op === 'neg') return expect(sort, 'Int'); return unsupported('unsupported static unary operator'); }
        case 'Bin': {
          const left = expression(term.left, scope, mode), right = expression(term.right, scope, mode);
          if (term.op === 'eq' || term.op === 'ne') { expect(right, left); return 'Bool'; }
          if (term.op === 'and' || term.op === 'or') { expect(left, 'Bool'); expect(right, 'Bool'); return 'Bool'; }
          expect(left, 'Int'); expect(right, 'Int');
          if (['lt', 'le', 'gt', 'ge'].includes(term.op)) return 'Bool';
          if (term.op === 'mul' && !constantSyntax(term.left) && !constantSyntax(term.right)) return unsupported('nonlinear or nonliteral-factor multiplication in static preflight');
          if (['add', 'sub', 'mul'].includes(term.op)) return 'Int';
          return unsupported('unsupported static binary operator');
        }
        case 'Cond': expect(expression(term.cond, scope, mode), 'Bool'); return expect(expression(term.then, scope, mode), expression(term.otherwise, scope, mode));
        case 'Call': {
          if (mode !== 'body') return unsupported('call in static logical annotation');
          const callee = this.functions.get(term.callee); if (!callee || term.args.length !== callee.params.length) return unsupported('unknown call or static arity mismatch');
          term.args.forEach((argument, index) => expect(expression(argument, scope, mode), isType(callee.params[index].ty)));
          return isType(callee.returns);
        }
        default: return unsupported(`unsupported static expression ${term.kind}`);
      }
    };
    const statement = (term: Term, scope: Scope): void => {
      this.tick();
      switch (term.kind) {
        case 'Block': { const inner = new Map(scope); term.stmts.forEach(child => statement(child, inner)); return; }
        case 'Let': { const sort = isType(term.ty); expect(expression(term.init, scope, 'body'), sort); if (scope.has(term.symbol)) unsupported('static local shadowing'); scope.set(term.symbol, sort); return; }
        case 'Assign': {
          if (term.target.kind !== 'Place' || term.target.path.length) unsupported('invalid static assignment target');
          expect(expression(term.value, scope, 'body'), expression(term.target, scope, 'body')); return;
        }
        case 'If': expect(expression(term.cond, scope, 'body'), 'Bool'); statement(term.then, new Map(scope)); if (term.otherwise) statement(term.otherwise, new Map(scope)); return;
        case 'While':
          expect(expression(term.cond, scope, 'invariant'), 'Bool');
          term.invariants.forEach(invariant => expect(expression(invariant, scope, 'invariant'), 'Bool'));
          if (!term.variant) unsupported('missing static loop ranking');
          expect(expression(term.variant!, scope, 'invariant'), 'Int'); statement(term.body, new Map(scope)); return;
        case 'Return': expect(expression(term.value, scope, 'body'), isType(decl.returns)); return;
        case 'Assert': expect(expression(term.expr, scope, 'body'), 'Bool'); return;
        case 'ExprStmt': expression(term.expr, scope, 'body'); return;
        default: unsupported(`unsupported static statement ${term.kind}`);
      }
    };
    const contract = this.contract(decl);
    for (const clause of contract?.requires ?? []) if (clause.kind === 'Clause') expect(expression(clause.expr, initial, 'requires'), 'Bool');
    for (const clause of contract?.ensures ?? []) if (clause.kind === 'Clause') expect(expression(clause.expr, initial, 'ensures'), 'Bool');
    statement(decl.body!, new Map(initial));
  }
  private binary(op: Extract<Term, { kind: 'Bin' }>['op'], left: Scalar, right: Scalar): Scalar {
    switch (op) {
      case 'eq': return bool(compare(left, right));
      case 'ne': return bool(smt.not(compare(left, right)));
      case 'and': return bool(smt.and(asBool(left), asBool(right)));
      case 'or': return bool(smt.or(asBool(left), asBool(right)));
      case 'lt': return bool(smt.lt(asInt(left), asInt(right)));
      case 'le': return bool(smt.le(asInt(left), asInt(right)));
      case 'gt': return bool(smt.gt(asInt(left), asInt(right)));
      case 'ge': return bool(smt.ge(asInt(left), asInt(right)));
      case 'add': return int(smt.add(asInt(left), asInt(right)));
      case 'sub': return int(smt.sub(asInt(left), asInt(right)));
      case 'mul': {
        const constant = (term: SmtTerm): bigint | null => {
          let value: bigint | null = null;
          if (term.k === 'int') value = term.v;
          else if (term.k === 'neg') { const child = constant(term.arg); if (child !== null) value = -child; }
          else if (term.k === 'sub') { const a = constant(term.left), b = constant(term.right); if (a !== null && b !== null) value = a - b; }
          else if (term.k === 'add' || term.k === 'mul') {
            const values = term.args.map(constant); if (values.every((item): item is bigint => item !== null)) value = values.reduce((a, b) => term.k === 'add' ? a + b : a * b, term.k === 'add' ? 0n : 1n);
          }
          if (value !== null && String(value).replace('-', '').length > this.limits.maxIntegerDigits) throw new RangeError('constant arithmetic digit limit');
          return value;
        };
        const a = asInt(left), b = asInt(right), constantA = constant(a), constantB = constant(b);
        if (constantA === null && constantB === null) return unsupported('nonlinear integer multiplication');
        return int(smt.mul(constantA === null ? a : smt.num(constantA), constantB === null ? b : smt.num(constantB)));
      }
      default: return unsupported('unsupported binary operator');
    }
  }
  /** Contracts/invariants have no calls or partial operators, so they have no
   * evaluation side conditions and can be translated without path splitting. */
  private logical(term: Term, env: Environment, context: ExpressionContext): Scalar {
    this.tick();
    switch (term.kind) {
      case 'Lit': { const sort = isType(term.ty); if (sort === 'Int' && typeof term.value === 'bigint') return int(smt.num(term.value)); if (sort === 'Bool' && typeof term.value === 'boolean') return bool(term.value ? smt.T : smt.F); return unsupported('literal value/type mismatch'); }
      case 'Var': case 'Place': { if (term.kind === 'Place' && term.path.length) return unsupported('heap place in scalar contract'); const value = env.get(term.symbol); return value ?? unsupported('unbound scalar symbol'); }
      case 'Old': if (context.mode !== 'ensures') return unsupported('old outside postcondition'); return this.logical(term.expr, context.old, { ...context, mode: 'requires', result: undefined });
      case 'ResultRef': if (context.mode !== 'ensures' || !context.result) return unsupported('result outside postcondition'); return context.result;
      case 'Un': { const value = this.logical(term.operand, env, context); if (term.op === 'not') return bool(smt.not(asBool(value))); if (term.op === 'neg') return int(smt.neg(asInt(value))); return unsupported('unknown unary operator'); }
      case 'Bin': return this.binary(term.op, this.logical(term.left, env, context), this.logical(term.right, env, context));
      case 'Cond': {
        const cond = asBool(this.logical(term.cond, env, context)), yes = this.logical(term.then, env, context), no = this.logical(term.otherwise, env, context); sameSort(yes, no);
        return yes.sort === 'Int' ? int(smt.ite(cond, yes.value, asInt(no))) : bool(smt.or(smt.and(cond, yes.value), smt.and(smt.not(cond), asBool(no))));
      }
      default: return unsupported(`unsupported logical node ${term.kind}`);
    }
  }
  private clauses(clauses: readonly Term[], env: Environment, context: ExpressionContext): SmtFormula[] {
    return clauses.map(clause => { if (clause.kind !== 'Clause' || clause.rigor !== 'formal') return unsupported('property clause cannot be assumed'); return asBool(this.logical(clause.expr, env, context)); });
  }
  private evaluate(term: Term, path: Path, context: ExpressionContext): Eval[] {
    this.tick();
    switch (term.kind) {
      case 'Lit': case 'Var': case 'Place': case 'Old': case 'ResultRef': return [{ path, value: this.logical(term, path.env, context) }];
      case 'Un': return this.evaluate(term.operand, path, context).map(item => ({ path: item.path, value: term.op === 'not' ? bool(smt.not(asBool(item.value))) : term.op === 'neg' ? int(smt.neg(asInt(item.value))) : unsupported('unknown unary operator') }));
      case 'Bin': {
        const out: Eval[] = [];
        for (const left of this.evaluate(term.left, path, context)) {
          if (term.op === 'and' || term.op === 'or') {
            const condition = asBool(left.value), evaluateRight = term.op === 'and' ? condition : smt.not(condition);
            out.push({ path: fork(left.path, smt.not(evaluateRight)), value: bool(term.op === 'and' ? smt.F : smt.T) });
            for (const right of this.evaluate(term.right, fork(left.path, evaluateRight), context)) out.push({ path: right.path, value: bool(asBool(right.value)) });
          } else for (const right of this.evaluate(term.right, left.path, context)) out.push({ path: right.path, value: this.binary(term.op, left.value, right.value) });
        }
        return this.boundPaths(out);
      }
      case 'Cond': {
        const out: Eval[] = [];
        for (const item of this.evaluate(term.cond, path, context)) {
          const condition = asBool(item.value);
          out.push(...this.evaluate(term.then, fork(item.path, condition), context), ...this.evaluate(term.otherwise, fork(item.path, smt.not(condition)), context));
        }
        if (out.some(item => item.value.sort !== out[0]?.value.sort)) unsupported('conditional result sort mismatch');
        return this.boundPaths(out);
      }
      case 'Call': {
        if (context.mode !== 'body') return unsupported('calls in logical annotations');
        const callee = this.functions.get(term.callee); if (!callee) return unsupported('unresolved scalar call');
        this.checkDeclaration(callee);
        if (callee.params.length !== term.args.length) return unsupported('call arity mismatch');
        let arguments_: { path: Path; values: Scalar[] }[] = [{ path, values: [] }];
        for (const argument of term.args) {
          const next: typeof arguments_ = [];
          for (const item of arguments_) for (const value of this.evaluate(argument, item.path, context)) next.push({ path: value.path, values: [...item.values, value.value] });
          arguments_ = this.boundPaths(next);
        }
        const out: Eval[] = [];
        for (const item of arguments_) {
          const before: Environment = new Map();
          callee.params.forEach((param, index) => { if (isType(param.ty) !== item.values[index].sort) unsupported('call argument sort mismatch'); before.set(param.symbol, item.values[index]); });
          const contract = this.contract(callee);
          for (const precondition of this.clauses(contract?.requires ?? [], before, { old: before, mode: 'requires' })) this.emit('call-precondition', item.path.condition, precondition);
          // Scalar arguments are by value. Rebinding a callee parameter is not
          // visible in the caller; plain post-state parameter references must
          // therefore be fresh, while old(parameter) retains the actual input.
          const after = new Map(before), writes = assigned(callee.body!, this.limits);
          for (const param of callee.params) if (writes.has(param.symbol)) after.set(param.symbol, this.fresh(isType(param.ty), `call-post-parameter:${param.symbol}`));
          const result = this.fresh(isType(callee.returns), `call-result:${callee.symbol}`);
          const postconditions = this.clauses(contract?.ensures ?? [], after, { old: before, result, mode: 'ensures' });
          out.push({ path: fork(item.path, smt.and(...postconditions)), value: result });
        }
        return this.boundPaths(out);
      }
      default: return unsupported(`unsupported scalar expression ${term.kind}`);
    }
  }
  private statement(term: Term, path: Path, context: ExpressionContext): Path[] {
    this.tick(); if (path.returned) return [path];
    switch (term.kind) {
      case 'Block': {
        const outer = new Set(path.env.keys()); let paths = [path];
        for (const stmt of term.stmts) { const next: Path[] = []; for (const item of paths) next.push(...this.statement(stmt, item, context)); paths = this.boundPaths(next); }
        for (const item of paths) for (const symbol of item.env.keys()) if (!outer.has(symbol)) item.env.delete(symbol);
        return paths;
      }
      case 'Let': return this.evaluate(term.init, path, context).map(item => { if (item.path.env.has(term.symbol) || isType(term.ty) !== item.value.sort) return unsupported('invalid local binding'); const next = fork(item.path); next.env.set(term.symbol, item.value); return next; });
      case 'Assign': {
        if (term.target.kind !== 'Place' || term.target.path.length) return unsupported('assignment outside scalar local frame');
        const symbol = term.target.symbol, previous = path.env.get(symbol); if (!previous) return unsupported('assignment to unbound local');
        return this.evaluate(term.value, path, context).map(item => { sameSort(previous, item.value); const next = fork(item.path); next.env.set(symbol, item.value); return next; });
      }
      case 'If': {
        const out: Path[] = [];
        for (const item of this.evaluate(term.cond, path, context)) {
          const condition = asBool(item.value);
          out.push(...this.statement(term.then, fork(item.path, condition), context));
          const no = fork(item.path, smt.not(condition)); out.push(...(term.otherwise ? this.statement(term.otherwise, no, context) : [no]));
        }
        return this.boundPaths(out);
      }
      case 'Return': return this.evaluate(term.value, path, context).map(item => {
        if (item.value.sort !== isType(this.decl.returns)) return unsupported('return sort mismatch');
        const post = this.clauses(this.contract(this.decl)?.ensures ?? [], item.path.env, { ...context, result: item.value, mode: 'ensures' });
        post.forEach(condition => this.emit('postcondition', item.path.condition, condition));
        this.emit('return', item.path.condition, smt.T);
        return { ...fork(item.path), returned: item.value };
      });
      case 'Assert': return this.evaluate(term.expr, path, context).map(item => { const condition = asBool(item.value); this.emit('assertion', item.path.condition, condition); return fork(item.path, condition); });
      case 'ExprStmt': return this.evaluate(term.expr, path, context).map(item => item.path);
      case 'While': {
        if (!term.variant || !term.invariants.length) return unsupported('while requires formal invariants and an integer ranking function');
        const logicalContext: ExpressionContext = { ...context, mode: 'invariant' };
        const invariants = (env: Environment): SmtFormula[] => term.invariants.map(invariant => asBool(this.logical(invariant, env, logicalContext)));
        const before = invariants(path.env); before.forEach(invariant => this.emit('loop-invariant-init', path.condition, invariant));
        const arbitrary = fork(path), writes = assigned(term.body, this.limits);
        for (const symbol of writes) { const value = arbitrary.env.get(symbol); if (value) arbitrary.env.set(symbol, this.fresh(value.sort, `loop-state:${symbol}`)); }
        arbitrary.condition = smt.and(arbitrary.condition, ...invariants(arbitrary.env));
        const condition = asBool(this.logical(term.cond, arbitrary.env, logicalContext));
        const rankBefore = asInt(this.logical(term.variant, arbitrary.env, logicalContext));
        const iteration = fork(arbitrary, condition);
        this.emit('loop-variant-nonnegative', iteration.condition, smt.ge(rankBefore, smt.num(0)));
        const outcomes = this.statement(term.body, iteration, context);
        const returned: Path[] = [];
        for (const outcome of outcomes) {
          if (outcome.returned) { returned.push(outcome); continue; }
          invariants(outcome.env).forEach(invariant => this.emit('loop-invariant-preservation', outcome.condition, invariant));
          const rankAfter = asInt(this.logical(term.variant, outcome.env, logicalContext));
          this.emit('loop-variant-decrease', outcome.condition, smt.lt(rankAfter, rankBefore));
        }
        // Exhaustive terminating alternatives: return during an iteration or
        // exit at an arbitrary invariant state. No loop unrolling is trusted.
        return this.boundPaths([...returned, fork(arbitrary, smt.not(condition))]);
      }
      default: return unsupported(`unsupported scalar statement ${term.kind}`);
    }
  }
  derive(): readonly PortableObligation[] {
    this.checkDeclaration(this.decl);
    const env: Environment = new Map();
    this.decl.params.forEach(param => env.set(param.symbol, this.fresh(isType(param.ty), `entry:${param.symbol}`)));
    const context: ExpressionContext = { old: new Map(env), mode: 'body' };
    const preconditions = this.clauses(this.contract(this.decl)?.requires ?? [], env, { ...context, mode: 'requires' });
    // Pre-translate all postconditions for annotation/type validation, even if
    // there is no reachable return or the only return is nested in a loop.
    this.clauses(this.contract(this.decl)?.ensures ?? [], env, { ...context, mode: 'ensures', result: this.fresh(isType(this.decl.returns), 'validation-result') });
    const paths = this.statement(this.decl.body!, { env, condition: smt.and(...preconditions) }, context);
    for (const path of paths) if (!path.returned) this.emit('missing-return', path.condition, smt.F);
    this.emit('pure-scalar-frame', smt.T, smt.T);
    return this.obligations;
  }
}

export function derivePortableObligations(inputModule: Term, options: PortableDerivationOptions): PortableObligationSet {
  const limits = { ...DEFAULT_PORTABLE_DERIVATION_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) if (!(name in DEFAULT_PORTABLE_DERIVATION_LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_PORTABLE_DERIVATION_LIMITS[name as keyof PortableDerivationLimits]) throw new RangeError('portable derivation limits may only tighten');
  const manifestDigest = executionManifestDigest(options.manifest);
  if (manifestDigest !== executionManifestDigest(options.expectedManifest)) throw new TypeError('portable trusted execution manifest mismatch');
  if (options.manifest.semanticsVersion !== semanticProfile.semantics) throw new TypeError('unsupported portable language semantics');
  validString(options.specification);
  if (options.manifest.specRoot !== domainDigest('aether.specification/1', options.specification, { maxFrameBytes: limits.maxBytes, maxDecompressedBytes: limits.maxBytes })) throw new TypeError('portable specification root mismatch');
  const module = copyInput(inputModule, limits); let totalAstNodes = 0;
  walk(module, limits, () => { totalAstNodes++; });
  if (module.kind !== 'Module' || module.symbolTable.kind !== 'SymbolTable') throw new TypeError('portable proof requires a complete module');
  identifier(module.symbol);
  const store = new GraphStore();
  if (store.intern(module) !== options.manifest.astRoot) throw new TypeError('portable AST root mismatch');
  const functions = new Map<SymbolId, Declaration>(), initial: Declaration[] = [], provided = new Map<SymbolId, Declaration>();
  const unsupportedItems: { symbol: SymbolId; reason: string }[] = [];
  for (const member of module.members) {
    if (member.kind === 'FunctionDecl') { identifier(member.symbol); if (functions.has(member.symbol)) throw new TypeError('duplicate portable declaration'); functions.set(member.symbol, member); initial.push(member); }
    else if (member.kind !== 'Import') unsupportedItems.push({ symbol: module.symbol, reason: `unsupported module member ${member.kind}` });
  }
  if (!initial.length || initial.length > limits.maxDeclarations) throw new RangeError('empty or oversized portable module');
  if ((options.dependencies?.length ?? 0) > limits.maxDeclarations) throw new RangeError('portable dependency count limit');
  for (const item of options.dependencies ?? []) {
    exactObject(item, ['symbol', 'declaration']); identifier(item.symbol);
    const declaration = copyInput(item.declaration, limits); walk(declaration, limits, () => { if (++totalAstNodes > limits.maxAstNodes) throw new RangeError('portable total AST limit'); });
    if (declaration.kind !== 'FunctionDecl' || declaration.symbol !== item.symbol || provided.has(item.symbol) || functions.has(item.symbol)) throw new TypeError('invalid or duplicate portable dependency');
    provided.set(item.symbol, declaration);
  }
  const closure = new Map<SymbolId, Digest>();
  const pending = initial.flatMap(decl => calls(decl, limits));
  while (pending.length) {
    const symbol = pending.pop()!; if (closure.has(symbol)) continue;
    const declaration = functions.get(symbol) ?? provided.get(symbol);
    if (!declaration) throw new TypeError('unresolved portable dependency');
    functions.set(symbol, declaration); closure.set(symbol, store.intern(declaration));
    if (functions.size > limits.maxDeclarations) throw new RangeError('portable dependency closure limit');
    pending.push(...calls(declaration, limits));
  }
  if ([...provided.keys()].some(symbol => !closure.has(symbol))) throw new TypeError('unreferenced portable dependency');
  const actualDependencies = [...closure].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([symbol, declaration]) => ({ symbol, declaration }));
  if (!Buffer.from(encodeCanonical(actualDependencies)).equals(Buffer.from(encodeCanonical(options.manifest.dependencies)))) throw new TypeError('incomplete or changed portable dependency closure');
  const profileDigest = domainDigest('aether.portable-derivation-profile/1', { ...semanticProfile, limits });
  const active = new Set<SymbolId>(), visited = new Set<SymbolId>();
  const acyclic = (symbol: SymbolId): void => {
    if (active.has(symbol)) throw new Unsupported('recursive call graph requires an unsupported induction rule');
    if (visited.has(symbol)) return;
    active.add(symbol); for (const target of calls(functions.get(symbol)!, limits)) acyclic(target); active.delete(symbol); visited.add(symbol);
  };
  try { for (const symbol of functions.keys()) acyclic(symbol); }
  catch (error) { if (!(error instanceof Unsupported)) throw error; unsupportedItems.push({ symbol: module.symbol, reason: error.message }); }
  const obligations: PortableObligation[] = [];
  const formulaBudget = { remaining: limits.maxFormulaNodes };
  for (const [symbol, declaration] of [...functions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    try { obligations.push(...new FunctionDeriver(declaration, functions, limits, manifestDigest, profileDigest, formulaBudget).derive()); }
    catch (error) { if (!(error instanceof Unsupported)) throw error; unsupportedItems.push({ symbol, reason: error.message }); }
    if (obligations.length > limits.maxObligations) throw new RangeError('portable complete obligation count limit');
  }
  const result: PortableObligationSet = { format: 'aether.portable-obligations/1', manifestDigest, profileDigest, obligations, unsupported: unsupportedItems };
  encodeCanonical(wire(result), { maxFrameBytes: limits.maxBytes, maxDecompressedBytes: limits.maxBytes, maxDepth: 256, maxObjects: limits.maxFormulaNodes * 4 });
  return freeze(result);
}
