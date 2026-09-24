import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { executableBundle, parseExecutableBundle } from '../../../../src/projection/executable.ts';
import { countTokens } from '../../../../src/util/tokens.ts';
import { validContractContexts } from './corpus-valid-contract-contexts.ts';

const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new TypeError('audit directory required');
const exactSource = process.argv.includes('--exact-source');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const report = JSON.parse(readFileSync(resolve(directory, 'report.json'), 'utf8'));
const samplesText = readFileSync(resolve(directory, 'samples.json'), 'utf8');
const samples = JSON.parse(samplesText);
if (report.format !== 'aether.valid-contract-context-audit/2' || report.profile !== 'aether.executable-projection/17'
  || report.samplesArtifact !== 'samples.json' || report.samplesSha256 !== sha256(samplesText)
  || !Array.isArray(samples) || !Array.isArray(report.rows) || samples.length !== report.rows.length)
  throw new Error('audit envelope or raw samples mismatch');
const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const evidenceOnlyDescendant = currentCommit !== report.commit
  && spawnSync('git', ['merge-base', '--is-ancestor', report.commit, currentCommit]).status === 0
  && execFileSync('git', ['diff', '--name-only', report.commit, currentCommit], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).every(path => path.startsWith(`docs/implementation/v4/evidence/${basename(directory)}/`));
const sourceMatches = report.gitStatusBefore === '' && (currentCommit === report.commit || evidenceOnlyDescendant)
  && report.sources.every((source: { path: string; sha256: string }) =>
  sha256(readFileSync(source.path)) === source.sha256);
if (exactSource && !sourceMatches) throw new Error('audit source mismatch');
const tokenizers = ['cl100k_base', 'o200k_base'] as const;
for (let i = 0; i < samples.length; i++) {
  const sample = samples[i], row = report.rows[i];
  if (sample.id !== row.id || sample.root !== row.root) throw new Error(`sample identity ${i}`);
  for (const tokenizer of tokenizers) {
    if (countTokens(sample.legacyTsReview, tokenizer) !== row.costs[tokenizer].legacyTsReviewTokens
      || countTokens(sample.ae2CompleteModel, tokenizer) !== row.costs[tokenizer].ae2CompleteModelTokens)
      throw new Error(`token recount ${row.id}/${tokenizer}`);
  }
}
for (const tokenizer of tokenizers) {
  const legacy = report.rows.reduce((sum: number, row: { costs: Record<string, { legacyTsReviewTokens: number }> }) =>
    sum + row.costs[tokenizer].legacyTsReviewTokens, 0);
  const ae2 = report.rows.reduce((sum: number, row: { costs: Record<string, { ae2CompleteModelTokens: number }> }) =>
    sum + row.costs[tokenizer].ae2CompleteModelTokens, 0);
  const aggregate = report.aggregate[tokenizer];
  if (legacy !== aggregate.legacyTsReviewTokens || ae2 !== aggregate.ae2CompleteModelTokens
    || legacy / ae2 !== aggregate.ratioOfSums || (legacy / ae2 >= 4) !== aggregate.meetsFourfoldDiagnostic)
    throw new Error(`aggregate recount ${tokenizer}`);
}
if (sourceMatches) {
  const contexts = validContractContexts(17);
  if (contexts.length !== report.rows.length) throw new Error('corpus row count');
  for (let i = 0; i < contexts.length; i++) {
    const context = contexts[i], row = report.rows[i], store = new GraphStore();
    if (context.id !== row.id || store.intern(context.module) !== row.root) throw new Error(`corpus identity ${i}`);
    for (const target of ['typescript', 'python', 'rust'] as const) {
      const native = row.native[target];
      try {
        const bundle = executableBundle(context.module, context.symbols, target);
        if (store.intern(parseExecutableBundle(bundle).module) !== row.root) throw new Error('native root mismatch');
        const first = bundle.source.split('\n')[0], header = JSON.parse(first.slice(first.indexOf('{')));
        const unqualified = context.carrier === 'passed_parameter' && /ae_contract_apply!?\(ctx,/.test(bundle.source)
          && header.closureCertificates?.length === 0;
        if (native.status !== (unqualified ? 'unqualified_native' : 'round_trip')
          || native.sourceSha256 !== sha256(bundle.source)) throw new Error(`native status ${context.id}/${target}`);
        if (!unqualified) for (const tokenizer of tokenizers)
          if (native.sourceTokens[tokenizer] !== countTokens(bundle.source, tokenizer))
            throw new Error(`native token recount ${context.id}/${target}/${tokenizer}`);
      } catch (error) {
        if (native.status !== 'refused' || native.reason !== String(error)) throw error;
      }
    }
  }
}
console.log(JSON.stringify({ verified: true, sourceMatches, rows: report.rows.length,
  unqualifiedOrRefused: report.rows.flatMap((row: { native: Record<string, { status: string }> }) =>
    Object.values(row.native).filter(native => native.status !== 'round_trip')).length,
  aggregate: report.aggregate }, null, 2));
