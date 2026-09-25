/**
 * The synthesis loop (FR-2.2, Risk R4).
 *
 * A contract is permanent; an implementation is a disposable artifact that
 * satisfies it today. This module is the machinery that makes that claim
 * operational: it takes a body-less `FunctionDecl`, asks a synthesizer for a
 * body, and puts every candidate through the whole stack before accepting it.
 *
 *     propose → type & capability check → SMT verification → micro-worlds
 *
 * Each stage failure becomes *structured feedback*, not a log line. A
 * counterexample is a binding the next attempt can be checked against; a
 * capability error names the exact missing grant. That is what lets the
 * synthesizer improve rather than resample.
 *
 * The budget gate is the Risk R4 mitigation and it is deliberately hard: after
 * `maxIterations` failed attempts the loop stops, raises `SynthesisStall`, and
 * escalates with the full attempt history. An agent that cannot satisfy an
 * invariant in five tries is not going to satisfy it in five hundred, and the
 * failure trace is more useful to a human than another thousand candidates.
 */

import type { Term } from '../tier1/ast.ts';
import type { InvariantId, NodeRef, SymbolId } from '../tier1/ids.ts';
import type { SymbolSpace } from '../tier1/symbols.ts';
import { GraphStore } from '../tier1/store.ts';
import { type DischargeProof, type ProvenanceLedger } from '../tier1/provenance.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { typecheck, type Diagnostic } from '../tier2/typecheck.ts';
import { dischargeProof, verifyFunction, type VerificationReport } from '../tier2/verify.ts';
import { MicroWorld, type Counterexample, type MicroWorldReport } from '../tier3/microworld.ts';

export type Stage = 'typecheck' | 'verification' | 'microworld' | 'accepted' | 'no_candidate';

export type Feedback =
  | { readonly stage: 'typecheck'; readonly diagnostics: readonly Diagnostic[] }
  | {
      readonly stage: 'verification';
      readonly refuted: ReadonlyArray<{
        readonly label: string;
        readonly kind: string;
        readonly counterexample: Readonly<Record<string, string>>;
        readonly smtLib: string;
      }>;
      readonly unproven: readonly string[];
    }
  | { readonly stage: 'microworld'; readonly failures: readonly Counterexample[] }
  | { readonly stage: 'no_candidate'; readonly reason: string };

export interface Attempt {
  readonly iteration: number;
  readonly body: Term | null;
  readonly stage: Stage;
  readonly feedback: Feedback | null;
  readonly elapsedMs: number;
}

/**
 * The agent interface.
 *
 * `propose` receives every prior piece of feedback, not just the last, so a
 * synthesizer can maintain the full counterexample set — which is what makes
 * counterexample-guided synthesis possible rather than blind resampling.
 */
export interface Synthesizer {
  readonly name: string;
  propose(
    spec: Extract<Term, { kind: 'FunctionDecl' }>,
    feedback: readonly Feedback[],
    attempt: number,
  ): Term | null;
}

export interface SynthesisOptions {
  readonly registry: CapabilityRegistry;
  readonly symbols?: SymbolSpace;
  readonly environment?: ReadonlyMap<SymbolId, Term>;
  readonly module?: Term;
  readonly ledger?: ProvenanceLedger;
  /** Risk R4: the hard gate. Five is the PRD's number. */
  readonly maxIterations?: number;
  readonly verifyBudgetMs?: number;
  readonly microWorldBudgetMs?: number;
  readonly microWorldCases?: number;
  readonly seed?: string;
  /** Invariant the accepted body is said to discharge, for the fence. */
  readonly invariant?: InvariantId;
  /**
   * Keep searching when a candidate passes its micro-worlds but the solver
   * could not settle a formal clause.
   *
   * This is the tiered-rigor rule applied to synthesis. A body the solver
   * cannot reason about — typically because it multiplies two unknowns — is
   * *acceptable* under NFR 6.2, but it is not as good as one that can be
   * proved, and a search that stops at the first passing candidate will never
   * find the better one. So the unproven candidate is held as a fallback and
   * the search continues; it is returned only if nothing provable turns up
   * inside the budget. Default: true.
   */
  readonly preferProved?: boolean;
}

export type SynthesisOutcome =
  | {
      readonly status: 'synthesized';
      readonly declaration: Extract<Term, { kind: 'FunctionDecl' }>;
      readonly attempts: readonly Attempt[];
      readonly verification: VerificationReport;
      readonly simulation: MicroWorldReport;
      readonly proof: DischargeProof | null;
      /** False when the body was accepted on property evidence alone. */
      readonly provenFormally: boolean;
      readonly elapsedMs: number;
    }
  | {
      readonly status: 'stalled';
      readonly reason: 'SynthesisStall';
      readonly attempts: readonly Attempt[];
      /** A report written for the human this is being escalated to. */
      readonly escalation: string;
      readonly elapsedMs: number;
    };

export const DEFAULT_MAX_ITERATIONS = 5;

/** Strip the SMT name mangling so a counterexample reads like source. */
function readableModel(model: Readonly<Record<string, bigint | boolean>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(model)) {
    if (key.includes('!')) continue; // internal: havoc, quotient, call results
    out[key.replace(/#[0-9a-z]+/g, '')] = String(value);
  }
  return out;
}

/**
 * Synthesize a body for a contract, or stall trying.
 */
export function synthesize(
  spec: Term,
  synthesizer: Synthesizer,
  opts: SynthesisOptions,
): SynthesisOutcome {
  if (spec.kind !== 'FunctionDecl') {
    throw new TypeError(`synthesize expects a FunctionDecl, got ${spec.kind}`);
  }
  const started = Date.now();
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const attempts: Attempt[] = [];
  const feedback: Feedback[] = [];
  const preferProved = opts.preferProved ?? true;

  /** A candidate that passed everything except formal proof. */
  let fallback: {
    declaration: Extract<Term, { kind: 'FunctionDecl' }>;
    verification: VerificationReport;
    simulation: MicroWorldReport;
  } | null = null;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const attemptStarted = Date.now();
    const body = synthesizer.propose(spec, feedback, iteration);

    if (body === null) {
      const f: Feedback = {
        stage: 'no_candidate',
        reason: `${synthesizer.name} has no further candidate at iteration ${iteration}`,
      };
      feedback.push(f);
      attempts.push({
        iteration, body: null, stage: 'no_candidate', feedback: f,
        elapsedMs: Date.now() - attemptStarted,
      });
      break;
    }

    const candidate: Extract<Term, { kind: 'FunctionDecl' }> = { ...spec, body };

    // --- stage 1: types and capabilities ---------------------------------
    const checked = typecheck(candidate, {
      registry: opts.registry,
      symbols: opts.symbols,
      externals: [...(opts.environment?.values() ?? [])]
        .filter((t): t is Extract<Term, { kind: 'FunctionDecl' }> => t.kind === 'FunctionDecl')
        .map((d) => ({
          symbol: d.symbol,
          typeParams: d.typeParams,
          params: d.params,
          returns: d.returns,
          capabilities: d.capabilities,
          purity: d.purity,
        })),
    });
    if (!checked.ok) {
      const f: Feedback = { stage: 'typecheck', diagnostics: checked.diagnostics };
      feedback.push(f);
      attempts.push({
        iteration, body, stage: 'typecheck', feedback: f, elapsedMs: Date.now() - attemptStarted,
      });
      continue;
    }

    // --- stage 2: formal verification ------------------------------------
    const verification = verifyFunction(candidate, {
      symbols: opts.symbols,
      environment: opts.environment,
      budgetMs: opts.verifyBudgetMs,
    });
    if (verification.verdict === 'refuted') {
      const f: Feedback = {
        stage: 'verification',
        refuted: verification.results
          .filter((r) => r.verdict === 'refuted')
          .map((r) => ({
            label: r.obligation.label,
            kind: r.obligation.kind,
            counterexample: readableModel(r.counterexample ?? {}),
            smtLib: r.smtLib,
          })),
        unproven: verification.unprovenFormalContracts,
      };
      feedback.push(f);
      attempts.push({
        iteration, body, stage: 'verification', feedback: f, elapsedMs: Date.now() - attemptStarted,
      });
      continue;
    }

    // --- stage 3: micro-worlds -------------------------------------------
    const simulation = new MicroWorld(candidate, {
      registry: opts.registry,
      symbols: opts.symbols,
      module: opts.module,
      seed: `${opts.seed ?? 'synthesis'}/${iteration}`,
      budgetMs: opts.microWorldBudgetMs,
      cases: opts.microWorldCases,
    }).run();

    if (!simulation.accepted) {
      const f: Feedback = { stage: 'microworld', failures: simulation.failures };
      feedback.push(f);
      attempts.push({
        iteration, body, stage: 'microworld', feedback: f, elapsedMs: Date.now() - attemptStarted,
      });
      continue;
    }

    // --- accepted ---------------------------------------------------------
    const proven = verification.verdict === 'proved' || verification.verdict === 'delegated';
    if (!proven && preferProved) {
      // Good enough to ship under tiered rigor, but keep looking for better.
      fallback ??= { declaration: candidate, verification, simulation };
      const f: Feedback = {
        stage: 'verification',
        refuted: [],
        unproven: verification.unprovenFormalContracts,
      };
      feedback.push(f);
      attempts.push({
        iteration, body, stage: 'verification', feedback: f, elapsedMs: Date.now() - attemptStarted,
      });
      continue;
    }

    attempts.push({
      iteration, body, stage: 'accepted', feedback: null, elapsedMs: Date.now() - attemptStarted,
    });
    return {
      status: 'synthesized',
      declaration: candidate,
      attempts,
      verification,
      simulation,
      proof: opts.invariant
        ? dischargeProof(verification, opts.invariant, new GraphStore().intern(candidate))
        : null,
      // Reaching this line does not imply a proof: with `preferProved` off the
      // loop accepts the first candidate that passes its micro-worlds, whatever
      // the solver managed.
      provenFormally: proven,
      elapsedMs: Date.now() - started,
    };
  }

  if (fallback) {
    // Nothing provable turned up. Ship the property-checked body, labelled.
    return {
      status: 'synthesized',
      declaration: fallback.declaration,
      attempts,
      verification: fallback.verification,
      simulation: fallback.simulation,
      proof: opts.invariant
        ? dischargeProof(
            fallback.verification,
            opts.invariant,
            new GraphStore().intern(fallback.declaration),
          )
        : null,
      provenFormally: false,
      elapsedMs: Date.now() - started,
    };
  }

  return {
    status: 'stalled',
    reason: 'SynthesisStall',
    attempts,
    escalation: formatEscalation(spec, synthesizer, attempts, opts.symbols),
    elapsedMs: Date.now() - started,
  };
}

/**
 * Purge a failed implementation (FR-2.2).
 *
 * A body that breaks its contract is not patched in place — it is removed,
 * leaving the contract standing and the function marked for re-synthesis. The
 * contract is the asset; the body was only ever a way of meeting it.
 */
export function purgeBody(
  store: GraphStore,
  root: NodeRef,
  symbol: SymbolId,
  ledger?: ProvenanceLedger,
  reason = 'contract violation',
): { root: NodeRef; purged: boolean } {
  const path = store.findPath(root, (node) => node.kind === 'FunctionDecl' && node.symbol === symbol);
  if (!path) return { root, purged: false };

  const chain = store.resolvePath(root, path);
  const declRef = chain[chain.length - 1];
  const decl = store.hydrate(declRef) as Extract<Term, { kind: 'FunctionDecl' }>;
  if (decl.body === null) return { root, purged: false };

  const stripped = store.intern({ ...decl, body: null });
  const next = store.replaceAt(root, path, stripped);

  if (ledger) {
    const provenance = ledger.record({
      intent: `Implementation purged: ${reason}. The contract stands; a new body is owed.`,
      origin: { kind: 'synthesis_repair', ref: symbol, actor: 'runtime' },
      parents: decl.provenance ? [decl.provenance] : [],
    });
    ledger.bind(stripped, provenance);
  }
  return { root: next, purged: true };
}

function formatEscalation(
  spec: Extract<Term, { kind: 'FunctionDecl' }>,
  synthesizer: Synthesizer,
  attempts: readonly Attempt[],
  symbols?: SymbolSpace,
): string {
  const name = symbols?.nameOf(spec.symbol) ?? spec.symbol;
  const lines = [
    `SynthesisStall: ${synthesizer.name} failed to satisfy the contract for ${name} ` +
      `in ${attempts.length} attempt(s).`,
    '',
    'This is a budget gate, not a solver limit: further attempts were refused so that',
    'a human sees the failure trace instead of a longer one.',
    '',
    'Attempts:',
  ];
  for (const attempt of attempts) {
    lines.push(`  ${attempt.iteration}. ${attempt.stage} (${attempt.elapsedMs}ms)`);
    const f = attempt.feedback;
    if (!f) continue;
    switch (f.stage) {
      case 'typecheck':
        for (const d of f.diagnostics.slice(0, 4)) {
          lines.push(`       ${d.code}: ${d.message} at ${d.path.join('.')}`);
        }
        break;
      case 'verification':
        for (const r of f.refuted.slice(0, 4)) {
          const bindings = Object.entries(r.counterexample).map(([k, v]) => `${k}=${v}`).join(', ');
          lines.push(`       ${r.kind} ${r.label} refuted by ${bindings || '(no bindings)'}`);
        }
        if (f.unproven.length) lines.push(`       unproven: ${f.unproven.join(', ')}`);
        break;
      case 'microworld':
        for (const c of f.failures.slice(0, 4)) {
          lines.push(`       ${c.property}: ${c.detail} on (${c.arguments.join(', ')})`);
        }
        break;
      case 'no_candidate':
        lines.push(`       ${f.reason}`);
        break;
    }
  }
  lines.push('');
  lines.push('Next step for a human: either the contract is unsatisfiable as written, or it is');
  lines.push('missing a precondition that rules the counterexamples above out of scope.');
  return lines.join('\n');
}

/** A one-screen summary of a synthesis run. */
export function formatOutcome(outcome: SynthesisOutcome, symbols?: SymbolSpace): string {
  if (outcome.status === 'stalled') return outcome.escalation;
  const name = symbols?.nameOf(outcome.declaration.symbol) ?? outcome.declaration.symbol;
  const lines = [
    `${name}: synthesized in ${outcome.attempts.length} attempt(s), ${outcome.elapsedMs}ms`,
    `  verification: ${outcome.verification.verdict} ` +
      `(${outcome.verification.results.length} obligations)`,
    `  micro-world: ${outcome.simulation.passed}/${outcome.simulation.cases} cases`,
  ];
  if (!outcome.provenFormally) {
    lines.push(
      '  UnprovenFormalContract: accepted on property evidence alone ' +
        `(${outcome.verification.unprovenFormalContracts.join(', ')})`,
    );
  }
  for (const attempt of outcome.attempts) {
    if (attempt.stage === 'accepted') continue;
    lines.push(`  attempt ${attempt.iteration} rejected at ${attempt.stage}`);
  }
  return lines.join('\n');
}
