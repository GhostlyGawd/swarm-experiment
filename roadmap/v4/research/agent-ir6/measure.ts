/** Exact-source dual-tokenizer AE6 diagnostic. Raw strings are retained. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ledgerV6Corpus, sessionWire } from '../../../../bench/v4/tokens.ts';
import { buildLedgerExample } from '../../../../src/examples/ledger.ts';
import * as b from '../../../../src/tier1/build.ts';
import { encode, IrContext } from '../../../../src/tier1/agent-ir.ts';
import { AgentIrSessionV6 } from '../../../../src/tier1/agent-ir-v6.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { projectTypeScript } from '../../../../src/projection/typescript.ts';
import { countTokens } from '../../../../src/util/tokens.ts';

const root = resolve(import.meta.dirname, '../../../..');
const sourcePaths = [
  'roadmap/v4/research/agent-ir6/measure.ts', 'bench/v4/tokens.ts', 'bench/v4/manifest.ts',
  'src/tier1/agent-ir-v6.ts', 'src/tier1/agent-ir.ts', 'src/tier1/agent-ir-v2.ts',
  'src/tier1/store.ts', 'src/tier1/ast.ts', 'src/examples/ledger.ts',
  'src/projection/typescript.ts', 'src/util/tokens.ts', 'package-lock.json',
];
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sources = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(join(root, path)))]));
function git(...args: string[]): string { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function cleanSource(): string {
  if (git('status', '--porcelain')) throw new Error('AE6 campaign needs a clean source commit');
  return git('rev-parse', 'HEAD');
}
function data() {
  const workload = ledgerV6Corpus()[0], ex = buildLedgerExample();
  if (ex.module.kind !== 'Module') throw new TypeError('ledger module');
  const index = ex.module.members.findIndex(member => member.kind === 'FunctionDecl' && member.symbol === ex.symbols.feeFor);
  const original = ex.module.members[index];
  if (original.kind !== 'FunctionDecl') throw new TypeError('feeFor declaration');
  const repaired = { ...original, body: b.block(b.ret(b.div(b.v(original.params[0].symbol), b.int(200)))) };
  const changedModule = { ...ex.module, members: ex.module.members.map((member, i) => i === index ? repaired : member) };
  const codec = new AgentIrSessionV6(workload.cold.candidate), edit = codec.encode(index, repaired);
  assert.equal(new GraphStore().intern(codec.decode(edit).module), new GraphStore().intern(changedModule));
  const raw = {
    format: 'aether.agent-ir6.raw-samples/1', workload: workload.id, cold: workload.cold,
    warm: workload.changes.map(change => ({ id: change.id, baseline: change.baseline, candidate: change.candidate,
      framedBaseline: JSON.stringify({ role: 'assistant', purpose: 'change', content: change.baseline }) + '\n',
      framedCandidate: JSON.stringify({ role: 'assistant', purpose: 'change', content: change.candidate }) + '\n' })),
    changedEdit: { baseline: projectTypeScript(repaired, ex.syms, {}), candidate: edit },
    changedFullModule: { baseline: projectTypeScript(changedModule, ex.syms, {}),
      candidate: encode(changedModule, new IrContext()).text },
    session: workload.session.map(message => ({ role: message.role, purpose: message.purpose,
      baseline: sessionWire(message, 'baseline'), candidate: sessionWire(message, 'candidate') })),
    baseRoot: codec.baseRoot, changedRoot: new GraphStore().intern(changedModule),
  };
  const sums = (rows: ReadonlyArray<{ baseline: string; candidate: string }>, encoding: 'cl100k_base' | 'o200k_base') => {
    const samples = rows.map(row => ({ baseline: countTokens(row.baseline, encoding), candidate: countTokens(row.candidate, encoding) }));
    const baseline = samples.reduce((sum, row) => sum + row.baseline, 0);
    const candidate = samples.reduce((sum, row) => sum + row.candidate, 0);
    return { samples, baseline, candidate, ratio: baseline / candidate };
  };
  const counts = (['cl100k_base', 'o200k_base'] as const).map(encoding => ({
    encoding, cold: sums([raw.cold], encoding),
    warm: sums(raw.warm, encoding),
    framedWarm: sums(raw.warm.map(row => ({ baseline: row.framedBaseline, candidate: row.framedCandidate })), encoding),
    changedEdit: sums([raw.changedEdit], encoding),
    changedFullModule: sums([raw.changedFullModule], encoding),
    fullSession: sums(raw.session, encoding),
  }));
  return { raw, counts };
}
function canonical(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
export function measure(directory: string): string {
  directory = resolve(directory);
  if (existsSync(directory)) throw new Error('AE6 result directory already exists');
  const commit = cleanSource(), sourceHashes = sources(), { raw, counts } = data();
  mkdirSync(directory, { recursive: true });
  canonical(join(directory, 'samples.json'), raw);
  const report = { format: 'aether.agent-ir6-measurement/1', commit, sourceHashes,
    samplesSha256: sha(readFileSync(join(directory, 'samples.json'))),
    tokenizerPackage: 'js-tiktoken@1.0.21', counts, requiredWarmRatio: 4,
    scope: 'Deterministic ledger profile only; changed module, cold, and full session are separately charged. No Q03 closure.' };
  canonical(join(directory, 'report.json'), report);
  return join(directory, 'report.json');
}
export function verify(directory: string): string {
  directory = resolve(directory);
  const reportText = readFileSync(join(directory, 'report.json'), 'utf8'), report = JSON.parse(reportText);
  const samplesText = readFileSync(join(directory, 'samples.json'), 'utf8'), samples = JSON.parse(samplesText);
  assert.equal(reportText, JSON.stringify(report, null, 2) + '\n');
  assert.equal(samplesText, JSON.stringify(samples, null, 2) + '\n');
  assert.equal(report.format, 'aether.agent-ir6-measurement/1');
  assert.equal(report.commit, cleanSource());
  assert.deepEqual(report.sourceHashes, sources());
  assert.equal(report.samplesSha256, sha(samplesText));
  assert.equal(report.tokenizerPackage, 'js-tiktoken@1.0.21');
  assert.equal(report.requiredWarmRatio, 4);
  const current = data();
  assert.deepEqual(samples, current.raw);
  assert.deepEqual(report.counts, current.counts);
  return join(directory, 'report.json');
}
const [action, path] = process.argv.slice(2);
if (action && path) {
  if (action === 'measure') process.stdout.write(`${measure(path)}\n`);
  else if (action === 'verify') process.stdout.write(`${verify(path)}\n`);
  else throw new Error('usage: measure.ts measure|verify <directory>');
}
