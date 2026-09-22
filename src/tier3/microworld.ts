/**
 * Living micro-world simulators (FR-3.2).
 *
 * Every module carries a deterministic, property-based simulator instead of a
 * set of mocks. The difference is not stylistic. A mock encodes what the author
 * expected a collaborator to do; a micro-world encodes what must remain true
 * whatever it does, and then attacks that claim.
 *
 * The properties checked are not written by hand — they are read off the code:
 *
 *   • **Contract compliance.** Preconditions filter the generated inputs;
 *     postconditions become the properties. A clause marked `property` by the
 *     tiered-rigor rule (Risk R1) is discharged *here* rather than by the
 *     solver, which is what makes that rule an actual division of labour.
 *   • **Frame compliance.** Nothing outside `modifies` may change. This catches
 *     the class of bug where the maths is right and a neighbouring field was
 *     clobbered on the way.
 *   • **Determinism.** The same inputs must give the same outputs and the same
 *     effects (NFR 6.2). Violations here mean a hidden channel into the code.
 *   • **Absence of internal faults.** A type error or division by zero is never
 *     an acceptable outcome, whatever the input.
 *   • **Adversarial schedules.** Two concurrent invocations against shared
 *     records, resolved last-writer-wins, must not destroy a module invariant.
 *   • **Effect outages.** Every capability is failed in turn, and the code must
 *     not leave the heap violating its own invariants.
 *
 * A candidate patch is accepted only at 100% compliance. Anything less is
 * reported with a *shrunk* counterexample, because `amount = -1` tells an agent
 * what is wrong and `amount = -8443113199` does not.
 */

import type { Term } from '../tier1/ast.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { rng } from '../util/rng.ts';
import {
  formatPlain,
  generateCase,
  materialise,
  shrinkPlain,
  type GenerationOptions,
  type Plain,
} from './generate.ts';
import { Runtime, type Fault, type RuntimeOptions } from './runtime.ts';
import { isRef, type Value } from './values.ts';
import { blake3 } from '../tier1/blake3.ts';
import { canonicalBytes } from '../tier1/canonical.ts';
import { bytesToHex } from '../tier1/blake3.ts';
import { atomicWriteOnce, encodeStored } from '../tier1/persistence.ts';
import { join } from 'node:path';

export type PropertyName =
  | 'contract'
  | 'frame'
  | 'determinism'
  | 'no_internal_fault'
  | 'effect_outage'
  | 'concurrent_schedule';

/**
 * Blocking properties are claims about the function alone, so a failure is the
 * function's fault and the patch is rejected.
 *
 * `concurrent_schedule` is advisory instead, and deliberately so: whether two
 * invocations can interleave at all is a property of the deployment topology,
 * not of the body. The Tier-4 slicer may place these calls in a single-writer
 * domain, in which case the race cannot occur; it may not, in which case it
 * can. The micro-world reports the hazard and leaves the decision to the tier
 * that actually knows.
 */
const ADVISORY: ReadonlySet<PropertyName> = new Set<PropertyName>(['concurrent_schedule']);

const ALL_PROPERTIES: readonly PropertyName[] = [
  'contract', 'frame', 'determinism', 'no_internal_fault', 'effect_outage', 'concurrent_schedule',
];

export interface Counterexample {
  readonly property: PropertyName;
  readonly advisory: boolean;
  readonly detail: string;
  /** The shrunk argument vector, rendered. */
  readonly arguments: readonly string[];
  readonly fault: Fault | null;
  /** Seed that regenerates this exact case (NFR 6.2). */
  readonly seed: string;
  /** Exact generated values, retained so the failure can become a durable replay. */
  readonly caseData: readonly Plain[];
}

export interface MicroWorldReport {
  readonly symbol: SymbolId;
  readonly cases: number;
  /** Inputs discarded because they failed a precondition. */
  readonly filtered: number;
  readonly passed: number;
  readonly failures: readonly Counterexample[];
  /** Hazards that do not block acceptance but must be surfaced. */
  readonly advisories: readonly Counterexample[];
  /** Fraction of executed cases satisfying every blocking property. */
  readonly compliance: number;
  /**
   * Fraction of generated inputs that satisfied the preconditions. A low value
   * means the harness is mostly testing its own generator, so it is reported
   * rather than left for someone to infer from the case count.
   */
  readonly generationEfficiency: number;
  /** FR-3.2: a candidate patch is rejected below 100%. */
  readonly accepted: boolean;
  readonly elapsedMs: number;
  readonly budgetExhausted: boolean;
  readonly propertiesChecked: readonly PropertyName[];
}

export interface MicroWorldOptions {
  readonly registry: CapabilityRegistry;
  readonly symbols?: SymbolSpace;
  readonly seed?: string;
  /** Maximum generated cases. */
  readonly cases?: number;
  /** NFR 6.1: a local module's harness must finish inside 250 ms. */
  readonly budgetMs?: number;
  /** Step ceiling for a single case. */
  readonly maxSteps?: number;
  readonly generation?: GenerationOptions;
  /** Other declarations the subject calls. */
  readonly module?: Term;
  readonly effects?: ReadonlyMap<CapabilityName, (args: readonly Value[]) => Value>;
  readonly skip?: readonly PropertyName[];
}

const DEFAULT_CASES = 200;
const DEFAULT_BUDGET_MS = 250;

/** Faults that mean the code is broken, whatever the input. */
const INTERNAL_FAULTS: ReadonlySet<string> =
  new Set(['type_error', 'division_by_zero', 'unbound', 'step_budget']);

interface Outcome {
  readonly ok: boolean;
  readonly fault: Fault | null;
  readonly heap: string;
  readonly effects: string;
  readonly writes: readonly string[];
}

export class MicroWorld {
  private readonly decl: Extract<Term, { kind: 'FunctionDecl' }>;
  private readonly opts: MicroWorldOptions;
  private readonly frame: ReadonlySet<string>;
  private readonly hasFrameContract: boolean;

  constructor(decl: Term, opts: MicroWorldOptions) {
    if (decl.kind !== 'FunctionDecl') {
      throw new TypeError(`a micro-world simulates a FunctionDecl, not a ${decl.kind}`);
    }
    this.decl = decl;
    this.opts = opts;
    this.hasFrameContract = decl.contract?.kind === 'Contract';
    this.frame = this.declaredFrame();
  }

  // --- plumbing ------------------------------------------------------------

  private runtimeOptions(
    effects?: ReadonlyMap<CapabilityName, (args: readonly Value[]) => Value>,
  ): RuntimeOptions {
    return {
      registry: this.opts.registry,
      symbols: this.opts.symbols,
      maxSteps: this.opts.maxSteps ?? 20_000,
      effects: effects ?? this.opts.effects,
    };
  }

  private freshRuntime(
    effects?: ReadonlyMap<CapabilityName, (args: readonly Value[]) => Value>,
  ): Runtime {
    const rt = new Runtime(this.runtimeOptions(effects));
    if (this.opts.module) rt.load(this.opts.module);
    rt.load(this.decl);
    return rt;
  }

  /** Places the contract declares writable, keyed by argument position. */
  private declaredFrame(): Set<string> {
    const out = new Set<string>();
    const contract = this.decl.contract?.kind === 'Contract' ? this.decl.contract : null;
    for (const place of contract?.modifies ?? []) {
      if (place.kind !== 'Place') continue;
      const index = this.decl.params.findIndex((p) => p.symbol === place.symbol);
      if (index >= 0) out.add(`${index}.${place.path.join('.')}`);
    }
    return out;
  }

  /** Fields of argument records that changed, as `position.field`. */
  private writesOf(
    rt: Runtime,
    args: readonly Value[],
    before: Record<string, Record<string, string>>,
  ): string[] {
    const after = rt.inspect().heap;
    const positionOf = new Map<string, number>();
    args.forEach((arg, i) => {
      if (isRef(arg) && !positionOf.has(`@${arg.addr}`)) positionOf.set(`@${arg.addr}`, i);
    });
    const out: string[] = [];
    for (const [addr, fields] of Object.entries(after)) {
      const index = positionOf.get(addr);
      if (index === undefined) continue; // freshly allocated, not an argument
      for (const [field, value] of Object.entries(fields)) {
        if (before[addr]?.[field] !== value) out.push(`${index}.${field}`);
      }
    }
    return out;
  }

  /** Run one case in a clean runtime and summarise what happened. */
  private runCase(
    args: readonly Plain[],
    effects?: ReadonlyMap<CapabilityName, (a: readonly Value[]) => Value>,
  ): Outcome {
    const rt = this.freshRuntime(effects);
    const values = materialise(args, rt);
    const before = rt.inspect().heap;
    const result = rt.callDeclaration(this.decl, values);
    return {
      ok: result.ok,
      fault: result.ok ? null : result.fault,
      heap: JSON.stringify(rt.inspect().heap),
      effects: JSON.stringify(rt.effects.map((e) => [e.capability, e.args.map(String)])),
      writes: this.writesOf(rt, values, before),
    };
  }

  // --- properties ----------------------------------------------------------

  /** Check the enabled properties against one case. Null means it passed. */
  private check(
    args: readonly Plain[],
    outcome: Outcome,
    seed: string,
    properties: readonly PropertyName[],
  ): Counterexample | null {
    const fail = (property: PropertyName, detail: string, fault: Fault | null = null): Counterexample => ({
      property,
      advisory: ADVISORY.has(property),
      detail,
      arguments: args.map(formatPlain),
      fault,
      seed,
      caseData: args,
    });

    if (properties.includes('no_internal_fault') && outcome.fault && INTERNAL_FAULTS.has(outcome.fault.kind)) {
      return fail('no_internal_fault', `${outcome.fault.kind}: ${outcome.fault.message}`, outcome.fault);
    }
    if (properties.includes('contract') && outcome.fault) {
      if (outcome.fault.kind === 'postcondition') {
        return fail('contract', `postcondition ${outcome.fault.label} does not hold`, outcome.fault);
      }
      if (outcome.fault.kind === 'assertion') {
        return fail('contract', `assertion ${outcome.fault.label} failed`, outcome.fault);
      }
    }
    if (properties.includes('frame') && outcome.ok && this.hasFrameContract) {
      const stray = outcome.writes.filter((w) => !this.frame.has(w));
      if (stray.length) return fail('frame', `wrote outside modifies: ${stray.join(', ')}`);
    }
    if (properties.includes('determinism')) {
      const replay = this.runCase(args);
      if (replay.ok !== outcome.ok || replay.heap !== outcome.heap || replay.effects !== outcome.effects) {
        return fail('determinism', 'the same case produced a different outcome on replay');
      }
    }
    if (properties.includes('effect_outage') && this.decl.capabilities.length) {
      const detail = this.effectOutage(args);
      if (detail) return fail('effect_outage', detail);
    }
    if (properties.includes('concurrent_schedule') && outcome.ok) {
      const detail = this.lostUpdate(args);
      if (detail) return fail('concurrent_schedule', detail);
    }
    return null;
  }

  /**
   * Fail each capability in turn. The code must either cope or fail *cleanly* —
   * surfacing the effect failure itself, not a postcondition breach, which
   * would mean it had already committed part of its work before reaching for
   * the outside world.
   */
  private effectOutage(args: readonly Plain[]): string | null {
    for (const capability of this.decl.capabilities) {
      const effects = new Map(this.opts.effects ?? []);
      effects.set(capability, () => {
        throw new Error('transient outage');
      });
      const outcome = this.runCase(args, effects);
      if (outcome.ok) continue;
      if (outcome.fault?.kind === 'effect_failed' || outcome.fault?.kind === 'precondition') continue;
      return `an outage of ${capability} surfaced as ${outcome.fault?.kind} ` +
        `(${outcome.fault?.label ?? '—'}) rather than a clean effect failure`;
    }
    return null;
  }

  /**
   * The lost-update schedule.
   *
   * Two invocations read the same initial state and both write back; the later
   * writer wins. Running the calls one after another and running them
   * concurrently must agree — if they do not, an update was silently dropped.
   * This is invisible to any test that calls the function twice in sequence,
   * which is exactly why it is worth generating.
   */
  private lostUpdate(args: readonly Plain[]): string | null {
    const rt = this.freshRuntime();
    const values = materialise(args, rt);

    const start = rt.checkpoint('pre-race');
    const first = rt.callDeclaration(this.decl, values);
    if (!first.ok) return null;
    const second = rt.callDeclaration(this.decl, values);
    if (!second.ok) return null;
    const sequential = JSON.stringify(rt.inspect().heap);

    // Both invocations read the initial state; the second one's writes land last.
    rt.restore(start);
    const concurrent = rt.callDeclaration(this.decl, values);
    if (!concurrent.ok) return null;
    const raced = JSON.stringify(rt.inspect().heap);

    if (sequential === raced) return null;
    return 'two concurrent invocations reading the same initial state lose one update ' +
      '(sequential and interleaved executions disagree)';
  }

  // --- shrinking -----------------------------------------------------------

  /**
   * Reduce a failing case until no single simplification still fails. Bounded,
   * because shrinking is itself a search and the harness has a budget.
   */
  private shrink(
    failure: Counterexample,
    args: readonly Plain[],
    seed: string,
    deadline: number,
  ): Counterexample {
    if (failure.property === 'determinism') return failure;
    // Re-checking with the cheap properties only keeps shrinking inside budget.
    const cheap: PropertyName[] = ['contract', 'frame', 'no_internal_fault'];
    if (!cheap.includes(failure.property)) return failure;

    let current = [...args];
    let best = failure;

    // The deadline is the real bound; the round cap only stops a pathological
    // case from looping forever on a value that shrinks by one each time.
    for (let round = 0; round < 64 && Date.now() < deadline; round++) {
      let improved = false;
      for (let i = 0; i < current.length && Date.now() < deadline; i++) {
        for (const candidate of shrinkPlain(current[i])) {
          const trial = [...current];
          trial[i] = candidate;
          const outcome = this.runCase(trial);
          if (!outcome.ok && outcome.fault?.kind === 'precondition') continue;
          const still = this.check(trial, outcome, seed, [failure.property]);
          if (still?.property === failure.property) {
            current = trial;
            best = still;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (!improved) break;
    }
    return { ...best, arguments: current.map(formatPlain), caseData: current, seed };
  }

  // --- driver --------------------------------------------------------------

  run(): MicroWorldReport {
    const started = Date.now();
    const deadline = started + (this.opts.budgetMs ?? DEFAULT_BUDGET_MS);
    const maxCases = this.opts.cases ?? DEFAULT_CASES;
    const seedBase = this.opts.seed ?? 'micro-world';
    const skip = new Set(this.opts.skip ?? []);
    const properties = ALL_PROPERTIES.filter((p) => !skip.has(p));

    let cases = 0;
    let filtered = 0;
    let passed = 0;
    const failures: Counterexample[] = [];
    const advisories: Counterexample[] = [];
    const seenAdvisories = new Set<string>();
    let budgetExhausted = false;

    for (let i = 0; i < maxCases; i++) {
      if (Date.now() >= deadline) {
        budgetExhausted = true;
        break;
      }
      const seed = `${seedBase}/${i}`;
      const args = generateCase(this.decl.params, rng(seed), this.opts.generation);
      const outcome = this.runCase(args);

      // A precondition failure is not a bug: the generator produced an input
      // the caller is responsible for never producing.
      if (!outcome.ok && outcome.fault?.kind === 'precondition') {
        filtered++;
        continue;
      }
      cases++;

      const failure = this.check(args, outcome, seed, properties);
      if (!failure) {
        passed++;
        continue;
      }
      if (failure.advisory) {
        passed++;
        if (!seenAdvisories.has(failure.detail)) {
          seenAdvisories.add(failure.detail);
          advisories.push(this.shrink(failure, args, seed, deadline));
        }
        continue;
      }
      failures.push(this.shrink(failure, args, seed, deadline));
    }

    return {
      symbol: this.decl.symbol,
      cases,
      filtered,
      passed,
      failures,
      advisories,
      compliance: cases === 0 ? 0 : passed / cases,
      generationEfficiency: cases + filtered === 0 ? 0 : cases / (cases + filtered),
      // FR-3.2 demands 100%. A run that produced no runnable case is not a pass.
      accepted: cases > 0 && failures.length === 0,
      elapsedMs: Date.now() - started,
      budgetExhausted,
      propertiesChecked: properties,
    };
  }
}

/** Run a module's micro-world suite and report per-declaration results. */
export function simulateModule(
  module: Term,
  opts: Omit<MicroWorldOptions, 'module'>,
): MicroWorldReport[] {
  const members = module.kind === 'Module' ? module.members : [module];
  const reports: MicroWorldReport[] = [];
  for (const m of members) {
    if (m.kind !== 'FunctionDecl' || m.body === null) continue;
    reports.push(new MicroWorld(m, { ...opts, module }).run());
  }
  return reports;
}

/** A one-screen summary of a micro-world run. */
export function formatMicroWorld(
  report: MicroWorldReport,
  nameOf?: (s: SymbolId) => string,
): string {
  const title = nameOf?.(report.symbol) ?? report.symbol;
  const lines = [
    `${title}: ${report.accepted ? 'ACCEPTED' : 'REJECTED'} ` +
      `(${report.passed}/${report.cases} cases, ${report.filtered} filtered, ` +
      `${(report.generationEfficiency * 100).toFixed(0)}% yield, ${report.elapsedMs}ms)`,
  ];
  for (const f of report.failures.slice(0, 5)) {
    lines.push(`  ✗ ${f.property}: ${f.detail}`);
    lines.push(`      arguments: (${f.arguments.join(', ')})`);
    lines.push(`      reproduce with seed ${f.seed}`);
  }
  for (const a of report.advisories.slice(0, 3)) {
    lines.push(`  ! ${a.property} (advisory): ${a.detail}`);
    lines.push(`      arguments: (${a.arguments.join(', ')})`);
  }
  if (report.budgetExhausted) lines.push('  (budget exhausted before the case limit)');
  return lines.join('\n');
}

export interface PersistedCounterexample {
  readonly id: string;
  readonly path: string;
  readonly counterexample: Counterexample;
}

/** Persist one exact shrunk case as a permanent, content-addressed replay. */
export function materializeCounterexample(
  directory: string,
  symbol: SymbolId,
  counterexample: Counterexample,
): PersistedCounterexample {
  const payload = { symbol, counterexample };
  const id = bytesToHex(blake3(canonicalBytes(payload as never)));
  const path = join(directory, 'counterexamples', symbol.slice(symbol.lastIndexOf(':') + 1), `${id}.json`);
  atomicWriteOnce(path, encodeStored(payload));
  return { id, path, counterexample };
}
