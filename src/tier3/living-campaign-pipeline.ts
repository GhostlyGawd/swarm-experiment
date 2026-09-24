/** Versioned, durable accounting of generated and actually executed living cases.
 * This is measurement evidence, never a production deployment receipt. */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { decodeCanonical, encodeCanonical } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { LivingCampaign, type LivingCase, type LivingExternalCaseResultV4 } from './living-campaign.ts';

export const LIVING_PIPELINE_PROFILE = 'aether.living-boundary-pipeline/1' as const;
export type LivingAttemptKindV1 = 'original' | 'retry' | 'duplicate';
export interface LivingPipelineGenerationV1 {
  readonly format: 'aether.living-pipeline-generation/1';
  readonly candidateRoot: Digest; readonly authorizationDigest: Digest; readonly manifestDigest: Digest;
  readonly generated: number; readonly seeds: readonly string[]; readonly caseDigests: readonly Digest[];
  readonly elapsedNs: string;
}
export interface LivingPipelineAttemptV1 {
  readonly format: 'aether.living-pipeline-attempt/1'; readonly sequence: number;
  readonly kind: LivingAttemptKindV1; readonly input: LivingCase;
  readonly result: LivingExternalCaseResultV4; readonly executionNs: string;
}
export interface LivingPipelineRecoveryV1 {
  readonly format: 'aether.living-pipeline-recovery/1'; readonly sequence: number;
  readonly input: LivingCase; readonly result: { readonly reconciled: number; readonly unknown: number };
  readonly executionNs: string;
}
export interface LivingPipelineReportV1 {
  readonly format: typeof LIVING_PIPELINE_PROFILE;
  readonly candidateRoot: Digest; readonly authorizationDigest: Digest; readonly manifestDigest: Digest;
  readonly generated: number; readonly executed: number; readonly attemptedExecutions: number;
  readonly passed: number; readonly failed: number; readonly failedAttempts: number;
  readonly filtered: number; readonly filteredAttempts: number; readonly recoveries: number;
  readonly seeds: readonly string[]; readonly coverage: readonly string[];
  readonly missingCoverage: readonly string[]; readonly attemptDigests: readonly Digest[];
  readonly recoveryDigests: readonly Digest[]; readonly generationElapsedNs: string;
  readonly candidateExecutionNs: string; readonly observationPublicationNs: string;
  readonly attemptPublicationSamplesNs: readonly string[]; readonly recoveryPublicationSamplesNs: readonly string[];
  readonly recoveryExecutionNs: string; readonly pipelineElapsedNs: string;
  readonly generatedCasesPerSecond: string; readonly attemptedExecutionsPerSecond: string;
  readonly pipelineCasesPerSecond: string; readonly complete: boolean;
  readonly productionAuthorized: false;
}
const caseId = (value: LivingCase): Digest => domainDigest('aether.living-case/1', value);
function publish(path: string, value: unknown): Digest {
  const directory = dirname(path); mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(encodeCanonical(value));
  const temp = join(directory, `.tmp-${process.pid}-${randomUUID()}`), fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!readFileSync(path).equals(bytes)) throw new Error('living pipeline artifact collision or tampering');
    const dirFd = openSync(directory, 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally { unlinkSync(temp); }
  return domainDigest('aether.living-pipeline-artifact/1', value);
}
function rate(count: number, nanoseconds: bigint): string {
  return String(nanoseconds > 0n ? count / (Number(nanoseconds) / 1e9) : 0);
}

export class LivingCampaignPipelineV1 {
  readonly #campaign: LivingCampaign;
  readonly #directory: string;
  readonly #candidateRoot: Digest;
  readonly #authorizationDigest: Digest;
  readonly #requiredCoverage: readonly string[];
  readonly #cases: readonly LivingCase[];
  readonly #byDigest: ReadonlyMap<Digest, LivingCase>;
  readonly #generation: LivingPipelineGenerationV1;
  readonly #started: bigint;
  readonly #attempts: LivingPipelineAttemptV1[] = [];
  readonly #recoveries: LivingPipelineRecoveryV1[] = [];
  readonly #attemptPublicationNs: string[] = [];
  readonly #recoveryPublicationNs: string[] = [];
  #finished = false;
  constructor(options: { campaign: LivingCampaign; directory: string; candidateRoot: Digest;
    authorizationDigest: Digest; requiredCoverage: readonly string[] }) {
    this.#campaign = options.campaign; this.#directory = resolve(options.directory);
    this.#candidateRoot = options.candidateRoot; this.#authorizationDigest = options.authorizationDigest;
    validateDigest(this.#candidateRoot, 'ast');
    validateDigest(this.#authorizationDigest, 'aether.living-effect-authorization/4');
    if (!Array.isArray(options.requiredCoverage) || new Set(options.requiredCoverage).size !== options.requiredCoverage.length)
      throw new TypeError('pipeline coverage obligations must be explicit and unique');
    this.#requiredCoverage = [...options.requiredCoverage];
    if (existsSync(join(this.#directory, 'generation.json')) || existsSync(join(this.#directory, 'report.json')))
      throw new Error('living pipeline requires a fresh directory');
    this.#started = process.hrtime.bigint();
    const start = process.hrtime.bigint(), cases = this.#campaign.generate();
    const elapsedNs = String(process.hrtime.bigint() - start);
    if (!cases.length || new Set(cases.map(caseId)).size !== cases.length
      || new Set(cases.map(item => item.seed)).size !== cases.length
      || new Set(cases.map(item => item.manifestDigest)).size !== 1)
      throw new Error('pipeline generated duplicate or mixed-subject cases');
    this.#cases = cases;
    this.#byDigest = new Map(cases.map(item => [caseId(item), item]));
    this.#generation = { format: 'aether.living-pipeline-generation/1',
      candidateRoot: this.#candidateRoot, authorizationDigest: this.#authorizationDigest,
      manifestDigest: cases[0].manifestDigest, generated: cases.length,
      seeds: cases.map(item => item.seed), caseDigests: cases.map(caseId), elapsedNs };
    publish(join(this.#directory, 'generation.json'), this.#generation);
  }
  get generated(): readonly LivingCase[] { return this.#cases; }
  get generation(): LivingPipelineGenerationV1 { return this.#generation; }
  #exact(input: LivingCase): LivingCase {
    const found = this.#byDigest.get(caseId(input));
    if (!found) throw new TypeError('pipeline execution outside exact generated cases');
    return found;
  }
  execute(input: LivingCase, kind: LivingAttemptKindV1): LivingExternalCaseResultV4 {
    if (this.#finished) throw new Error('pipeline already finalized');
    if (!['original', 'retry', 'duplicate'].includes(kind)) throw new TypeError('pipeline attempt kind');
    const exact = this.#exact(input), sequence = this.#attempts.length;
    const started = process.hrtime.bigint(), result = this.#campaign.execute(exact) as LivingExternalCaseResultV4;
    const executionNs = String(process.hrtime.bigint() - started);
    if (!result.externalEffects || result.caseDigest !== caseId(exact)) throw new Error('pipeline lacks exact external effect observation');
    const publicationStarted = process.hrtime.bigint();
    const observation: LivingPipelineAttemptV1 = { format: 'aether.living-pipeline-attempt/1', sequence,
      kind, input: exact, result, executionNs };
    publish(join(this.#directory, 'attempts', `${sequence}.json`), observation);
    this.#attemptPublicationNs.push(String(process.hrtime.bigint() - publicationStarted));
    this.#attempts.push(observation);
    return result;
  }
  recover(input: LivingCase): { readonly reconciled: number; readonly unknown: number } {
    if (this.#finished) throw new Error('pipeline already finalized');
    const exact = this.#exact(input), sequence = this.#recoveries.length;
    const started = process.hrtime.bigint(), result = this.#campaign.recoverEffectCase(exact);
    const executionNs = String(process.hrtime.bigint() - started), publicationStarted = process.hrtime.bigint();
    const observation: LivingPipelineRecoveryV1 = { format: 'aether.living-pipeline-recovery/1',
      sequence, input: exact, result, executionNs };
    publish(join(this.#directory, 'recoveries', `${sequence}.json`), observation);
    this.#recoveryPublicationNs.push(String(process.hrtime.bigint() - publicationStarted));
    this.#recoveries.push(observation);
    return result;
  }
  finish(): LivingPipelineReportV1 {
    if (this.#finished) throw new Error('pipeline already finalized');
    const final = this.#cases.map(input => [...this.#attempts].reverse().find(row => caseId(row.input) === caseId(input) && row.result.passed));
    const missing = this.#requiredCoverage.filter(label => !final.some(row => row?.result.coverage.includes(label)));
    const filteredAttempts = this.#attempts.filter(row => row.result.filtered).length;
    const failedAttempts = this.#attempts.filter(row => !row.result.passed).length;
    const coverage = [...new Set(final.flatMap(row => row?.result.coverage ?? []))].sort();
    const generationNs = BigInt(this.#generation.elapsedNs);
    const candidateNs = this.#attempts.reduce((sum, row) => sum + BigInt(row.executionNs), 0n);
    const publicationNs = [...this.#attemptPublicationNs, ...this.#recoveryPublicationNs]
      .reduce((sum, sample) => sum + BigInt(sample), 0n);
    const recoveryNs = this.#recoveries.reduce((sum, row) => sum + BigInt(row.executionNs), 0n);
    const elapsedNs = process.hrtime.bigint() - this.#started;
    const report: LivingPipelineReportV1 = { format: LIVING_PIPELINE_PROFILE,
      candidateRoot: this.#candidateRoot, authorizationDigest: this.#authorizationDigest,
      manifestDigest: this.#generation.manifestDigest,
      generated: this.#cases.length, executed: final.filter(Boolean).length,
      attemptedExecutions: this.#attempts.length, passed: final.filter(row => row?.result.passed).length,
      failed: final.filter(row => !row?.result.passed).length, failedAttempts, filtered: final.filter(row => row?.result.filtered).length,
      filteredAttempts, recoveries: this.#recoveries.length, seeds: this.#generation.seeds,
      coverage, missingCoverage: missing,
      attemptDigests: this.#attempts.map(row => domainDigest('aether.living-pipeline-attempt-observation/1', row)),
      recoveryDigests: this.#recoveries.map(row => domainDigest('aether.living-pipeline-recovery-observation/1', row)),
      generationElapsedNs: this.#generation.elapsedNs, candidateExecutionNs: String(candidateNs),
      observationPublicationNs: String(publicationNs), recoveryExecutionNs: String(recoveryNs),
      attemptPublicationSamplesNs: this.#attemptPublicationNs,
      recoveryPublicationSamplesNs: this.#recoveryPublicationNs,
      pipelineElapsedNs: String(elapsedNs), generatedCasesPerSecond: rate(this.#cases.length, generationNs),
      attemptedExecutionsPerSecond: rate(this.#attempts.length, candidateNs),
      pipelineCasesPerSecond: rate(final.filter(Boolean).length, elapsedNs),
      complete: final.every(Boolean) && filteredAttempts === 0 && missing.length === 0,
      productionAuthorized: false };
    publish(join(this.#directory, 'report.json'), report);
    this.#finished = true;
    return report;
  }
}

/** Audit immutable per-attempt bytes and independently recount every stage. */
export function auditLivingCampaignPipelineV1(directory: string, report: LivingPipelineReportV1,
  requiredCoverage: readonly string[]): void {
  const root = resolve(directory);
  const read = <T>(path: string): T => {
    const bytes = readFileSync(path), value = decodeCanonical(bytes) as T;
    if (!bytes.equals(Buffer.from(encodeCanonical(value)))) throw new Error('noncanonical living pipeline artifact');
    return value;
  };
  const saved = read<LivingPipelineReportV1>(join(root, 'report.json'));
  if (!Buffer.from(encodeCanonical(saved)).equals(Buffer.from(encodeCanonical(report)))
    || report.format !== LIVING_PIPELINE_PROFILE || report.productionAuthorized !== false)
    throw new Error('living pipeline report changed');
  const generated = read<LivingPipelineGenerationV1>(join(root, 'generation.json'));
  if (generated.format !== 'aether.living-pipeline-generation/1'
    || generated.candidateRoot !== report.candidateRoot
    || generated.authorizationDigest !== report.authorizationDigest
    || generated.manifestDigest !== report.manifestDigest
    || generated.generated !== report.generated || generated.seeds.length !== report.generated
    || generated.caseDigests.length !== report.generated
    || new Set(generated.caseDigests).size !== report.generated)
    throw new Error('living pipeline generation changed');
  const attempts = report.attemptDigests.map((expected, sequence) => {
    const row = read<LivingPipelineAttemptV1>(join(root, 'attempts', `${sequence}.json`));
    if (row.format !== 'aether.living-pipeline-attempt/1' || row.sequence !== sequence
      || !generated.caseDigests.includes(caseId(row.input)) || row.result.caseDigest !== caseId(row.input)
      || domainDigest('aether.living-pipeline-attempt-observation/1', row) !== expected)
      throw new Error('living pipeline attempt changed');
    return row;
  });
  const recoveries = report.recoveryDigests.map((expected, sequence) => {
    const row = read<LivingPipelineRecoveryV1>(join(root, 'recoveries', `${sequence}.json`));
    if (row.format !== 'aether.living-pipeline-recovery/1' || row.sequence !== sequence
      || !generated.caseDigests.includes(caseId(row.input))
      || domainDigest('aether.living-pipeline-recovery-observation/1', row) !== expected)
      throw new Error('living pipeline recovery changed');
    return row;
  });
  const attemptFiles = existsSync(join(root, 'attempts')) ? readdirSync(join(root, 'attempts')).filter(name => name.endsWith('.json')) : [];
  const recoveryFiles = existsSync(join(root, 'recoveries')) ? readdirSync(join(root, 'recoveries')).filter(name => name.endsWith('.json')) : [];
  if (attemptFiles.length !== attempts.length || recoveryFiles.length !== recoveries.length
    || report.attemptedExecutions !== attempts.length || report.recoveries !== recoveries.length
    || report.attemptPublicationSamplesNs.length !== attempts.length
    || report.recoveryPublicationSamplesNs.length !== recoveries.length)
    throw new Error('living pipeline execution count changed');
  const final = generated.caseDigests.map(id => [...attempts].reverse().find(row => caseId(row.input) === id && row.result.passed));
  const coverage = [...new Set(final.flatMap(row => row?.result.coverage ?? []))].sort();
  const missingCoverage = requiredCoverage.filter(label => !coverage.includes(label));
  const executionNs = attempts.reduce((sum, row) => sum + BigInt(row.executionNs), 0n);
  const recoveryNs = recoveries.reduce((sum, row) => sum + BigInt(row.executionNs), 0n);
  const publicationNs = [...report.attemptPublicationSamplesNs, ...report.recoveryPublicationSamplesNs]
    .reduce((sum, sample) => sum + BigInt(sample), 0n);
  if (report.executed !== final.filter(Boolean).length || report.passed !== final.filter(row => row?.result.passed).length
    || report.failed !== final.filter(row => !row?.result.passed).length
    || report.filtered !== final.filter(row => row?.result.filtered).length
    || report.filteredAttempts !== attempts.filter(row => row.result.filtered).length
    || report.failedAttempts !== attempts.filter(row => !row.result.passed).length
    || report.candidateExecutionNs !== String(executionNs)
    || report.recoveryExecutionNs !== String(recoveryNs)
    || report.observationPublicationNs !== String(publicationNs)
    || report.generationElapsedNs !== generated.elapsedNs
    || report.generatedCasesPerSecond !== rate(generated.generated, BigInt(generated.elapsedNs))
    || report.attemptedExecutionsPerSecond !== rate(attempts.length, executionNs)
    || report.pipelineCasesPerSecond !== rate(final.filter(Boolean).length, BigInt(report.pipelineElapsedNs))
    || report.complete !== (final.every(Boolean) && attempts.every(row => !row.result.filtered) && missingCoverage.length === 0)
    || JSON.stringify(report.seeds) !== JSON.stringify(generated.seeds)
    || JSON.stringify(report.coverage) !== JSON.stringify(coverage)
    || JSON.stringify(report.missingCoverage) !== JSON.stringify(missingCoverage))
    throw new Error('living pipeline rate or coverage arithmetic changed');
}
