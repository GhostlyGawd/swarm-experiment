/** Versioned lowering to an explicit-register checkpointable execution machine.
 * Existing JS-closure compiled artifacts are not reinterpreted as resumable.
 */
import { validateMachineType } from './resumable-types.ts';
import { types as nodeTypes } from 'node:util';
import { children, type Term, type Ty, type Param } from '../tier1/ast.ts';
import type { NodeRef, SymbolId, CapabilityName } from '../tier1/ids.ts';
import { GraphStore } from '../tier1/store.ts';
import { typecheck, underlying } from '../tier2/typecheck.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { domainDigest, executionManifestDigest, decodeExecutionManifest, encodeExecutionManifest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { encodeCanonical, exactObject, validString, type WireValue } from '../fabric/encoding.ts';

export const RESUMABLE_PROGRAM_PROFILE = Object.freeze({ format: 'aether.resumable-profile/1', semantics: 'aether-reference/1', scheduler: 'lazy-cooperative-await', safePoints: 'completed-bytecode-instructions', capture: 'scope-value-copy-with-shared-heap-identity', atomic: 'rollback-fault-preserve-return', maxInstructions: 100_000, maxCodes: 4096 });
export const RESUMABLE_PROFILE_DIGEST = domainDigest('aether.resumable-profile/1', RESUMABLE_PROGRAM_PROFILE);
export interface Instruction { readonly op: string; readonly source: NodeRef; readonly args: readonly WireValue[] }
export interface ResumableCode {
  readonly id: string; readonly kind: 'function' | 'lambda' | 'task'; readonly symbol: SymbolId;
  readonly params: readonly Param[]; readonly returns: Ty; readonly capabilities: readonly CapabilityName[];
  readonly surfaces: readonly { readonly symbol: SymbolId; readonly value: WireValue }[];
  readonly instructions: readonly Instruction[]; readonly returnPc: number;
}
export interface ResumableProgram {
  readonly format: 'aether.resumable-program/1'; readonly manifest: ExecutionManifestV1;
  readonly manifestDigest: Digest; readonly profileDigest: Digest; readonly digest: Digest;
  readonly codes: readonly ResumableCode[];
}
export interface ResumableProgramOptions { readonly manifest: ExecutionManifestV1; readonly registry: CapabilityRegistry; readonly dependencies?: readonly Term[] }
const literal = (value: bigint | boolean | string | null): WireValue => value === null ? { tag: 'null' } : typeof value === 'bigint' ? { tag: 'int', value: String(value) } : typeof value === 'boolean' ? { tag: 'bool', value } : { tag: 'string', value };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

export function compileResumableProgram(inputModule: Term, options: ResumableProgramOptions): ResumableProgram {
  let values = 0; const active = new Set<object>();
  const inspect = (value: unknown, depth = 0): unknown => {
    if (++values > 200_000 || depth > 96) throw new RangeError('resumable AST resource limit');
    if (typeof value === 'bigint') { if (String(value).length > 4097) throw new RangeError('resumable integer limit'); return { integer: String(value) }; }
    if (typeof value === 'string') { validString(value); return value; }
    if (value === undefined) return null;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (!value || typeof value !== 'object' || active.has(value) || nodeTypes.isProxy(value)) throw new TypeError('cyclic/opaque resumable AST');
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('sparse resumable AST');
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor || !('value' in descriptor)) throw new TypeError('resumable AST accessor'); result.push(inspect(descriptor.value, depth + 1)); }
        return result;
      }
      const keys = Object.keys(value); exactObject(value, keys); if (keys.includes('__proto__')) throw new TypeError('reserved resumable AST field');
      return Object.fromEntries(keys.map(key => [key, inspect((value as Record<string, unknown>)[key], depth + 1)]));
    } finally { active.delete(value); }
  };
  for (const input of [inputModule, ...(options.dependencies ?? [])]) encodeCanonical(inspect(input), { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024, maxDepth: 128, maxObjects: 400_000 });
  const module = structuredClone(inputModule), dependencies = structuredClone(options.dependencies ?? []);
  const manifest = decodeExecutionManifest(encodeExecutionManifest(options.manifest));

  if (module.kind !== 'Module' || manifest.semanticsVersion !== RESUMABLE_PROGRAM_PROFILE.semantics) throw new TypeError('unsupported resumable module/semantics');
  const store = new GraphStore(), root = store.intern(module);
  if (root !== manifest.astRoot) throw new TypeError('resumable AST does not match trusted execution manifest');
  const declarations = [...module.members.filter((node): node is Extract<Term, { kind: 'FunctionDecl' }> => node.kind === 'FunctionDecl')];
  for (const dependency of dependencies) {
    if (dependency.kind !== 'FunctionDecl' || declarations.some(decl => decl.symbol === dependency.symbol)) throw new TypeError('invalid resumable dependency');
    declarations.push(dependency);
  }
  const bySymbol = new Map(declarations.map(decl => [decl.symbol, decl]));
  if (bySymbol.size !== declarations.length) throw new TypeError('duplicate resumable function');
  for (const dependency of manifest.dependencies) {
    const declaration = bySymbol.get(dependency.symbol as SymbolId);
    if (!declaration || store.intern(declaration) !== dependency.declaration) throw new TypeError('resumable dependency closure mismatch');
  }
  const callSymbols = (term: Term): SymbolId[] => [...(term.kind === 'Call' || term.kind === 'SeqMap' || term.kind === 'SeqFold' ? [term.callee] : []), ...children(term).flatMap(callSymbols)];
  const closure = new Map<SymbolId, NodeRef>(), pending = module.members.filter(member => member.kind === 'FunctionDecl').flatMap(callSymbols);
  while (pending.length) { const symbol = pending.pop()!; if (closure.has(symbol)) continue; const declaration = bySymbol.get(symbol); if (!declaration) throw new TypeError('unresolved resumable dependency'); closure.set(symbol, store.intern(declaration)); pending.push(...callSymbols(declaration)); }
  const actual = [...closure].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([symbol, declaration]) => ({ symbol, declaration }));
  if (!Buffer.from(encodeCanonical(actual)).equals(Buffer.from(encodeCanonical(manifest.dependencies))) || dependencies.some(dependency => dependency.kind !== 'FunctionDecl' || !closure.has(dependency.symbol))) throw new TypeError('incomplete or extra resumable dependency closure');
  const checked = typecheck({ ...module, members: [...module.members, ...declarations.filter(decl => !module.members.includes(decl))] }, { registry: options.registry });
  if (!checked.ok) throw new TypeError(`resumable program typecheck failed: ${checked.diagnostics.map(item => item.code).join(',')}`);
  const codes: ResumableCode[] = [], compiled = new Set<string>();
  let total = 0;
  const compileCode = (id: string, kind: ResumableCode['kind'], owner: SymbolId, params: readonly Param[], returns: Ty, capabilities: readonly CapabilityName[], body: Term, contract: Term | null = null, surfaces: readonly Term[] = [], inheritedOld = false, capturedTypes: ReadonlyMap<SymbolId, Ty> = new Map()): void => {
    if (compiled.has(id)) return; compiled.add(id);
    if (compiled.size > RESUMABLE_PROGRAM_PROFILE.maxCodes) throw new RangeError('resumable code count limit');
    const instructions: Instruction[] = []; let tempId = 0;
    const lexicalTypes = new Map(capturedTypes); params.forEach(param => lexicalTypes.set(param.symbol, param.ty));
    surfaces.forEach(surface => { if (surface.kind === 'Surface') lexicalTypes.set(surface.symbol, typeof surface.current === 'bigint' ? { t: 'Int' } : { t: 'Str' }); });
    const source = (term: Term) => store.intern(term);
    const emit = (term: Term, op: string, ...args: WireValue[]): number => { if (++total > RESUMABLE_PROGRAM_PROFILE.maxInstructions) throw new RangeError('resumable instruction limit'); instructions.push({ op, source: source(term), args }); return instructions.length - 1; };
    const patch = (pc: number, target: number): void => { instructions[pc] = { ...instructions[pc], args: [target] }; };
    const temp = () => `register-${tempId++}`;
    const get = (term: Term, name: string) => emit(term, 'temp-load', name);
    const put = (term: Term, name: string) => emit(term, 'temp-store', name);
    const substitute = (type: Ty, variables: Map<string, Ty>): Ty => {
      if (type.t === 'TypeVar') return variables.get(type.name) ?? type;
      if (type.t === 'Nominal') return { ...type, repr: substitute(type.repr, variables) };
      if (type.t === 'Owned') return { ...type, inner: substitute(type.inner, variables) };
      if (type.t === 'Seq') return { ...type, element: substitute(type.element, variables) };
      if (type.t === 'Task') return { ...type, result: substitute(type.result, variables) };
      if (type.t === 'Result') return { ...type, ok: substitute(type.ok, variables), err: substitute(type.err, variables) };
      if (type.t === 'Record') return { ...type, fields: type.fields.map(([name, child]) => [name, substitute(child, variables)]) };
      if (type.t === 'Fn') return { ...type, params: type.params.map(child => substitute(child, variables)), returns: substitute(type.returns, variables) };
      return type;
    };
    const bindTypes = (expected: Ty, actual: Ty, variables: Map<string, Ty>): void => {
      if (expected.t === 'TypeVar') { variables.set(expected.name, actual); return; }
      if (expected.t === 'Seq' && actual.t === 'Seq') bindTypes(expected.element, actual.element, variables);
      if (expected.t === 'Result' && actual.t === 'Result') { bindTypes(expected.ok, actual.ok, variables); bindTypes(expected.err, actual.err, variables); }
      if (expected.t === 'Owned') bindTypes(expected.inner, actual.t === 'Owned' ? actual.inner : actual, variables);
      if (expected.t === 'Nominal' && actual.t === 'Nominal') bindTypes(expected.repr, actual.repr, variables);
      if (expected.t === 'Task' && actual.t === 'Task') bindTypes(expected.result, actual.result, variables);
      if (expected.t === 'Record' && actual.t === 'Record') for (const [name, type] of expected.fields) { const field = actual.fields.find(([field]) => field === name); if (field) bindTypes(type, field[1], variables); }
      if (expected.t === 'Fn' && actual.t === 'Fn') { expected.params.forEach((type, index) => { if (actual.params[index]) bindTypes(type, actual.params[index], variables); }); bindTypes(expected.returns, actual.returns, variables); }
    };
    const callType = (symbol: SymbolId, args: Ty[]): Ty => { const decl = bySymbol.get(symbol); if (!decl) throw new TypeError('unknown typed callee'); const variables = new Map<string, Ty>(); decl.params.forEach((param, index) => bindTypes(param.ty, args[index], variables)); return substitute(decl.returns, variables); };
    const inferred = (term: Term): Ty => {
      switch (term.kind) {
        case 'Lit': case 'RecordLit': case 'ResultValue': case 'SeqLit': case 'IntCast': case 'FixedBin': return term.ty;
        case 'Var': return lexicalTypes.get(term.symbol) ?? (() => { throw new TypeError('unbound inferred task variable'); })();
        case 'Place': { let type = lexicalTypes.get(term.symbol); if (!type) throw new TypeError('unbound inferred place'); for (const field of term.path) { const record = underlying(type); if (record.t !== 'Record') throw new TypeError('inferred field of non-record'); type = record.fields.find(([name]) => name === field)?.[1]; if (!type) throw new TypeError('unknown inferred field'); } return type; }
        case 'Field': { const type = underlying(inferred(term.object)); if (type.t !== 'Record') throw new TypeError('inferred non-record field'); const field = type.fields.find(([name]) => name === term.field); if (!field) throw new TypeError('unknown inferred field'); return field[1]; }
        case 'Un': return term.op === 'not' ? { t: 'Bool' } : inferred(term.operand);
        case 'Bin': { if (['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or'].includes(term.op)) return { t: 'Bool' }; const left = inferred(term.left), right = inferred(term.right); if (term.op === 'mul' && right.t === 'Nominal') return right; if (term.op === 'div' && left.t === 'Nominal' && right.t === 'Nominal') return { t: 'Int' }; return left; }
        case 'Cond': return inferred(term.then);
        case 'Call': return callType(term.callee, term.args.map(inferred));
        case 'Invoke': return { t: 'Unit' };
        case 'Old': return inferred(term.expr);
        case 'ResultRef': return returns;
        case 'SeqLength': return { t: 'Int' };
        case 'SeqIndex': { const type = underlying(inferred(term.sequence)); if (type.t !== 'Seq') throw new TypeError('inferred non-sequence index'); return type.element; }
        case 'SeqMap': { const type = underlying(inferred(term.sequence)); if (type.t !== 'Seq') throw new TypeError('inferred non-sequence map'); return { t: 'Seq', element: callType(term.callee, [type.element]) }; }
        case 'SeqFold': return inferred(term.initial);
        case 'Lambda': return { t: 'Fn', params: term.params.map(param => param.ty), returns: term.returns, capabilities: term.capabilities };
        case 'Apply': { const type = inferred(term.fn); if (type.t !== 'Fn') throw new TypeError('inferred non-function apply'); return type.returns; }
        case 'Spawn': return { t: 'Task', result: inferred(term.body) };
        case 'Await': { const type = inferred(term.task); if (type.t !== 'Task') throw new TypeError('inferred non-task await'); return type.result; }
        case 'ForAll': return { t: 'Bool' };
        case 'StringOp': return { t: term.op === 'strlen' ? 'Int' : term.op === 'contains' ? 'Bool' : 'Str' };
        case 'MatchResult': { const result = inferred(term.value); if (result.t !== 'Result') throw new TypeError('inferred non-result match'); const previous = lexicalTypes.get(term.okSymbol); lexicalTypes.set(term.okSymbol, result.ok); const type = inferred(term.ok); if (previous) lexicalTypes.set(term.okSymbol, previous); else lexicalTypes.delete(term.okSymbol); return type; }
        default: throw new TypeError('unsupported task result inference');
      }
    };
    const expression = (term: Term, old = inheritedOld): void => {
      switch (term.kind) {
        case 'Lit': {
          const type = underlying(term.ty);
          if (!(['Int', 'IntN'].includes(type.t) ? typeof term.value === 'bigint' : type.t === 'Bool' ? typeof term.value === 'boolean' : type.t === 'Str' ? typeof term.value === 'string' : type.t === 'Unit' && term.value === null)) throw new TypeError('invalid resumable literal representation');
          emit(term, 'literal', literal(term.value)); return;
        }
        case 'Var': emit(term, 'load', term.symbol, old); return;
        case 'Place': emit(term, 'load', term.symbol, old); term.path.forEach(field => emit(term, 'field', field, old)); return;
        case 'Field': expression(term.object, old); emit(term, 'field', term.field, old); return;
        case 'Old': expression(term.expr, true); return;
        case 'ResultRef': emit(term, 'result'); return;
        case 'Un': if (term.op !== 'not' && term.op !== 'neg') throw new TypeError('unsupported resumable unary operator'); expression(term.operand, old); emit(term, 'unary', term.op); return;
        case 'Bin':
          if (!['add', 'sub', 'mul', 'div', 'mod', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or', 'concat'].includes(term.op)) throw new TypeError('unsupported resumable binary operator');
          expression(term.left, old);
          if (term.op === 'and' || term.op === 'or') {
            emit(term, 'duplicate'); const shortcut = emit(term, term.op === 'and' ? 'jump-false' : 'jump-true', 0);
            emit(term, 'discard'); expression(term.right, old); patch(shortcut, instructions.length);
          } else { expression(term.right, old); emit(term, 'binary', term.op); }
          return;
        case 'Cond': { expression(term.cond, old); const no = emit(term, 'jump-false', 0); expression(term.then, old); const end = emit(term, 'jump', 0); patch(no, instructions.length); expression(term.otherwise, old); patch(end, instructions.length); return; }
        case 'Call': term.args.forEach(arg => expression(arg, old)); emit(term, 'call', term.callee, term.args.length); return;
        case 'Invoke': term.args.forEach(arg => expression(arg, old)); emit(term, 'effect', term.capability, term.args.length); return;
        case 'RecordLit': term.fields.forEach(([, value]) => expression(value, old)); emit(term, 'record', term.fields.map(([field]) => field), term.ty as unknown as WireValue); return;
        case 'ResultValue': expression(term.value, old); emit(term, 'result-wrap', term.variant); return;
        case 'MatchResult': {
          const matchedType = inferred(term.value), oldOk = lexicalTypes.get(term.okSymbol), oldErr = lexicalTypes.get(term.errSymbol);
          if (matchedType.t !== 'Result') throw new TypeError('typed Result match required');
          lexicalTypes.set(term.okSymbol, matchedType.ok); lexicalTypes.set(term.errSymbol, matchedType.err);
          expression(term.value, old); const value = temp(); put(term, value); get(term, value); emit(term, 'result-is-ok'); const error = emit(term, 'jump-false', 0);
          emit(term, 'scope-enter'); get(term, value); emit(term, 'result-value'); emit(term, 'let', term.okSymbol); expression(term.ok, old); emit(term, 'scope-exit'); const done = emit(term, 'jump', 0);
          patch(error, instructions.length); emit(term, 'scope-enter'); get(term, value); emit(term, 'result-value'); emit(term, 'let', term.errSymbol); expression(term.err, old); emit(term, 'scope-exit'); patch(done, instructions.length);
          if (oldOk) lexicalTypes.set(term.okSymbol, oldOk); else lexicalTypes.delete(term.okSymbol); if (oldErr) lexicalTypes.set(term.errSymbol, oldErr); else lexicalTypes.delete(term.errSymbol); return;
        }
        case 'SeqLit': term.items.forEach(item => expression(item, old)); emit(term, 'sequence', term.items.length); return;
        case 'SeqLength': expression(term.sequence, old); emit(term, 'sequence-length'); return;
        case 'SeqIndex': expression(term.sequence, old); expression(term.index, old); emit(term, 'sequence-index'); return;
        case 'SeqMap': case 'SeqFold': {
          const sequence = temp(), index = temp(), accumulator = temp(); expression(term.sequence, old); put(term, sequence);
          emit(term, 'literal', literal(0n)); put(term, index);
          if (term.kind === 'SeqFold') expression(term.initial, old); else emit(term, 'sequence', 0);
          put(term, accumulator); const loop = instructions.length;
          get(term, index); get(term, sequence); emit(term, 'sequence-length'); emit(term, 'binary', 'lt'); const end = emit(term, 'jump-false', 0);
          if (term.kind === 'SeqFold') get(term, accumulator);
          get(term, sequence); get(term, index); emit(term, 'sequence-index'); emit(term, 'call', term.callee, term.kind === 'SeqFold' ? 2 : 1);
          if (term.kind === 'SeqMap') { get(term, accumulator); emit(term, 'sequence-append-reverse'); }
          put(term, accumulator); get(term, index); emit(term, 'literal', literal(1n)); emit(term, 'binary', 'add'); put(term, index); emit(term, 'jump', loop); patch(end, instructions.length); get(term, accumulator); return;
        }
        case 'Lambda': {
          const nested = `lambda:${owner}:${source(term)}:${old ? 'old' : 'current'}`;
          compileCode(nested, 'lambda', owner, term.params, term.returns, term.capabilities, term.body, null, [], old, new Map(lexicalTypes));
          emit(term, 'closure', nested); return;
        }
        case 'Apply': expression(term.fn, old); term.args.forEach(arg => expression(arg, old)); emit(term, 'apply', term.args.length); return;
        case 'Spawn': {
          const nested = `task:${owner}:${source(term)}:${old ? 'old' : 'current'}`;
          compileCode(nested, 'task', owner, [], inferred(term.body), capabilities, term.body, null, [], old, new Map(lexicalTypes)); emit(term, 'spawn', nested); return;
        }
        case 'Await': expression(term.task, old); emit(term, 'await'); return;
        case 'StringOp': if (!['strlen', 'contains', 'slice', 'lower', 'upper', 'trim'].includes(term.op)) throw new TypeError('unsupported resumable string operator'); term.args.forEach(arg => expression(arg, old)); emit(term, 'string', term.op, term.args.length); return;
        case 'IntCast': expression(term.value, old); emit(term, 'fixed', 'cast', term.ty as unknown as WireValue); return;
        case 'FixedBin': if (!['add', 'sub', 'mul', 'div', 'mod'].includes(term.op)) throw new TypeError('unsupported fixed operator'); expression(term.left, old); expression(term.right, old); emit(term, 'fixed', term.op, term.ty as unknown as WireValue); return;
        case 'ForAll': {
          const end = temp(), value = temp(), answer = temp(); expression(term.start, old); put(term, value); expression(term.end, old); put(term, end); emit(term, 'literal', literal(true)); put(term, answer); emit(term, 'scope-enter');
          get(term, value); emit(term, 'let', term.symbol); const loop = instructions.length;
          emit(term, 'load', term.symbol, false); get(term, end); emit(term, 'binary', 'lt'); const done = emit(term, 'jump-false', 0);
          const previousType = lexicalTypes.get(term.symbol); lexicalTypes.set(term.symbol, { t: 'Int' });
          expression(term.body, old); if (previousType) lexicalTypes.set(term.symbol, previousType); else lexicalTypes.delete(term.symbol); const failed = emit(term, 'jump-false', 0);
          emit(term, 'load', term.symbol, false); emit(term, 'literal', literal(1n)); emit(term, 'binary', 'add'); emit(term, 'assign-local', term.symbol); emit(term, 'jump', loop);
          patch(failed, instructions.length); emit(term, 'literal', literal(false)); put(term, answer); patch(done, instructions.length); emit(term, 'scope-exit'); get(term, answer); return;
        }
        default: throw new TypeError(`unsupported resumable expression ${term.kind}`);
      }
    };
    const returnsToPatch: number[] = [];
    const statement = (term: Term): void => {
      switch (term.kind) {
        case 'Block': { const outer = new Map(lexicalTypes); emit(term, 'scope-enter'); term.stmts.forEach(statement); emit(term, 'scope-exit'); lexicalTypes.clear(); for (const [symbol, type] of outer) lexicalTypes.set(symbol, type); return; }
        case 'Let': expression(term.init); lexicalTypes.set(term.symbol, term.ty); emit(term, 'let', term.symbol); return;
        case 'Assign': {
          expression(term.value); const value = temp(); put(term, value);
          if (term.target.kind === 'Place' && !term.target.path.length) { get(term, value); emit(term, 'assign-local', term.target.symbol); return; }
          if (term.target.kind === 'Place') { emit(term.target, 'load', term.target.symbol, false); term.target.path.slice(0, -1).forEach(field => emit(term.target, 'field', field, false)); get(term, value); emit(term, 'assign-field', term.target.path.at(-1)!); return; }
          if (term.target.kind === 'Field') { expression(term.target.object); get(term, value); emit(term, 'assign-field', term.target.field); return; }
          throw new TypeError('unsupported resumable assignment target');
        }
        case 'If': { expression(term.cond); const no = emit(term, 'jump-false', 0); statement(term.then); const end = emit(term, 'jump', 0); patch(no, instructions.length); if (term.otherwise) statement(term.otherwise); patch(end, instructions.length); return; }
        case 'While': { const loop = instructions.length; expression(term.cond); const end = emit(term, 'jump-false', 0); statement(term.body); emit(term, 'jump', loop); patch(end, instructions.length); return; }
        case 'Return': expression(term.value); returnsToPatch.push(emit(term, 'begin-return', 0)); return;
        case 'Assert': expression(term.expr); emit(term, 'assert', 'assertion', term.label); return;
        case 'ExprStmt': expression(term.expr); emit(term, 'discard'); return;
        case 'Yield': emit(term, 'yield'); return;
        case 'Atomic': emit(term, 'atomic-enter'); statement(term.body); emit(term, 'atomic-exit'); return;
        default: expression(term); emit(term, 'discard'); return;
      }
    };
    if (contract?.kind === 'Contract') for (const clause of contract.requires) { if (clause.kind !== 'Clause') throw new TypeError('invalid resumable precondition'); expression(clause.expr); emit(clause, 'assert', 'precondition', clause.label); }
    if (kind === 'function') { statement(body); emit(body, 'literal', literal(null)); returnsToPatch.push(emit(body, 'begin-return', 0)); }
    else { expression(body, inheritedOld); returnsToPatch.push(emit(body, 'begin-return', 0)); }
    const returnPc = instructions.length; returnsToPatch.forEach(pc => patch(pc, returnPc));
    if (contract?.kind === 'Contract') for (const clause of contract.ensures) { if (clause.kind !== 'Clause') throw new TypeError('invalid resumable postcondition'); expression(clause.expr); emit(clause, 'assert', 'postcondition', clause.label); }
    emit(body, 'return');
    params.forEach(param => validateMachineType(param.ty)); validateMachineType(returns);
    codes.push({ id, kind, symbol: owner, params, returns, capabilities, surfaces: surfaces.map(surface => { if (surface.kind !== 'Surface') throw new TypeError('invalid resumable surface'); return { symbol: surface.symbol, value: literal(surface.current) }; }), instructions, returnPc });
  };
  for (const decl of declarations) { if (!decl.body) throw new TypeError('resumable function has no body'); compileCode(`function:${decl.symbol}`, 'function', decl.symbol, decl.params, decl.returns, decl.capabilities, decl.body, decl.contract, decl.surfaces); }
  codes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const body = { format: 'aether.resumable-program/1' as const, manifest, manifestDigest: executionManifestDigest(manifest), profileDigest: RESUMABLE_PROFILE_DIGEST, codes };
  encodeCanonical(body, { maxDepth: 128, maxObjects: 1_000_000, maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024 });
  return freeze({ ...body, digest: domainDigest('aether.resumable-program/1', body, { maxDepth: 128, maxObjects: 1_000_000, maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024 }) });
}
