/** Reproduce the independent formula-case review with its original immutable corpus.
 * Run: node --experimental-strip-types roadmap/v4/research/portable-formula-review.ts [OUTPUT.json]
 * This checks finite counterexample-case agreement, not universal soundness or a timing SLA.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as S from '../../../src/tier2/smt.ts';
import { formulaCounterexampleCases, FORMULA_PROFILE } from '../../../src/tier2/portable-formula.ts';
import { domainDigest } from '../../../src/fabric/identity.ts';

const SEED = 982451653;
const CORPUS_SHA256 = 'a572a8a3907c14c6789d4fda737b41b8d9815e2eafd6685ec21483cdcb48d77a';
const EXPECTED_LIMITED = [47, 57, 119, 129, 203, 266, 286, 298, 366, 374, 462, 465, 561, 598, 666, 784, 855, 860];
const INTEGERS = [-5n, -1n, 0n, 1n, 5n];
const BOOLEAN_VALUES = [false, true];
const MANIFEST = domainDigest('aether.execution/1', 'review-formula-cases');
type Corpus = { format: string; seed: number; formulaDepth: number; formulas: { index: number; formula: S.SmtFormula }[] };
type Environment = Record<string, bigint | boolean>;
type Outcome = { index: number; status: 'matched' | 'resource-limited' | 'mismatch' | 'error'; cases?: number; evaluations: number; reason?: string; witness?: Environment };
const json = (value: unknown): string => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { integer: String(item) } : item);
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** Exact generator used in the original read-only tool invocation. */
function generateCorpus(): Corpus {
  let seed = SEED;
  const random = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const comparisons = ['eq', 'le', 'lt', 'ge', 'gt'] as const;
  function term(depth: number): S.SmtTerm {
    if (!depth) return random(2) ? S.intVar(random(2) ? 'x' : 'y') : S.num(random(9) - 4);
    switch (random(5)) {
      case 0: return S.neg(term(depth - 1));
      case 1: return S.add(term(depth - 1), term(depth - 1));
      case 2: return S.sub(term(depth - 1), term(depth - 1));
      case 3: return S.mul(S.num(random(7) - 3), term(depth - 1));
      default: return S.ite(formula(0), term(depth - 1), term(depth - 1));
    }
  }
  function formula(depth: number): S.SmtFormula {
    if (!depth) return random(3) ? S.cmp(comparisons[random(5)], term(0), term(0)) : S.boolVar(random(2) ? 'p' : 'q');
    switch (random(7)) {
      case 0: return S.not(formula(depth - 1));
      case 1: return S.and(formula(depth - 1), formula(depth - 1));
      case 2: return S.or(formula(depth - 1), formula(depth - 1));
      case 3: return S.implies(formula(depth - 1), formula(depth - 1));
      case 4: return S.iff(formula(depth - 1), formula(depth - 1));
      default: return S.cmp(comparisons[random(5)], term(2), term(2));
    }
  }
  return { format: 'aether.portable-formula-review-corpus/1', seed: SEED, formulaDepth: 3,
    formulas: Array.from({ length: 1000 }, (_, index) => ({ index, formula: formula(3) })) };
}

/** Independent concrete evaluator. It intentionally does not call S.evaluate,
 * symbolic simplification, a certificate producer, or a solver. */
function evaluateTerm(term: S.SmtTerm, environment: Environment): bigint {
  switch (term.k) {
    case 'int': return term.v;
    case 'var': { const value = environment[term.name]; if (typeof value !== 'bigint') throw new Error('invalid concrete integer binding'); return value; }
    case 'neg': return -evaluateTerm(term.arg, environment);
    case 'add': return term.args.reduce((sum, item) => sum + evaluateTerm(item, environment), 0n);
    case 'mul': return term.args.reduce((product, item) => product * evaluateTerm(item, environment), 1n);
    case 'sub': return evaluateTerm(term.left, environment) - evaluateTerm(term.right, environment);
    case 'ite': return evaluateFormula(term.cond, environment) ? evaluateTerm(term.then, environment) : evaluateTerm(term.otherwise, environment);
    default: throw new Error(`unsupported concrete term ${term.k}`);
  }
}
function evaluateFormula(formula: S.SmtFormula, environment: Environment): boolean {
  switch (formula.k) {
    case 'true': return true;
    case 'false': return false;
    case 'bool': { const value = environment[formula.name]; if (typeof value !== 'boolean') throw new Error('invalid concrete Boolean binding'); return value; }
    case 'not': return !evaluateFormula(formula.arg, environment);
    case 'and': return formula.args.every(item => evaluateFormula(item, environment));
    case 'or': return formula.args.some(item => evaluateFormula(item, environment));
    case 'implies': return !evaluateFormula(formula.left, environment) || evaluateFormula(formula.right, environment);
    case 'iff': return evaluateFormula(formula.left, environment) === evaluateFormula(formula.right, environment);
    case 'cmp': {
      const left = evaluateTerm(formula.left, environment), right = evaluateTerm(formula.right, environment);
      return formula.op === 'eq' ? left === right : formula.op === 'le' ? left <= right : formula.op === 'lt' ? left < right : formula.op === 'ge' ? left >= right : left > right;
    }
  }
}

const corpusPath = new URL('./portable-formula-review-corpus.json', import.meta.url);
const corpusBytes = readFileSync(corpusPath);
if (sha256(corpusBytes) !== CORPUS_SHA256) throw new Error('immutable review corpus changed');
if (sha256(json(generateCorpus()) + '\n') !== CORPUS_SHA256) throw new Error('original seed/generator no longer reconstructs the frozen corpus');
const corpus = JSON.parse(corpusBytes.toString('utf8'), (_key, value) => value && typeof value === 'object'
  && Object.keys(value).length === 1 && typeof value.integer === 'string' ? BigInt(value.integer) : value) as Corpus;
if (corpus.seed !== SEED || corpus.formulas.length !== 1000 || corpus.formulaDepth !== 3) throw new Error('review corpus metadata changed');

const outcomes: Outcome[] = [];
let checked = 0, evaluations = 0;
for (const input of corpus.formulas) {
  try {
    const cases = formulaCounterexampleCases(input.formula, MANIFEST).map(branch => ({
      booleans: branch.booleanLiterals,
      rows: branch.claim.assumptions.map(row => ({ variables: branch.claim.variables, coefficients: row.coefficients.map(BigInt), bound: BigInt(row.bound) })),
    }));
    const outcome: Outcome = { index: input.index, status: 'matched', cases: cases.length, evaluations: 0 };
    valuations: for (const x of INTEGERS) for (const y of INTEGERS) for (const p of BOOLEAN_VALUES) for (const q of BOOLEAN_VALUES) {
      const environment = { x, y, p, q };
      const counterexample = cases.some(branch => branch.booleans.every(([name, value]) => (environment as Environment)[name] === value)
        && branch.rows.every(row => row.coefficients.reduce((sum, coefficient, index) => {
          const value = (environment as Environment)[row.variables[index]];
          if (typeof value !== 'bigint') throw new Error('unknown variable in derived case');
          return sum + coefficient * value;
        }, 0n) <= row.bound));
      if (counterexample !== !evaluateFormula(input.formula, environment)) {
        outcome.status = 'mismatch'; outcome.witness = environment; break valuations;
      }
      outcome.evaluations++; evaluations++;
    }
    if (outcome.status === 'matched') checked++;
    outcomes.push(outcome);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    outcomes.push({ index: input.index, status: /limit/.test(reason) ? 'resource-limited' : 'error', evaluations: 0, reason });
  }
}
const limited = outcomes.filter(outcome => outcome.status === 'resource-limited').map(outcome => outcome.index);
const passed = checked === 982 && evaluations === 98_200 && json(limited) === json(EXPECTED_LIMITED)
  && outcomes.every(outcome => outcome.status === 'matched' || outcome.status === 'resource-limited');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sources = ['src/tier2/portable-formula.ts', 'src/tier2/portable-linear-kernel.ts', 'src/tier2/smt.ts', 'src/fabric/encoding.ts', 'src/fabric/identity.ts', 'src/tier1/blake3.ts', 'roadmap/v4/research/portable-formula-review.ts'];
const report = {
  format: 'aether.portable-formula-differential-review/1', generatedAt: new Date().toISOString(),
  scope: 'The original fixed finite review corpus: counterexample-case membership versus independent concrete evaluation. Not a universal soundness proof or performance qualification.',
  seed: SEED, corpusSha256: CORPUS_SHA256, generatorReproducesCorpus: true,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceTreeDirty: execFileSync('git', ['status', '--porcelain', '--', ...sources], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  sourceDigests: Object.fromEntries(sources.map(path => [path, sha256(readFileSync(resolve(root, path)))])),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  formulaProfile: FORMULA_PROFILE, valuationDomain: { x: INTEGERS.map(String), y: INTEGERS.map(String), p: BOOLEAN_VALUES, q: BOOLEAN_VALUES },
  expected: { formulasChecked: 982, resourceLimited: 18, evaluations: 98_200, resourceLimitedIndices: EXPECTED_LIMITED },
  actual: { formulasChecked: checked, resourceLimited: limited.length, evaluations, resourceLimitedIndices: limited },
  passed, outcomes,
};
const output = process.argv[2] ? resolve(process.argv[2]) : new URL('./portable-formula-review-results.json', import.meta.url);
writeFileSync(output, JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n');
console.log(JSON.stringify({ passed, seed: SEED, ...report.actual, corpusSha256: CORPUS_SHA256 }));
if (!passed) process.exitCode = 1;
