/** Representational checks for resumable call boundaries. Bindings are data,
 * never capability grants; nominal declaration metadata remains code-bound. */
import type { Ty } from '../tier1/ast.ts';
import { encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { tyEqual } from '../tier2/typecheck.ts';
import type { MachineCore, MachineValue } from './resumable-state.ts';
import type { ResumableCode, ResumableProgram } from './resumable-program.ts';
export type MachineTypeShape = { kind: 'Int' | 'Bool' | 'Str' | 'Unit' } | { kind: 'Seq'; element: MachineTypeShape | null } | { kind: 'Result'; ok: MachineTypeShape | null; err: MachineTypeShape | null } | { kind: 'Known'; ty: Ty };
export type MachineTypeBindings = [string, MachineTypeShape][];
export function validateMachineType(ty: unknown, depth = 0): asserts ty is Ty {
  if (depth > 64 || !ty || typeof ty !== 'object') throw new TypeError('invalid resumable type');
  const value = ty as Ty;
  switch (value.t) {
    case 'Int': case 'Bool': case 'Str': case 'Unit': exactObject(value, ['t']); return;
    case 'TypeVar': exactObject(value, ['t', 'name']); identifier(value.name); return;
    case 'Nominal': exactObject(value, ['t', 'name', 'repr']); identifier(value.name); validateMachineType(value.repr, depth + 1); return;
    case 'Owned': exactObject(value, ['t', 'inner']); validateMachineType(value.inner, depth + 1); return;
    case 'Seq': exactObject(value, ['t', 'element']); validateMachineType(value.element, depth + 1); return;
    case 'Task': exactObject(value, ['t', 'result']); validateMachineType(value.result, depth + 1); return;
    case 'Result': exactObject(value, ['t', 'ok', 'err']); validateMachineType(value.ok, depth + 1); validateMachineType(value.err, depth + 1); return;
    case 'IntN': exactObject(value, ['t', 'bits', 'signed', 'overflow']); if (![8, 16, 32, 64].includes(value.bits) || typeof value.signed !== 'boolean' || !['wrap', 'trap', 'saturate'].includes(value.overflow)) throw new TypeError('invalid fixed-width type'); return;
    case 'Fn': exactObject(value, ['t', 'params', 'returns', 'capabilities']); if (!Array.isArray(value.params) || !Array.isArray(value.capabilities)) throw new TypeError('invalid function type'); value.params.forEach(item => validateMachineType(item, depth + 1)); value.capabilities.forEach(identifier); validateMachineType(value.returns, depth + 1); return;
    case 'Record': { exactObject(value, ['t', 'name', 'fields']); identifier(value.name); if (!Array.isArray(value.fields)) throw new TypeError('invalid record type'); const names = new Set<string>(); for (const entry of value.fields) { if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('invalid record type field'); identifier(entry[0]); if (names.has(entry[0])) throw new TypeError('duplicate record type field'); names.add(entry[0]); validateMachineType(entry[1], depth + 1); } return; }
    default: throw new TypeError('unknown resumable type');
  }
}
export function validateMachineTypeBindings(value: unknown): asserts value is MachineTypeBindings {
  encodeCanonical(value, { maxDepth: 128 }); if (!Array.isArray(value)) throw new TypeError('invalid machine type bindings'); const names = new Set<string>();
  const shape = (value: MachineTypeShape, depth: number): void => {
    if (depth > 64 || !value || typeof value !== 'object') throw new TypeError('invalid generic shape');
    if (['Int', 'Bool', 'Str', 'Unit'].includes(value.kind)) { exactObject(value, ['kind']); return; }
    if (value.kind === 'Known') { exactObject(value, ['kind', 'ty']); validateMachineType(value.ty); return; }
    if (value.kind === 'Seq') { exactObject(value, ['kind', 'element']); if (value.element !== null) shape(value.element, depth + 1); return; }
    if (value.kind === 'Result') { exactObject(value, ['kind', 'ok', 'err']); if (value.ok !== null) shape(value.ok, depth + 1); if (value.err !== null) shape(value.err, depth + 1); return; }
    throw new TypeError('unknown generic shape');
  };
  for (const entry of value) { if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('invalid type binding'); identifier(entry[0]); if (names.has(entry[0])) throw new TypeError('duplicate type binding'); names.add(entry[0]); shape(entry[1], 0); }
}
function unify(left: MachineTypeShape | null, right: MachineTypeShape | null, infer: boolean): MachineTypeShape | null {
  if (right === null) return left; if (left === null) { if (!infer) throw new TypeError('unresolved return type binding'); return right; }
  if (left.kind !== right.kind) throw new TypeError('inconsistent generic argument types');
  if (left.kind === 'Known' && right.kind === 'Known') { if (!tyEqual(left.ty, right.ty)) throw new TypeError('inconsistent generic declared types'); return left; }
  if (left.kind === 'Seq' && right.kind === 'Seq') return { kind: 'Seq', element: unify(left.element, right.element, infer) };
  if (left.kind === 'Result' && right.kind === 'Result') return { kind: 'Result', ok: unify(left.ok, right.ok, infer), err: unify(left.err, right.err, infer) };
  return left;
}
function shapeTy(shape: MachineTypeShape): Ty {
  if (shape.kind === 'Known') return shape.ty;
  if (shape.kind === 'Seq') { if (shape.element === null) throw new TypeError('empty generic sequence needs a type witness here'); return { t: 'Seq', element: shapeTy(shape.element) }; }
  if (shape.kind === 'Result') { if (shape.ok === null || shape.err === null) throw new TypeError('partial generic result needs a type witness here'); return { t: 'Result', ok: shapeTy(shape.ok), err: shapeTy(shape.err) }; }
  return { t: shape.kind };
}
export function instantiateMachineType(ty: Ty, bindings: MachineTypeBindings): Ty {
  if (ty.t === 'TypeVar') { const shape = new Map(bindings).get(ty.name); if (!shape) throw new TypeError('missing generic type witness'); return shapeTy(shape); }
  if (ty.t === 'Nominal') return { ...ty, repr: instantiateMachineType(ty.repr, bindings) };
  if (ty.t === 'Owned') return { ...ty, inner: instantiateMachineType(ty.inner, bindings) };
  if (ty.t === 'Seq') return { ...ty, element: instantiateMachineType(ty.element, bindings) };
  if (ty.t === 'Result') return { ...ty, ok: instantiateMachineType(ty.ok, bindings), err: instantiateMachineType(ty.err, bindings) };
  if (ty.t === 'Task') return { ...ty, result: instantiateMachineType(ty.result, bindings) };
  if (ty.t === 'Record') return { ...ty, fields: ty.fields.map(([name, type]) => [name, instantiateMachineType(type, bindings)]) };
  if (ty.t === 'Fn') return { ...ty, params: ty.params.map(type => instantiateMachineType(type, bindings)), returns: instantiateMachineType(ty.returns, bindings) };
  return ty;
}
class Validator {
  readonly bindings: Map<string, MachineTypeShape>;
  private visits = 0;
  private readonly seen = new Set<string>();
  private readonly borrowed = new Set<string>();
  private readonly owned: Set<string>[] = [];
  private readonly core: MachineCore; private readonly program: ResumableProgram; private readonly infer: boolean;
  constructor(core: MachineCore, program: ResumableProgram, initial: MachineTypeBindings, infer: boolean) { this.core = core; this.program = program; this.infer = infer; validateMachineTypeBindings(initial); this.bindings = new Map(initial); }
  private budget(depth: number): void { if (++this.visits > 100_000 || depth > 64) throw new RangeError('resumable type validation limit'); }
  private row(value: MachineValue) { if (value.tag !== 'ref') throw new TypeError('expected typed record reference'); const record = this.core.records.find(item => item.id === value.value.objectId); if (!record || value.value.heapId !== this.core.heapId || value.value.ownerEpoch !== record.epoch) throw new TypeError('stale typed record reference'); return record; }
  private shape(value: MachineValue, depth: number, region: Set<string> | null = null): MachineTypeShape {
    this.budget(depth);
    if (value.tag === 'null') return { kind: 'Unit' }; if (value.tag === 'int') return { kind: 'Int' }; if (value.tag === 'bool') return { kind: 'Bool' }; if (value.tag === 'string') return { kind: 'Str' };
    if (value.tag === 'sequence') { let element: MachineTypeShape | null = null; for (const item of this.core.sequences.find(row => row.id === value.id)!.items) element = unify(element, this.shape(item, depth + 1, region), true); return { kind: 'Seq', element }; }
    if (value.tag === 'result') { const row = this.core.results.find(row => row.id === value.id)!; return { kind: 'Result', ok: row.variant === 'ok' ? this.shape(row.value, depth + 1, region) : null, err: row.variant === 'err' ? this.shape(row.value, depth + 1, region) : null }; }
    if (value.tag === 'ref') { const record = this.row(value); if (!record.ty) throw new TypeError('generic record requires declared type metadata'); this.check(record.ty, value, depth + 1, region); return { kind: 'Known', ty: record.ty }; }
    const capture = value.tag === 'closure' ? this.core.closures.find(row => row.id === value.id)! : this.core.tasks.find(row => row.id === value.id)!;
    const code = this.program.codes.find(code => code.id === capture.code)!;
    return { kind: 'Known', ty: value.tag === 'closure' ? { t: 'Fn', params: code.params.map(param => instantiateMachineType(param.ty, capture.typeBindings)), returns: instantiateMachineType(code.returns, capture.typeBindings), capabilities: code.capabilities } : { t: 'Task', result: instantiateMachineType(code.returns, capture.typeBindings) } };
  }
  private mark(value: MachineValue, region: Set<string>, depth: number, seen = new Set<string>()): void {
    this.budget(depth); if (value.tag === 'ref') { const row = this.row(value); region.add(row.id); const key = `record:${row.id}`; if (seen.has(key)) return; seen.add(key); row.fields.forEach(([, item]) => this.mark(item, region, depth + 1, seen)); }
    else if (value.tag === 'sequence') { const key = `sequence:${value.id}`; if (seen.has(key)) return; seen.add(key); this.core.sequences.find(row => row.id === value.id)!.items.forEach(item => this.mark(item, region, depth + 1, seen)); }
    else if (value.tag === 'result') this.mark(this.core.results.find(row => row.id === value.id)!.value, region, depth + 1, seen);
    else if (value.tag === 'closure' || value.tag === 'task') { const key = `${value.tag}:${value.id}`; if (seen.has(key)) return; seen.add(key); const capture = value.tag === 'closure' ? this.core.closures.find(row => row.id === value.id)! : this.core.tasks.find(row => row.id === value.id)!; for (const scope of [...capture.scopes, capture.oldScope]) for (const [, child] of this.core.environments.find(row => row.id === scope)!.bindings) this.mark(child, region, depth + 1, seen);
      // A captured entry heap is retained whole in this reference profile. Its
      // conservative Owned region includes that heap, not just current links.
      for (const record of this.core.heaps.find(row => row.id === capture.oldHeap)!.records) { region.add(record.id); for (const [, child] of record.fields) this.mark(child, region, depth + 1, seen); } }
  }
  check(ty: Ty, value: MachineValue, depth = 0, region: Set<string> | null = null): void {
    this.budget(depth);
    if (ty.t === 'Nominal') { this.check(ty.repr, value, depth + 1, region); return; }
    if (ty.t === 'Owned') { const owned = region ?? new Set<string>(); if (!region) this.owned.push(owned); this.mark(value, owned, depth + 1); this.check(ty.inner, value, depth + 1, owned); return; }
    if (ty.t === 'TypeVar') {
      const prior = this.bindings.get(ty.name);
      if (prior?.kind === 'Known') { this.check(prior.ty, value, depth + 1, region); return; }
      const next = unify(prior ?? null, this.shape(value, depth + 1, region), this.infer)!; if (this.infer) this.bindings.set(ty.name, next); this.mark(value, region ?? this.borrowed, depth + 1); return;
    }
    if (ty.t === 'Int' || ty.t === 'IntN') { if (value.tag !== 'int') throw new TypeError('typed boundary expects Int'); if (ty.t === 'IntN') { const n = BigInt(value.value), min = ty.signed ? -(1n << BigInt(ty.bits - 1)) : 0n, max = ty.signed ? (1n << BigInt(ty.bits - 1)) - 1n : (1n << BigInt(ty.bits)) - 1n; if (n < min || n > max) throw new TypeError('typed fixed integer outside range'); } return; }
    if (ty.t === 'Bool' || ty.t === 'Str' || ty.t === 'Unit') { if (value.tag !== (ty.t === 'Bool' ? 'bool' : ty.t === 'Str' ? 'string' : 'null')) throw new TypeError(`typed boundary expects ${ty.t}`); return; }
    if (ty.t === 'Seq') { if (value.tag !== 'sequence') throw new TypeError('typed boundary expects Seq'); for (const item of this.core.sequences.find(row => row.id === value.id)!.items) this.check(ty.element, item, depth + 1, region); return; }
    if (ty.t === 'Result') { if (value.tag !== 'result') throw new TypeError('typed boundary expects Result'); const row = this.core.results.find(row => row.id === value.id)!; this.check(row.variant === 'ok' ? ty.ok : ty.err, row.value, depth + 1, region); return; }
    if (ty.t === 'Record') {
      const row = this.row(value); (region ?? this.borrowed).add(row.id); const key = `${row.id}:${JSON.stringify(ty)}:${region === null ? 'borrowed' : this.owned.indexOf(region)}`; if (this.seen.has(key)) return; this.seen.add(key);
      for (const [name, type] of ty.fields) { const field = row.fields.find(([field]) => field === name); if (!field) throw new TypeError('missing typed record field'); this.check(type, field[1], depth + 1, region); }
      for (const [name, child] of row.fields) if (!ty.fields.some(([field]) => field === name)) this.mark(child, region ?? this.borrowed, depth + 1); return;
    }
    if (ty.t === 'Fn' || ty.t === 'Task') {
      if (value.tag !== (ty.t === 'Fn' ? 'closure' : 'task')) throw new TypeError('typed executable value mismatch'); const actual = this.shape(value, depth + 1, region); if (actual.kind !== 'Known') throw new TypeError('missing executable signature');
      const expected = instantiateMachineType(ty, [...this.bindings]); if (!tyEqual(expected, actual.ty)) throw new TypeError('typed closure/task signature mismatch'); this.mark(value, region ?? this.borrowed, depth + 1); return;
    }
    throw new TypeError('unsupported typed boundary');
  }
  finish(): void { const seen = new Set<string>(); for (const region of this.owned) for (const id of region) { if (seen.has(id) || this.borrowed.has(id)) throw new TypeError('Owned reachable regions overlap'); seen.add(id); } }
}
export function validateMachineArguments(code: ResumableCode, args: readonly MachineValue[], core: MachineCore, program: ResumableProgram, initial: MachineTypeBindings = []): MachineTypeBindings {
  if (args.length !== code.params.length) throw new TypeError('typed argument arity mismatch'); code.params.forEach(param => validateMachineType(param.ty)); validateMachineType(code.returns);
  const validator = new Validator(core, program, initial, true); code.params.forEach((param, index) => validator.check(param.ty, args[index])); validator.finish(); return [...validator.bindings].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
export function validateMachineResult(ty: Ty, value: MachineValue, core: MachineCore, program: ResumableProgram, bindings: MachineTypeBindings = []): void { validateMachineType(ty); const validator = new Validator(core, program, bindings, false); validator.check(ty, value); validator.finish(); }
