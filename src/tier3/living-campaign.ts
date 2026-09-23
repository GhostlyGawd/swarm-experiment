/** FR-3.3, bounded cooperative profile. Actor steps execute real Aether calls
 * against a shared heap; scheduling boundaries are calls, not VM instructions.
 * Network queues and allocation pressure are isolated, materialized host models.
 * No live effects, native-thread/rack failure, or unbounded coverage is claimed.
 * Admission is evidence about exactly the declared campaign, never production
 * deployment authority or proof of correctness outside that campaign. */
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import type { Term, Ty } from '../tier1/ast.ts';
import type { NodeRef, SymbolId } from '../tier1/ids.ts';
import { GraphStore } from '../tier1/store.ts';
import { typecheck, underlying, tyEqual } from '../tier2/typecheck.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { Runtime } from './runtime.ts';
import type { RuntimeEffectRouter } from './effects.ts';
import type { Value, Ref } from './values.ts';
import { rng } from '../util/rng.ts';

export const LIVING_CAMPAIGN_PROFILE = 'aether.living-cooperative-campaign/1' as const;
export type CampaignScalar = { readonly tag: 'int'; readonly value: string } | { readonly tag: 'bool'; readonly value: boolean } | { readonly tag: 'string'; readonly value: string } | { readonly tag: 'null' };
export type CampaignInput = CampaignScalar | { readonly tag: 'record'; readonly name: string } | { readonly tag: 'variable'; readonly name: string } | { readonly tag: 'slot'; readonly actor: string; readonly step: string };
export interface CampaignEvent { readonly order: number; readonly sequence: number; readonly allocation: number; readonly checksum: number }
export type CampaignStep =
  | { readonly kind: 'call'; readonly id: string; readonly symbol: SymbolId; readonly args: readonly CampaignInput[]; readonly expect: CampaignInput | null }
  | { readonly kind: 'reserve'; readonly id: string; readonly bytes: number; readonly expect: 'allocated' | 'exhausted' }
  | { readonly kind: 'release'; readonly id: string; readonly reservation: string }
  | { readonly kind: 'send'; readonly id: string; readonly event: CampaignEvent; readonly mutation: 'none' | 'checksum' | 'malformed' | 'drop' | 'duplicate' }
  | { readonly kind: 'deliver'; readonly id: string; readonly symbol: SymbolId; readonly prefix: readonly CampaignInput[]; readonly expect: CampaignInput | null; readonly ingress: 'delivered' | 'malformed' | 'empty' };
export interface CampaignScenario {
  readonly id: string; readonly kind: 'scheduler' | 'resource' | 'network' | 'event-order';
  readonly scheduling: { readonly mode: 'enumerate' | 'seeded'; readonly cases: number };
  readonly variables: readonly { readonly name: string; readonly minimum: number; readonly maximum: number }[];
  readonly records: readonly { readonly name: string; readonly ty: Ty; readonly fields: Readonly<Record<string, CampaignScalar>> }[];
  readonly actors: readonly { readonly id: string; readonly steps: readonly CampaignStep[] }[];
  readonly checks: readonly Extract<CampaignStep, { kind: 'call' }>[];
  readonly requiredCoverage: readonly string[];
  readonly allocationLimitBytes: number;
}
export interface LivingCampaignManifest {
  readonly format: typeof LIVING_CAMPAIGN_PROFILE; readonly candidateRoot: NodeRef; readonly seed: string;
  readonly maxStepsPerCall: number; readonly shrinkAttempts: number;
  readonly scenarios: readonly CampaignScenario[];
}
export interface LivingCase {
  readonly format: 'aether.living-case/1'; readonly manifestDigest: Digest; readonly scenario: string;
  readonly ordinal: number; readonly seed: string; readonly schedule: readonly string[];
  readonly variables: Readonly<Record<string, number>>;
}
export interface LivingCaseResult {
  readonly caseDigest: Digest; readonly passed: boolean; readonly failure: { readonly property: string; readonly detail: string } | null;
  readonly filtered: boolean; readonly calls: number; readonly steps: number; readonly evaluatedOperations: number;
  readonly allocatedBytes: number; readonly peakAllocatedBytes: number; readonly allocationChecksum: number;
  readonly networkFrames: number; readonly deliveredFrames: number; readonly rejectedFrames: number; readonly droppedFrames: number;
  readonly coverage: readonly string[]; readonly trace: readonly string[]; readonly heapDigest: Digest;
}
export interface LivingCounterexample {
  readonly format: 'aether.living-counterexample/1'; readonly manifest: LivingCampaignManifest;
  readonly original: LivingCase; readonly originalResult: LivingCaseResult;
  readonly shrunk: LivingCase; readonly shrunkResult: LivingCaseResult;
  readonly shrinkAttempts: number; readonly reductions: number; readonly shrinkLimitReached: boolean;
}
export interface LivingCampaignReport {
  readonly format: 'aether.living-campaign-report/1'; readonly manifestDigest: Digest; readonly candidateRoot: NodeRef;
  readonly declared: number; readonly generated: number; readonly executed: number; readonly filtered: number;
  readonly passed: number; readonly failed: number; readonly survival: string; readonly accepted: boolean;
  readonly missingCoverage: readonly string[]; readonly cases: readonly { readonly input: LivingCase; readonly result: LivingCaseResult }[];
  readonly counterexamples: readonly Digest[]; readonly elapsedMs: string; readonly executedCasesPerSecond: string;
  readonly evaluatedOperations: number; readonly evaluatedOperationsPerSecond: string;
  readonly productionAuthorized: false;
}
const limits = { maxFrameBytes: 32 * 1024 * 1024, maxDecompressedBytes: 32 * 1024 * 1024, maxObjects: 1_000_000 };
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, limits), limits) as T;
const digest = (domain: string, value: unknown): Digest => domainDigest(domain, value, limits);
const caseDigest = (value: LivingCase): Digest => digest('aether.living-case/1', value);
const scalar = (value: unknown): CampaignScalar => {
  const candidate = value as CampaignScalar;
  if (!candidate || typeof candidate !== 'object') throw new TypeError('campaign scalar required');
  exactObject(candidate, candidate.tag === 'null' ? ['tag'] : ['tag', 'value']);
  if (candidate.tag === 'int') decimal(candidate.value, undefined, true);
  else if (candidate.tag === 'bool') { if (typeof candidate.value !== 'boolean') throw new TypeError('campaign Boolean required'); }
  else if (candidate.tag === 'string') { if (typeof candidate.value !== 'string') throw new TypeError('campaign string required'); }
  else if (candidate.tag !== 'null') throw new TypeError('unsupported campaign scalar');
  return candidate;
};
const fromScalar = (value: CampaignScalar): Value => value.tag === 'int' ? BigInt(value.value) : value.tag === 'null' ? null : value.value;
const toScalar = (value: Value): CampaignScalar => {
  if (typeof value === 'bigint') return { tag: 'int', value: String(value) };
  if (typeof value === 'boolean') return { tag: 'bool', value };
  if (typeof value === 'string') return { tag: 'string', value };
  if (value === null) return { tag: 'null' };
  throw new TypeError('opaque/non-scalar campaign result is outside this profile');
};
const name = (value: string): void => { identifier(value); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new TypeError('campaign name must be delimiter-free'); };
const bounded = (value: number, min: number, max: number): void => { if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError('campaign profile bound'); };
function event(value: unknown): CampaignEvent {
  const row = exactObject(value, ['order', 'sequence', 'allocation', 'checksum']) as unknown as CampaignEvent;
  bounded(row.order, 0, 23); bounded(row.sequence, 0, 0x7fffffff); bounded(row.allocation, 0, 4096); bounded(row.checksum, 0, 255); return row;
}
/** No ambient adapter and no v1 implicit successful Unit effect. */
const denyEffects: RuntimeEffectRouter = { mode: 'shadow', bind() {}, invoke() { throw new Error('campaign live/opaque effects are unsupported'); }, fork() { return denyEffects; } };
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensureDirectory(path: string): void {
  const target = resolve(path); if (existsSync(target)) return;
  ensureDirectory(dirname(target)); try { mkdirSync(target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  syncDirectory(target); syncDirectory(dirname(target));
}
/** Complete immutable bytes become visible atomically, then the directory is
 * synced. An interrupted run has no report/admission receipt; retries are safe. */
function persist(directory: string, domain: string, value: unknown): Digest {
  ensureDirectory(directory); const id = digest(domain, value), path = join(directory, `${id.split(':').at(-1)}.json`), bytes = encodeCanonical(value, limits);
  if (existsSync(path)) { if (!readFileSync(path).equals(Buffer.from(bytes))) throw new Error('campaign artifact collision/corruption'); return id; }
  const temp = join(directory, `.tmp-${process.pid}-${randomUUID()}`), fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temp, path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (!readFileSync(path).equals(Buffer.from(bytes))) throw new Error('campaign artifact collision/corruption');
    syncDirectory(directory);
  } finally { unlinkSync(temp); }
  return id;
}

function schedules(scenario: CampaignScenario, seed: string): string[][] {
  const lengths = scenario.actors.map(actor => actor.steps.length), total = lengths.reduce((a, b) => a + b, 0), output: string[][] = [];
  if (scenario.scheduling.mode === 'enumerate') {
    const walk = (prefix: string[], positions: number[]): void => {
      if (output.length > scenario.scheduling.cases) throw new RangeError('declared enumeration does not cover all schedules');
      if (prefix.length === total) { output.push(prefix); return; }
      scenario.actors.forEach((actor, index) => { if (positions[index] < lengths[index]) { const next = [...positions]; next[index]++; walk([...prefix, actor.id], next); } });
    };
    walk([], lengths.map(() => 0));
    if (output.length !== scenario.scheduling.cases) throw new RangeError('declared schedule count must exactly match complete enumeration');
  } else {
    for (let ordinal = 0; ordinal < scenario.scheduling.cases; ordinal++) {
      const random = rng(`${seed}/${scenario.id}/${ordinal}/schedule`), positions = lengths.map(() => 0), schedule: string[] = [];
      while (schedule.length < total) { const eligible = lengths.map((length, i) => i).filter(i => positions[i] < lengths[i]), choice = random.pick(eligible); positions[choice]++; schedule.push(scenario.actors[choice].id); }
      output.push(schedule);
    }
  }
  return output;
}

export class LivingCampaign {
  private readonly manifest: LivingCampaignManifest;
  private readonly manifestId: Digest;
  private readonly module: Term;
  private readonly registry: CapabilityRegistry;
  private readonly directory: string;
  private readonly declarations: Map<SymbolId, Extract<Term, { kind: 'FunctionDecl' }>>;
  private readonly acceptedReports = new WeakMap<object, Digest>();
  constructor(options: { manifest: LivingCampaignManifest; module: Term; registry: CapabilityRegistry; directory: string }) {
    this.manifest = clone(options.manifest); this.registry = options.registry; this.directory = resolve(options.directory);
    const store = new GraphStore(), root = store.intern(options.module); this.module = store.hydrate(root);
    if (root !== this.manifest.candidateRoot) throw new TypeError('campaign candidate root mismatch');
    if (this.module.kind !== 'Module') throw new TypeError('campaign requires complete module');
    if (!typecheck(this.module, { registry: this.registry }).ok) throw new TypeError('campaign candidate fails static type checking');
    this.declarations = new Map(this.module.members.filter((node): node is Extract<Term, { kind: 'FunctionDecl' }> => node.kind === 'FunctionDecl').map(node => [node.symbol, node]));
    this.validateManifest(); this.manifestId = digest(LIVING_CAMPAIGN_PROFILE, this.manifest);
    persist(join(this.directory, 'manifests'), LIVING_CAMPAIGN_PROFILE, this.manifest);
  }
  private validateManifest(): void {
    const m = this.manifest; exactObject(m, ['format', 'candidateRoot', 'seed', 'maxStepsPerCall', 'shrinkAttempts', 'scenarios']);
    if (m.format !== LIVING_CAMPAIGN_PROFILE) throw new TypeError('unsupported campaign profile'); identifier(m.seed);
    bounded(m.maxStepsPerCall, 1, 100_000); bounded(m.shrinkAttempts, 0, 256); bounded(m.scenarios.length, 1, 64);
    const ids = new Set<string>(); let declared = 0;
    for (const scenario of m.scenarios) {
      exactObject(scenario, ['id', 'kind', 'scheduling', 'variables', 'records', 'actors', 'checks', 'requiredCoverage', 'allocationLimitBytes']); name(scenario.id);
      if (ids.has(scenario.id)) throw new TypeError('duplicate scenario'); ids.add(scenario.id);
      if (!['scheduler', 'resource', 'network', 'event-order'].includes(scenario.kind)) throw new TypeError('unknown campaign scenario');
      exactObject(scenario.scheduling, ['mode', 'cases']); if (!['enumerate', 'seeded'].includes(scenario.scheduling.mode)) throw new TypeError('unknown schedule mode');
      bounded(scenario.scheduling.cases, 1, 10_000); declared += scenario.scheduling.cases;
      bounded(scenario.allocationLimitBytes, 0, 16 * 1024 * 1024); bounded(scenario.actors.length, 1, 8); bounded(scenario.checks.length, 1, 64);
      const actors = new Set<string>(), variables = new Set<string>(), records = new Set<string>();
      for (const variable of scenario.variables) { exactObject(variable, ['name', 'minimum', 'maximum']); name(variable.name); if (variables.has(variable.name)) throw new TypeError('duplicate variable'); variables.add(variable.name); bounded(variable.minimum, -1_000_000, 1_000_000); bounded(variable.maximum, variable.minimum, 1_000_000); }
      for (const record of scenario.records) {
        exactObject(record, ['name', 'ty', 'fields']); name(record.name); if (records.has(record.name)) throw new TypeError('duplicate record'); records.add(record.name);
        const ty = underlying(record.ty); if (ty.t !== 'Record') throw new TypeError('campaign setup requires record type'); exactObject(record.fields, ty.fields.map(([name]) => name));
        for (const [field, type] of ty.fields) this.checkType(type, fromScalar(scalar(record.fields[field])), new Map());
      }
      const checkInput = (input: CampaignInput): void => {
        if (input.tag === 'record') { exactObject(input, ['tag', 'name']); if (!records.has(input.name)) throw new TypeError('unknown record'); }
        else if (input.tag === 'variable') { exactObject(input, ['tag', 'name']); if (!variables.has(input.name)) throw new TypeError('unknown campaign variable'); }
        else if (input.tag === 'slot') { exactObject(input, ['tag', 'actor', 'step']); name(input.actor); name(input.step); }
        else scalar(input);
      };
      const all: CampaignStep[] = [];
      for (const actor of scenario.actors) { exactObject(actor, ['id', 'steps']); name(actor.id); if (actors.has(actor.id) || actor.id === '$checks') throw new TypeError('duplicate/reserved actor'); actors.add(actor.id); bounded(actor.steps.length, 1, 64); const names = new Set<string>(); for (const step of actor.steps) { if (names.has(step.id)) throw new TypeError('duplicate actor step'); names.add(step.id); all.push(step); } }
      const checks = new Set<string>(); for (const check of scenario.checks) { if (check.kind !== 'call' || check.expect === null || checks.has(check.id)) throw new TypeError('final checks require unique explicit assertions'); checks.add(check.id); all.push(check); }
      for (const step of all) {
        name(step.id);
        switch (step.kind) {
          case 'call': case 'deliver': {
            exactObject(step, step.kind === 'call' ? ['kind', 'id', 'symbol', 'args', 'expect'] : ['kind', 'id', 'symbol', 'prefix', 'expect', 'ingress']);
            const decl = this.declarations.get(step.symbol); if (!decl || decl.typeParams.length) throw new TypeError('unknown/generic campaign entry');
            const args = step.kind === 'call' ? step.args : step.prefix;
            if (args.length + (step.kind === 'deliver' ? 4 : 0) !== decl.params.length) throw new TypeError('campaign call arity mismatch'); args.forEach(checkInput); if (step.expect !== null) checkInput(step.expect);
            if (step.kind === 'deliver' && !['delivered', 'malformed', 'empty'].includes(step.ingress)) throw new TypeError('unknown ingress expectation'); break;
          }
          case 'reserve': exactObject(step, ['kind', 'id', 'bytes', 'expect']); bounded(step.bytes, 0, 16 * 1024 * 1024); if (!['allocated', 'exhausted'].includes(step.expect)) throw new TypeError('allocation expectation required'); break;
          case 'release': exactObject(step, ['kind', 'id', 'reservation']); name(step.reservation); break;
          case 'send': exactObject(step, ['kind', 'id', 'event', 'mutation']); event(step.event); if (!['none', 'checksum', 'malformed', 'drop', 'duplicate'].includes(step.mutation)) throw new TypeError('unknown frame mutation'); break;
          default: throw new TypeError('unsupported campaign step');
        }
      }
      if (scenario.kind === 'scheduler' && scenario.actors.length < 2) throw new TypeError('scheduler scenario requires multiple actors');
      if (scenario.kind === 'resource' && !all.some(step => step.kind === 'reserve')) throw new TypeError('resource scenario requires materialized allocations');
      if (['network', 'event-order'].includes(scenario.kind) && (!all.some(step => step.kind === 'send') || !all.some(step => step.kind === 'deliver'))) throw new TypeError('network/event scenario requires sends and deliveries');
      if (!scenario.requiredCoverage.length || new Set(scenario.requiredCoverage).size !== scenario.requiredCoverage.length) throw new TypeError('explicit unique coverage obligations required'); scenario.requiredCoverage.forEach(identifier);
      schedules(scenario, m.seed); // Exact enumeration count, never silently truncated.
    }
    bounded(declared, 1, 10_000);
  }
  private checkType(ty: Ty, value: Value, records: ReadonlyMap<number, Ty>): void {
    const type = underlying(ty);
    if (type.t === 'Int' && typeof value === 'bigint' || type.t === 'Bool' && typeof value === 'boolean' || type.t === 'Str' && typeof value === 'string' || type.t === 'Unit' && value === null) return;
    if (type.t === 'Record' && value && typeof value === 'object' && 'addr' in value && records.has(value.addr) && tyEqual(ty, records.get(value.addr)!)) return;
    throw new TypeError('campaign boundary type mismatch or unsupported opaque type');
  }
  generate(): readonly LivingCase[] {
    return this.manifest.scenarios.flatMap(scenario => schedules(scenario, this.manifest.seed).map((schedule, ordinal) => {
      const seed = `${this.manifest.seed}/${scenario.id}/${ordinal}`, random = rng(`${seed}/inputs`);
      return { format: 'aether.living-case/1' as const, manifestDigest: this.manifestId, scenario: scenario.id, ordinal, seed, schedule,
        variables: Object.fromEntries(scenario.variables.map(variable => [variable.name, ordinal === 0 ? variable.minimum : ordinal === 1 ? variable.maximum : random.int(variable.minimum, variable.maximum)])) };
    }));
  }
  execute(input: LivingCase): LivingCaseResult {
    const value = clone(input); exactObject(value, ['format', 'manifestDigest', 'scenario', 'ordinal', 'seed', 'schedule', 'variables']);
    if (value.format !== 'aether.living-case/1' || value.manifestDigest !== this.manifestId) throw new TypeError('case manifest mismatch');
    const scenario = this.manifest.scenarios.find(item => item.id === value.scenario); if (!scenario) throw new TypeError('unknown scenario');
    bounded(value.ordinal, 0, scenario.scheduling.cases - 1); if (value.seed !== `${this.manifest.seed}/${scenario.id}/${value.ordinal}`) throw new TypeError('case seed mismatch');
    exactObject(value.variables, scenario.variables.map(item => item.name)); for (const variable of scenario.variables) bounded(value.variables[variable.name], variable.minimum, variable.maximum);
    const positions = new Map(scenario.actors.map(actor => [actor.id, 0]));
    for (const actor of value.schedule) { if (!positions.has(actor)) throw new TypeError('unknown scheduled actor'); positions.set(actor, positions.get(actor)! + 1); }
    if (scenario.actors.some(actor => positions.get(actor.id) !== actor.steps.length)) throw new TypeError('case omits or duplicates actor operations');
    const runtime = new Runtime({ registry: this.registry, maxSteps: this.manifest.maxStepsPerCall, trace: true, effectRouter: denyEffects }).load(this.module);
    const references = new Map<string, Ref>(), types = new Map<number, Ty>(), slots = new Map<string, Value>(), reservations = new Map<string, Uint8Array>();
    for (const record of scenario.records) { const ref = runtime.allocateRecord(record.ty, Object.fromEntries(Object.entries(record.fields).map(([name, field]) => [name, fromScalar(field)]))); references.set(record.name, ref); types.set(ref.addr, record.ty); }
    let calls = 0, evaluatedOperations = 0, allocatedBytes = 0, peakAllocatedBytes = 0, allocationChecksum = 0, networkFrames = 0, deliveredFrames = 0, rejectedFrames = 0, droppedFrames = 0, filtered = false;
    let failure: LivingCaseResult['failure'] = null;
    const trace: string[] = [], coverage = new Set<string>(), queue: string[] = [];
    const slot = (actor: string, step: string): string => JSON.stringify([actor, step]);
    const evaluate = (argument: CampaignInput): Value => {
      if (argument.tag === 'record') return references.get(argument.name)!;
      if (argument.tag === 'variable') return BigInt(value.variables[argument.name]);
      if (argument.tag === 'slot') { const key = slot(argument.actor, argument.step); if (!slots.has(key)) throw new TypeError('unavailable actor result'); return slots.get(key)!; }
      return fromScalar(argument);
    };
    const fail = (property: string, detail: string): void => { failure ??= { property, detail }; };
    const call = (actor: string, step: Extract<CampaignStep, { kind: 'call' | 'deliver' }>, args: Value[]): void => {
      const declaration = this.declarations.get(step.symbol)!;
      args.forEach((arg, index) => this.checkType(declaration.params[index].ty, arg, types)); calls++;
      const result = runtime.call(step.symbol, args);
      if (!result.ok) { filtered ||= result.fault.kind === 'precondition'; fail(`${actor}/${step.id}/fault:${result.fault.kind}`, result.fault.message); return; }
      this.checkType(declaration.returns, result.value, types); toScalar(result.value); slots.set(slot(actor, step.id), result.value);
      if (step.expect !== null && digest('aether.campaign-scalar/1', toScalar(result.value)) !== digest('aether.campaign-scalar/1', toScalar(evaluate(step.expect)))) fail(`${actor}/${step.id}/assertion`, 'candidate result differs from declared oracle');
      coverage.add('candidate-call');
    };
    const executeStep = (actor: string, step: CampaignStep): void => {
      evaluatedOperations++; trace.push(`${actor}/${step.id}`); coverage.add(`step:${actor}/${step.id}`);
      try {
        switch (step.kind) {
          case 'call': call(actor, step, step.args.map(evaluate)); break;
          case 'reserve': {
            const allocated = allocatedBytes + step.bytes <= scenario.allocationLimitBytes;
            if (allocated) { const bytes = new Uint8Array(step.bytes); bytes.fill((value.ordinal * 31 + 17) & 255); for (const byte of bytes) allocationChecksum = (allocationChecksum + byte) >>> 0; reservations.set(slot(actor, step.id), bytes); allocatedBytes += bytes.byteLength; peakAllocatedBytes = Math.max(peakAllocatedBytes, allocatedBytes); }
            const outcome = allocated ? 'allocated' : 'exhausted'; coverage.add(`resource:${outcome}`); slots.set(slot(actor, step.id), allocated);
            if (outcome !== step.expect) fail(`${actor}/${step.id}/resource`, `expected ${step.expect}, observed ${outcome}`); break;
          }
          case 'release': { const key = slot(actor, step.reservation), bytes = reservations.get(key); if (!bytes) throw new TypeError('release has no live reservation'); allocatedBytes -= bytes.byteLength; reservations.delete(key); coverage.add('resource:released'); break; }
          case 'send': {
            let frame = JSON.stringify(step.event); networkFrames++; coverage.add(`network:${step.mutation}`);
            if (step.mutation === 'checksum') { const payload = JSON.parse(frame) as CampaignEvent; frame = JSON.stringify({ ...payload, checksum: payload.checksum ^ 255 }); }
            if (step.mutation === 'malformed') frame = frame.slice(0, -1);
            if (step.mutation === 'drop') droppedFrames++;
            else { queue.push(frame); if (step.mutation === 'duplicate') { queue.push(frame); networkFrames++; } } break;
          }
          case 'deliver': {
            const frame = queue.shift(); let parsed: CampaignEvent | null = null;
            if (frame !== undefined) { try { parsed = event(JSON.parse(frame)); } catch { rejectedFrames++; } }
            const outcome = frame === undefined ? 'empty' : parsed === null ? 'malformed' : 'delivered'; coverage.add(`ingress:${outcome}`);
            if (outcome !== step.ingress) fail(`${actor}/${step.id}/ingress`, `expected ${step.ingress}, observed ${outcome}`);
            if (parsed) { deliveredFrames++; coverage.add(parsed.order === 0 ? 'event:ordered' : 'event:reordered'); coverage.add(parsed.sequence % 7 === 0 ? 'event:gap-boundary' : 'event:sequence'); call(actor, step, [...step.prefix.map(evaluate), BigInt(parsed.order), BigInt(parsed.sequence), BigInt(parsed.allocation), BigInt(parsed.checksum)]); } break;
          }
        }
      } catch (e) { fail(`${actor}/${step.id}/harness`, e instanceof Error ? e.message : String(e)); }
    };
    positions.forEach((_, key) => positions.set(key, 0)); let previous: string | null = null;
    for (const actorId of value.schedule) {
      const actor = scenario.actors.find(item => item.id === actorId)!, index = positions.get(actorId)!;
      if (previous !== null && previous !== actorId) coverage.add('scheduler:switched'); previous = actorId;
      executeStep(actorId, actor.steps[index]); positions.set(actorId, index + 1);
      if (failure) break;
    }
    if (!failure) for (const check of scenario.checks) { executeStep('$checks', check); if (failure) break; }
    for (const observed of runtime.trace) coverage.add(`runtime:${observed.kind}`);
    if (!failure && queue.length) fail('network/undelivered', `${queue.length} materialized frames remain undelivered`);
    return { caseDigest: caseDigest(value), passed: failure === null, failure, filtered, calls, steps: runtime.steps, evaluatedOperations, allocatedBytes, peakAllocatedBytes, allocationChecksum,
      networkFrames, deliveredFrames, rejectedFrames, droppedFrames, coverage: [...coverage].sort(), trace, heapDigest: digest('aether.living-heap/1', runtime.inspect().heap) };
  }
  private shrink(original: LivingCase, originalResult: LivingCaseResult): LivingCounterexample {
    let shrunk = original, shrunkResult = originalResult, attempts = 0, reductions = 0, changed = true;
    const scenario = this.manifest.scenarios.find(item => item.id === original.scenario)!;
    while (changed && attempts < this.manifest.shrinkAttempts) {
      changed = false; const candidates: LivingCase[] = [];
      for (const variable of scenario.variables) {
        const current = shrunk.variables[variable.name], target = Math.min(variable.maximum, Math.max(variable.minimum, 0));
        for (const next of [target, Math.trunc((current + target) / 2)]) if (next !== current && Math.abs(next - target) < Math.abs(current - target)) candidates.push({ ...shrunk, variables: { ...shrunk.variables, [variable.name]: next } });
      }
      // Bubble toward canonical actor order, preserving every actor operation.
      for (let index = 1; index < shrunk.schedule.length; index++) if (shrunk.schedule[index - 1] > shrunk.schedule[index]) { const schedule = [...shrunk.schedule]; [schedule[index - 1], schedule[index]] = [schedule[index], schedule[index - 1]]; candidates.push({ ...shrunk, schedule }); }
      for (const candidate of candidates) {
        if (attempts >= this.manifest.shrinkAttempts) break; attempts++;
        const result = this.execute(candidate);
        if (!result.passed && result.failure!.property === originalResult.failure!.property && result.filtered === originalResult.filtered) { shrunk = candidate; shrunkResult = result; reductions++; changed = true; break; }
      }
    }
    return { format: 'aether.living-counterexample/1', manifest: this.manifest, original, originalResult, shrunk, shrunkResult, shrinkAttempts: attempts, reductions, shrinkLimitReached: attempts === this.manifest.shrinkAttempts };
  }
  run(): LivingCampaignReport {
    const started = performance.now(), generated = this.generate(), cases: { input: LivingCase; result: LivingCaseResult }[] = [], counterexamples: Digest[] = [];
    for (const input of generated) {
      const result = this.execute(input); cases.push({ input, result });
      persist(join(this.directory, 'cases'), 'aether.living-case-evidence/1', { input, result });
      if (!result.passed) counterexamples.push(persist(join(this.directory, 'counterexamples'), 'aether.living-counterexample/1', this.shrink(input, result)));
    }
    const missingCoverage = this.manifest.scenarios.flatMap(scenario => {
      const covered = new Set(cases.filter(item => item.input.scenario === scenario.id).flatMap(item => item.result.coverage));
      return scenario.requiredCoverage.filter(label => !covered.has(label)).map(label => `${scenario.id}/${label}`);
    });
    const declared = this.manifest.scenarios.reduce((sum, item) => sum + item.scheduling.cases, 0), passed = cases.filter(item => item.result.passed).length, filtered = cases.filter(item => item.result.filtered).length;
    const elapsedMs = performance.now() - started, evaluatedOperations = cases.reduce((sum, item) => sum + item.result.evaluatedOperations, 0);
    const report: LivingCampaignReport = { format: 'aether.living-campaign-report/1', manifestDigest: this.manifestId, candidateRoot: this.manifest.candidateRoot,
      declared, generated: generated.length, executed: cases.length, filtered, passed, failed: cases.length - passed, survival: String(passed / declared),
      accepted: passed === declared && cases.length === declared && filtered === 0 && missingCoverage.length === 0, missingCoverage, cases, counterexamples, elapsedMs: String(elapsedMs),
      executedCasesPerSecond: String(cases.length / (elapsedMs / 1000)), evaluatedOperations, evaluatedOperationsPerSecond: String(evaluatedOperations / (elapsedMs / 1000)), productionAuthorized: false };
    const id = persist(join(this.directory, 'reports'), 'aether.living-campaign-report/1', report); this.acceptedReports.set(report, id); return report;
  }
  /** Only an unmodified report from this executor can be admitted. Durable JSON
   * is audit data; a new process must replay, not promote supplied success bits. */
  admit(report: LivingCampaignReport): { readonly manifestDigest: Digest; readonly reportDigest: Digest; readonly productionAuthorized: false } {
    const stamp = this.acceptedReports.get(report);
    if (!stamp || stamp !== digest('aether.living-campaign-report/1', report) || !report.accepted || report.survival !== '1' || report.filtered !== 0 || report.executed !== report.declared || report.generated !== report.declared || report.missingCoverage.length) throw new Error('campaign admission requires complete, unmodified 100% survival evidence');
    return { manifestDigest: this.manifestId, reportDigest: stamp, productionAuthorized: false };
  }
  replayCounterexample(id: Digest): LivingCounterexample {
    validateDigest(id, 'aether.living-counterexample/1');
    const value = decodeCanonical(readFileSync(join(this.directory, 'counterexamples', `${id.split(':').at(-1)}.json`)), limits) as unknown as LivingCounterexample;
    exactObject(value, ['format', 'manifest', 'original', 'originalResult', 'shrunk', 'shrunkResult', 'shrinkAttempts', 'reductions', 'shrinkLimitReached']);
    if (value.format !== 'aether.living-counterexample/1' || digest('aether.living-counterexample/1', value) !== id || digest(LIVING_CAMPAIGN_PROFILE, value.manifest) !== this.manifestId) throw new TypeError('counterexample manifest/digest mismatch');
    for (const [input, result] of [[value.original, value.originalResult], [value.shrunk, value.shrunkResult]] as const) {
      if (result.passed || digest('aether.living-case-result/1', this.execute(input)) !== digest('aether.living-case-result/1', result)) throw new Error('counterexample does not replay exactly');
    }
    if (value.originalResult.failure!.property !== value.shrunkResult.failure!.property) throw new Error('shrinker changed failure property'); return value;
  }
}

/** R04 fixed event profile. This measures concrete JSON/object generation,
 * serialization, parse, guard evaluation and coverage checksum. It intentionally
 * does not time Aether execution, durable receipts or distributed scheduling. */
export interface R04JsonObservation { readonly trial: number; readonly warmup: boolean; readonly elapsedNs: string; readonly inputsPerSecond: number; readonly checksum: number }
export function measureR04JsonEvents(onObservation?: (sample: R04JsonObservation) => void): {
  format: 'aether.r04-json-event-measurement/1'; minimumPerSecond: 2000000; warmups: number; inputsPerTrial: number;
  warmup: { elapsedNs: string; inputsPerSecond: number; checksum: number };
  samples: { trial: number; generated: number; executed: number; filtered: number; elapsedNs: string; inputsPerSecond: number; checksum: number; pass: boolean }[];
  pass: boolean;
} {
  const samples: ReturnType<typeof measureR04JsonEvents>['samples'] = []; let warmup!: ReturnType<typeof measureR04JsonEvents>['warmup'];
  for (let trial = -1; trial < 5; trial++) {
    let checksum = 0; const started = process.hrtime.bigint();
    for (let index = 0; index < 20_000; index++) {
      const frame = JSON.stringify({ order: index % 24, sequence: index, allocation: (index * 31) % 4097, checksum: (index * 17) % 256 });
      const input = JSON.parse(frame) as CampaignEvent;
      const coverage = Number(input.order !== 0) + Number(input.sequence % 7 === 0) * 2 + Number(input.allocation > 4095) * 4 + Number(input.checksum === 255) * 8;
      checksum = (checksum + coverage) >>> 0;
    }
    const elapsed = process.hrtime.bigint() - started, inputsPerSecond = 20_000 / (Number(elapsed) / 1e9), observation = { elapsedNs: String(elapsed), inputsPerSecond, checksum };
    if (trial < 0) warmup = observation;
    else samples.push({ trial, generated: 20_000, executed: 20_000, filtered: 0, ...observation, pass: inputsPerSecond >= 2_000_000 });
    onObservation?.({ trial, warmup: trial < 0, ...observation });
  }
  return { format: 'aether.r04-json-event-measurement/1', minimumPerSecond: 2_000_000, warmups: 1, inputsPerTrial: 20_000, warmup, samples, pass: samples.every(sample => sample.pass) };
}
