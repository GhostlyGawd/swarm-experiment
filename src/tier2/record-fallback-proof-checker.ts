/** A bounded, source-level proof profile for the native one-field record fallback.
 * The entry domain is the validated snapshot projection, not all Aether Ints.
 * This checker derives its own obligations from the full executed AST. It does
 * not trust a producer's formula, an SMT answer, or finite test observations.
 * Native compiler correctness and ProcessHost admission remain separate gates.
 */
import type { Term } from '../tier1/ast.ts';
import type { SymbolId } from '../tier1/ids.ts';
import { decode as decodeIR, encode as encodeIR } from '../tier1/agent-ir.ts';
import { GraphStore } from '../tier1/store.ts';
import { CapabilityRegistry } from './ocap.ts';
import { typecheck } from './typecheck.ts';
import { encodeCanonical, exactObject } from '../fabric/encoding.ts';
import { decodeExecutionManifest, encodeExecutionManifest, domainDigest, executionManifestDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import * as smt from './smt.ts';
import type { SmtFormula, SmtTerm } from './smt.ts';
import { checkFormulaCertificate, FORMULA_PROFILE_DIGEST, type FormulaCertificateV1 } from './portable-formula-checker.ts';
import { formulaCasesDigest, formulaCounterexampleCases } from './portable-formula.ts';

export const RECORD_FALLBACK_PROFILE = Object.freeze({
  format: 'aether.record-fallback-derivation/1',
  semantics: Object.freeze(['reference/1', 'aether-reference/1']),
  field: 'value', type: 'Int', frameCapacity: 4, admittedNextIds: Object.freeze([2, 3]),
  inputMin: '-1000000', inputMax: '1000100',
  integerMin: '-9223372036854775808', integerMax: '9223372036854775807',
  maxStatements: 16, maxExpressionNodes: 128, maxExpressionDepth: 24,
  allocation: 'one-fresh-record', abort: 'failed-postcondition-restores-entry-frame',
});
export const RECORD_FALLBACK_PROFILE_DIGEST = domainDigest('aether.record-fallback-derivation-profile/1', RECORD_FALLBACK_PROFILE);
const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
const ENTRY_MIN = -1_000_000n, ENTRY_MAX = 1_000_100n;
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
const L = freezeTree(smt.intVar('entry.left.value')), R = freezeTree(smt.intVar('entry.right.value'));
type Function = Extract<Term, { kind: 'FunctionDecl' }>;
type RecordTy = Extract<Function['params'][number]['ty'], { t: 'Record' }>;
type Value = { readonly kind: 'int'; readonly term: SmtTerm } | { readonly kind: 'bool'; readonly formula: SmtFormula };
type Branch = { readonly alias: boolean; left: SmtTerm; right: SmtTerm; local: SmtTerm | null; result: SmtTerm | null; allocations: number; overflow: SmtTerm[] };
export interface RecordFallbackContext { readonly module: Term; readonly manifest: ExecutionManifestV1; readonly tier2: SymbolId }
export interface RecordFallbackObligation { readonly kind: string; readonly formula: SmtFormula }
export interface RecordFallbackDerivation {
  readonly manifestDigest: Digest; readonly astRoot: Digest; readonly declarationRoot: Digest;
  readonly obligationSetDigest: Digest; readonly obligations: readonly RecordFallbackObligation[];
}
export interface RecordFallbackCertificateV1 {
  readonly format: 'aether.record-fallback-proof/1'; readonly manifest: ExecutionManifestV1;
  readonly tier2: SymbolId; readonly declarationRoot: Digest; readonly profileDigest: Digest;
  readonly obligationSetDigest: Digest;
  readonly certificates: readonly { readonly kind: string; readonly proof: FormulaCertificateV1 }[];
}
export interface CheckedRecordFallbackProof {
  readonly format: 'aether.checked-record-fallback-proof/1'; readonly manifestDigest: Digest;
  readonly astRoot: Digest; readonly tier2: SymbolId; readonly declarationRoot: Digest;
  readonly obligationSetDigest: Digest; readonly certificateDigest: Digest;
  readonly domain: typeof RECORD_FALLBACK_PROFILE;
}
const checked = new WeakMap<object, Digest>();
const int = (value: Value): SmtTerm => value.kind === 'int' ? value.term : fail('expected integer expression');
const bool = (value: Value): SmtFormula => value.kind === 'bool' ? value.formula : fail('expected Boolean expression');
const fail = (reason: string): never => { throw new TypeError('unsupported record fallback proof: ' + reason); };
const same = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b)));
const bounds = (term: SmtTerm, min: bigint, max: bigint): SmtFormula => smt.and(smt.ge(term, smt.num(min)), smt.le(term, smt.num(max)));
const entryDomain = freezeTree(smt.and(bounds(L, ENTRY_MIN, ENTRY_MAX), bounds(R, ENTRY_MIN, ENTRY_MAX)));
const recordType = (type: Function['params'][number]['ty']): type is RecordTy => type.t === 'Record' && type.fields.length === 1 && type.fields[0][0] === 'value' && type.fields[0][1].t === 'Int';

/** Independently derive the two alias cases, all arithmetic range checks,
 * total return, frame preservation and exact postcondition classification. */
export function deriveRecordFallbackObligations(context: RecordFallbackContext): RecordFallbackDerivation {
  // Agent IR detaches and validates the complete tree before hashing or walking.
  const module = decodeIR(encodeIR(context.module).text);
  const manifest = decodeExecutionManifest(encodeExecutionManifest(context.manifest));
  if (module.kind !== 'Module') return fail('module');
  if (module.members.length !== 2 || module.members.some(node => node.kind !== 'FunctionDecl')
    || manifest.dependencies.length || !RECORD_FALLBACK_PROFILE.semantics.includes(manifest.semanticsVersion)) return fail('module or semantics');
  const astRoot = new GraphStore().intern(module);
  if (astRoot !== manifest.astRoot || !typecheck(module, { registry: new CapabilityRegistry() }).ok) fail('AST root or typecheck');
  const matches = module.members.filter((node): node is Function => node.kind === 'FunctionDecl' && node.symbol === context.tier2);
  if (matches.length !== 1) return fail('selected Tier 2 declaration');
  const fn = matches[0];
  if (fn.purity !== 'pure' || fn.capabilities.length || fn.typeParams.length || fn.surfaces.length || fn.params.length !== 2
    || !recordType(fn.params[0].ty) || !same(fn.params[0].ty, fn.params[1].ty) || fn.returns.t !== 'Int'
    || fn.body?.kind !== 'Block' || fn.body.stmts.length > RECORD_FALLBACK_PROFILE.maxStatements
    || fn.contract?.kind !== 'Contract' || fn.contract.ensures.length === 0 || fn.contract.modifies.length !== 1)
    return fail('bounded pure record signature or contract');
  if (fn.body?.kind !== 'Block' || fn.contract?.kind !== 'Contract') return fail('body or contract');
  const body = fn.body, contract = fn.contract;
  const [left, right] = fn.params.map(param => param.symbol);
  if (left === right || contract.modifies[0].kind !== 'Place' || contract.modifies[0].symbol !== left
    || !same(contract.modifies[0].path, ['value'])) return fail('declared state frame');
  for (const clause of [...contract.requires, ...contract.ensures])
    if (clause.kind !== 'Clause' || clause.rigor !== 'formal') fail('nonformal contract clause');
  const declarationRoot = new GraphStore().intern(fn);
  const obligations: RecordFallbackObligation[] = [];
  for (const alias of [true, false]) {
    const name = alias ? 'alias' : 'distinct';
    const state: Branch = { alias, left: L, right: alias ? L : R, local: null, result: null, allocations: 0, overflow: [] };
    const localSymbols = new Set<SymbolId>();
    let visited = 0;
    const expression = (node: Term, phase: 'entry' | 'current' | 'ensures', depth = 0): Value => {
      if (++visited > RECORD_FALLBACK_PROFILE.maxExpressionNodes || depth > RECORD_FALLBACK_PROFILE.maxExpressionDepth) fail('expression bound');
      switch (node.kind) {
        case 'Lit':
          if (node.ty.t === 'Int' && typeof node.value === 'bigint' && node.value >= 0n && node.value <= MAX)
            return { kind: 'int', term: smt.num(node.value) };
          if (node.ty.t === 'Bool' && typeof node.value === 'boolean')
            return { kind: 'bool', formula: node.value ? smt.T : smt.F };
          return fail('literal outside portable native domain');
        case 'Field': {
          if (node.object.kind !== 'Var' || node.field !== 'value') return fail('field access');
          const symbol = node.object.symbol;
          if (symbol === left) return { kind: 'int', term: phase === 'entry' ? L : state.left };
          if (symbol === right) return { kind: 'int', term: phase === 'entry' ? (alias ? L : R) : state.right };
          if (localSymbols.has(symbol) && phase !== 'entry' && state.local !== null) return { kind: 'int', term: state.local };
          return fail('unbound record field');
        }
        case 'Old': if (phase === 'ensures') return expression(node.expr, 'entry', depth + 1); return fail('old outside ensures');
        case 'ResultRef': if (phase === 'ensures' && state.result !== null) return { kind: 'int', term: state.result }; return fail('result outside ensures');
        case 'Bin': {
          const a = expression(node.left, phase, depth + 1), b = expression(node.right, phase, depth + 1);
          if (node.op === 'add' || node.op === 'sub') {
            const value = node.op === 'add' ? smt.add(int(a), int(b)) : smt.sub(int(a), int(b));
            state.overflow.push(value); return { kind: 'int', term: value };
          }
          if (['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(node.op) && a.kind === 'int' && b.kind === 'int') {
            const relation = node.op === 'ne' ? smt.not(smt.eq(a.term, b.term)) : smt.cmp(node.op as 'eq' | 'lt' | 'le' | 'gt' | 'ge', a.term, b.term);
            return { kind: 'bool', formula: relation };
          }
          if (node.op === 'and' || node.op === 'or') return { kind: 'bool', formula: node.op === 'and' ? smt.and(bool(a), bool(b)) : smt.or(bool(a), bool(b)) };
          return fail('unsupported expression operator');
        }
        default: return fail('unsupported expression node ' + node.kind);
      }
    };
    const precondition = smt.and(...contract.requires.map(clause => bool(expression((clause as Extract<Term, {kind:'Clause'}>).expr, 'entry'))));
    const preconditionOverflow = state.overflow.length;
    const statements = body.stmts;
    if (statements.length < 2 || statements.at(-1)?.kind !== 'Return') fail('missing total return');
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      if (stmt.kind === 'Let') {
        if (state.allocations || !recordType(stmt.ty) || !same(stmt.ty, fn.params[0].ty)
          || stmt.init.kind !== 'RecordLit' || !same(stmt.init.ty, stmt.ty)
          || stmt.init.fields.length !== 1 || stmt.init.fields[0][0] !== 'value'
          || localSymbols.has(stmt.symbol) || stmt.symbol === left || stmt.symbol === right) return fail('local allocation');
        state.local = int(expression(stmt.init.fields[0][1], 'current'));
        localSymbols.add(stmt.symbol); state.allocations++;
      } else if (stmt.kind === 'Assign') {
        if (stmt.target.kind !== 'Place' || !same(stmt.target.path, ['value'])) return fail('assignment place');
        const target = stmt.target.symbol;
        if (target !== left && !localSymbols.has(target)) fail('write outside frame');
        const value = int(expression(stmt.value, 'current'));
        if (target === left) { state.left = value; if (alias) state.right = value; }
        else state.local = value;
      } else if (stmt.kind === 'Return' && i === statements.length - 1) {
        state.result = int(expression(stmt.value, 'current'));
      } else fail('nonterminating, faulting or unsupported statement');
    }
    if (state.allocations !== 1 || state.result === null || state.local === null) fail('one allocation and total result');
    const returned = state.result ?? fail('missing return value'), allocated = state.local ?? fail('missing allocation value');
    const postcondition = smt.and(...contract.ensures.map(clause => bool(expression((clause as Extract<Term, {kind:'Clause'}>).expr, 'ensures'))));
    const assumption = smt.and(entryDomain, precondition);
    state.overflow.forEach((value, index) => obligations.push({ kind: name + '.i64.' + index,
      formula: smt.implies(index < preconditionOverflow ? entryDomain : assumption, bounds(value, MIN, MAX)) }));
    obligations.push({ kind: name + '.return-i64', formula: smt.implies(assumption, bounds(returned, MIN, MAX)) });
    obligations.push({ kind: name + '.allocation-i64', formula: smt.implies(assumption, bounds(allocated, MIN, MAX)) });
    obligations.push({ kind: name + '.frame', formula: smt.implies(assumption,
      alias ? smt.eq(state.right, state.left) : smt.eq(state.right, R)) });
    // The existing conservative tier guarantees a contract-compliant success
    // for aliases. For distinct refs, success is conditional; otherwise the
    // native postcondition rejects it and the driver restores the entry frame.
    obligations.push({ kind: name + '.postcondition', formula: smt.implies(assumption,
      alias ? postcondition : smt.iff(postcondition, smt.eq(R, smt.add(L, smt.num(1n)))) ) });
  }
  const manifestDigest = executionManifestDigest(manifest);
  const obligationSetDigest = domainDigest('aether.record-fallback-obligations/1', {
    manifestDigest, astRoot, declarationRoot, tier2: context.tier2, profileDigest: RECORD_FALLBACK_PROFILE_DIGEST,
    obligations: obligations.map(item => ({ kind: item.kind, casesDigest: formulaCasesDigest(formulaCounterexampleCases(item.formula, manifestDigest)) })),
  });
  return freezeTree({ manifestDigest, astRoot, declarationRoot, obligationSetDigest, obligations });
}

export function checkRecordFallbackCertificate(context: RecordFallbackContext, value: unknown): CheckedRecordFallbackProof {
  encodeCanonical(value);
  const record = exactObject(value, ['format', 'manifest', 'tier2', 'declarationRoot', 'profileDigest', 'obligationSetDigest', 'certificates']);
  if (record.format !== 'aether.record-fallback-proof/1' || record.tier2 !== context.tier2
    || record.profileDigest !== RECORD_FALLBACK_PROFILE_DIGEST || !Array.isArray(record.certificates)
    || executionManifestDigest(record.manifest as ExecutionManifestV1) !== executionManifestDigest(context.manifest))
    fail('stale certificate context');
  const rows = record.certificates;
  if (!Array.isArray(rows)) return fail('certificate rows');
  const derived = deriveRecordFallbackObligations(context);
  if (record.declarationRoot !== derived.declarationRoot || record.obligationSetDigest !== derived.obligationSetDigest
    || rows.length !== derived.obligations.length) fail('incomplete or changed obligations');
  for (let index = 0; index < derived.obligations.length; index++) {
    const item = exactObject(rows[index], ['kind', 'proof']);
    if (item.kind !== derived.obligations[index].kind) fail('reordered or missing obligation');
    checkFormulaCertificate(derived.obligations[index].formula, item.proof, derived.manifestDigest);
  }
  const result: CheckedRecordFallbackProof = Object.freeze({ format: 'aether.checked-record-fallback-proof/1',
    manifestDigest: derived.manifestDigest, astRoot: derived.astRoot, tier2: context.tier2,
    declarationRoot: derived.declarationRoot, obligationSetDigest: derived.obligationSetDigest,
    certificateDigest: domainDigest('aether.record-fallback-proof/1', value), domain: RECORD_FALLBACK_PROFILE });
  checked.set(result, derived.manifestDigest); return result;
}

export function validateCheckedRecordFallbackProof(value: CheckedRecordFallbackProof, context: RecordFallbackContext): void {
  if (!value || typeof value !== 'object' || checked.get(value) !== executionManifestDigest(context.manifest)
    || value.astRoot !== context.manifest.astRoot || value.tier2 !== context.tier2) fail('untrusted checked proof');
  const derived = deriveRecordFallbackObligations(context);
  if (value.declarationRoot !== derived.declarationRoot || value.obligationSetDigest !== derived.obligationSetDigest
    || value.manifestDigest !== derived.manifestDigest) fail('stale checked proof subject');
}
