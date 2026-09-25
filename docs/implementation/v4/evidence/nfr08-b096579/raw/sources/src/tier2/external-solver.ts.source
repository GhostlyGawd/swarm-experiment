import { spawnSync } from 'node:child_process';
import { capability } from '../tier1/ids.ts';
import { CapabilityEnvelope } from './ocap.ts';
import { prove, type SolveOptions, type SolverResult } from './solver.ts';
import { not, toSmtLibScript, type SmtFormula } from './smt.ts';

export const SMT_SOLVER_PROCESS = capability('cap:process:smt_solver');

export interface ExternalSolverOptions extends SolveOptions {
  readonly envelope: CapabilityEnvelope;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly runner?: (
    command: string,
    args: readonly string[],
    input: string,
    timeoutMs: number,
  ) => { readonly stdout: string; readonly stderr?: string; readonly status?: number | null };
}

/** Use an external solver only after the bundled sound subset returns unknown. */
export function proveWithExternalFallback(
  formula: SmtFormula,
  opts: ExternalSolverOptions,
): SolverResult {
  const builtIn = prove(formula, opts);
  if (builtIn.status !== 'unknown') return builtIn;
  if (!opts.envelope.has(SMT_SOLVER_PROCESS)) {
    throw new TypeError(`external SMT fallback requires ${SMT_SOLVER_PROCESS}`);
  }
  const started = Date.now();
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 2_000);
  const command = opts.command ?? 'z3';
  const args = opts.args ?? ['-in', '-smt2'];
  const input = toSmtLibScript(not(formula));
  const run = opts.runner ?? ((program, argv, script, timeout) => {
    const result = spawnSync(program, argv, { input: script, encoding: 'utf8', timeout });
    if (result.error) throw result.error;
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  });
  const result = run(command, args, input, timeoutMs);
  const answer = result.stdout.trim().split(/\s+/)[0];
  if (answer === 'unsat') {
    return { status: 'unsat', elapsedMs: Date.now() - started, abstractedTerms: 0 };
  }
  // A sat answer needs a parsed, validated integer model before it can be a
  // counterexample. Until then it remains unknown by the solver answer contract.
  return {
    status: 'unknown', reason: 'external_no_model',
    elapsedMs: Date.now() - started, abstractedTerms: builtIn.abstractedTerms,
  };
}
