import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { typecheck } from '../../../../src/tier2/typecheck.ts';
import { Runtime } from '../../../../src/tier3/runtime.ts';
import { executableBundle, parseExecutableBundle } from '../../../../src/projection/executable.ts';
import { projectTypeScript } from '../../../../src/projection/typescript.ts';
import { encodeAgentIrModel } from '../../../../src/tier1/agent-ir-v2.ts';
import { countTokens } from '../../../../src/util/tokens.ts';
import { validContractContexts } from './corpus-valid-contract-contexts.ts';

const directory = resolve(process.argv[2] ?? '/private/tmp/aether-valid-context-v16');
if (existsSync(directory)) throw new Error('refusing to overwrite an audit');
const sourcePaths = [
  'roadmap/v4/research/projections/corpus-valid-contract-contexts.ts',
  'roadmap/v4/research/projections/audit-valid-contexts-v16.ts',
  'roadmap/v4/research/projections/verify-valid-contexts-v16.ts',
  'src/projection/executable-contract-certificates.ts',
  'src/projection/executable-contract-closures.ts',
  'src/projection/executable-runtime.ts',
  'src/projection/executable.ts',
  'src/tier1/agent-ir-v2.ts',
  'src/util/tokens.ts',
];
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sources = sourcePaths.map(path => ({ path, sha256: sha256(readFileSync(path)) }));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const before = execFileSync('git', ['status', '--short'], { encoding: 'utf8' });
const tokenizers = ['cl100k_base', 'o200k_base'] as const;
type NativeAudit = { status: 'round_trip' | 'refused' | 'unqualified_native'; reason?: string;
  sourceSha256?: string; sourceTokens?: Record<string, number> };
const samples: Array<{ id: string; root: string; legacyTsReview: string; ae2CompleteModel: string }> = [];
const rows = validContractContexts().map(row => {
  const checked = typecheck(row.module, { registry: new CapabilityRegistry() });
  if (!checked.ok) throw new Error(`${row.id}: invalid generated AST: ${checked.diagnostics.map(d => d.message).join('; ')}`);
  const reference = new Runtime({ registry: new CapabilityRegistry() }).load(row.module).call(row.entry, []);
  if (!reference.ok || reference.value !== 1n) throw new Error(`${row.id}: reference execution missed`);
  const store = new GraphStore(), root = store.intern(row.module);
  const baseline = projectTypeScript(row.module, row.symbols);
  const model = encodeAgentIrModel(row.module);
  samples.push({ id: row.id, root, legacyTsReview: baseline, ae2CompleteModel: model });
  const costs = Object.fromEntries(tokenizers.map(tokenizer => [tokenizer, {
    legacyTsReviewTokens: countTokens(baseline, tokenizer),
    ae2CompleteModelTokens: countTokens(model, tokenizer),
  }]));
  const native = Object.fromEntries((['typescript', 'python', 'rust'] as const).map(target => {
    try {
      const bundle = executableBundle(row.module, row.symbols, target);
      if (store.intern(parseExecutableBundle(bundle).module) !== root) throw new Error('native root mismatch');
      const first = bundle.source.split('\n')[0];
      const header = JSON.parse(first.slice(first.indexOf('{')));
      if(row.carrier==='passed_parameter'&&/ae_contract_apply!?\(ctx,/.test(bundle.source)
        &&header.closureCertificates?.length===0)
        return [target, { status: 'unqualified_native' as const,
          reason: 'passed closure has no checked certificate; contract guard refuses at execution',
          sourceSha256: sha256(bundle.source) }];
      return [target, { status: 'round_trip' as const, sourceSha256: sha256(bundle.source),
        sourceTokens: Object.fromEntries(tokenizers.map(tokenizer => [tokenizer, countTokens(bundle.source, tokenizer)])) }];
    } catch (error) {
      return [target, { status: 'refused' as const, reason: String(error) }];
    }
  })) as Record<'typescript' | 'python' | 'rust', NativeAudit>;
  return { id: row.id, bodyForm: row.bodyForm, carrier: row.carrier, root, reference: 'pass', costs, native };
});
const aggregate = Object.fromEntries(tokenizers.map(tokenizer => {
  const legacy = rows.reduce((sum, row) => sum + row.costs[tokenizer].legacyTsReviewTokens, 0);
  const ae2 = rows.reduce((sum, row) => sum + row.costs[tokenizer].ae2CompleteModelTokens, 0);
  return [tokenizer, { legacyTsReviewTokens: legacy, ae2CompleteModelTokens: ae2,
    ratioOfSums: legacy / ae2, meetsFourfoldDiagnostic: legacy / ae2 >= 4 }];
}));
for (const source of sources) if (sha256(readFileSync(source.path)) !== source.sha256)
  throw new Error('source changed during audit');
mkdirSync(directory, { recursive: true });
const samplesText = JSON.stringify(samples, null, 2) + '\n';
writeFileSync(resolve(directory, 'samples.json'), samplesText);
const report = { format: 'aether.valid-contract-context-audit/1', profile: 'aether.executable-projection/16',
  specVersion: '0.1.0', commit, gitStatusBefore: before, node: process.version,
  tokenizerPackage: { name: 'js-tiktoken', version: JSON.parse(readFileSync('node_modules/js-tiktoken/package.json', 'utf8')).version },
  scope: '55 generated reference-valid AST contexts, three native parser/round-trip checks each; authored diagnostic, not representative FR-1.2 or Q03 release qualification',
  sources, samplesArtifact: 'samples.json', samplesSha256: sha256(samplesText), rows, aggregate };
writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ directory, commit, rows: rows.length, aggregate,
  refused: rows.flatMap(row => Object.entries(row.native).filter(([, value]) => value.status !== 'round_trip')
    .map(([target, value]) => ({ id: row.id, target, reason: 'reason' in value ? value.reason : '' }))) }, null, 2));
