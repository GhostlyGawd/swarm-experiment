/** Research measurement of AE5R warm references on the unchanged v4 ledger
 * baseline. Cold and changed-session messages remain AE1 and are charged. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ledgerCorpus } from '../../../../bench/v4/tokens.ts';
import { buildLedgerExample } from '../../../../src/examples/ledger.ts';
import { AgentIrWarmReferenceV5 } from '../../../../src/tier1/agent-ir-v5.ts';
import { IrContext, decode } from '../../../../src/tier1/agent-ir.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { countTokens } from '../../../../src/util/tokens.ts';

const root = resolve(import.meta.dirname, '../../../..');
const paths = ['roadmap/v4/research/agent-ir5/measure.ts', 'src/tier1/agent-ir-v5.ts',
  'src/tier1/agent-ir-v2.ts', 'src/tier1/agent-ir.ts', 'src/tier1/store.ts',
  'bench/v4/tokens.ts', 'src/examples/ledger.ts', 'src/util/tokens.ts', 'package-lock.json'];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(paths.map(path => [path, sha(readFileSync(join(root, path)))]));
function git(args: readonly string[]): string {
  const child = spawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(child.stderr);
  return child.stdout.trim();
}
function cleanCommit(): string {
  if (git(['status', '--porcelain'])) throw new Error('AE5 measurement needs clean source');
  return git(['rev-parse', 'HEAD']);
}
function corpus() {
  const workload = ledgerCorpus()[0], example = buildLedgerExample();
  if (example.module.kind !== 'Module') throw new TypeError('ledger fixture module');
  const module = example.module;
  const cold = decode(workload.cold.candidate, new IrContext());
  assert.equal(new GraphStore().intern(cold), new GraphStore().intern(module));
  const sender = new AgentIrWarmReferenceV5(module), receiver = new AgentIrWarmReferenceV5(cold);
  assert.equal(sender.baseRoot, receiver.baseRoot);
  const references = workload.changes.map(change => {
    const index = module.members.findIndex(member => member.kind === 'FunctionDecl'
      && example.syms.nameOf(member.symbol) === change.id);
    if (index < 0) throw new TypeError('warm declaration absent from paid cold module');
    const declaration = module.members[index];
    if (declaration.kind !== 'FunctionDecl') throw new TypeError('warm member type');
    const wire = sender.encode(index, declaration), restored = receiver.decode(wire);
    assert.equal(new GraphStore().intern(restored), new GraphStore().intern(declaration));
    return { id: change.id, index, wire, root: new GraphStore().intern(declaration), baseline: change.baseline };
  });
  const rows = (['cl100k_base', 'o200k_base'] as const).map(tokenizer => {
    const count = (text: string) => countTokens(text, tokenizer);
    const warm = references.map(reference => ({ id: reference.id, index: reference.index, root: reference.root,
      baselineTokens: count(reference.baseline), candidateTokens: count(reference.wire) }));
    const baselineWarm = warm.reduce((sum, row) => sum + row.baselineTokens, 0);
    const candidateWarm = warm.reduce((sum, row) => sum + row.candidateTokens, 0);
    const baselineSession = workload.session.reduce((sum, message) => sum + count(JSON.stringify({ role: message.role,
      purpose: message.purpose, content: message.baseline }) + '\n'), 0);
    const candidateSession = workload.session.reduce((sum, message) => sum + count(JSON.stringify({ role: message.role,
      purpose: message.purpose, content: message.candidate }) + '\n'), 0);
    return { tokenizer, warm, baselineWarm, candidateWarm, warmRatio: baselineWarm / candidateWarm,
      warmFourfold: baselineWarm / candidateWarm >= 4,
      baselineCold: count(workload.cold.baseline), candidateCold: count(workload.cold.candidate),
      coldRatio: count(workload.cold.baseline) / count(workload.cold.candidate),
      baselineSession, candidateSession, sessionRatio: baselineSession / candidateSession };
  });
  return { workload: workload.id, baseRoot: sender.baseRoot, references, rows,
    cold: workload.cold, session: workload.session };
}
function canonical(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
export function measure(directory: string): string {
  directory = resolve(directory);
  if (existsSync(directory)) throw new Error('AE5 output already exists');
  const commit = cleanCommit(), sourceHashes = hashes(), data = corpus();
  mkdirSync(directory, { recursive: true });
  canonical(join(directory, 'messages.json'), { cold: data.cold, references: data.references,
    session: data.session });
  const report = { format: 'aether.agent-ir5-warm-campaign/1', recordedAt: new Date().toISOString(),
    commit, sourceHashes, baseline: 'bench/v4/tokens.ts ledger-baseline/1 unchanged',
    tokenizerPackage: 'js-tiktoken@1.0.21', baseRoot: data.baseRoot,
    workload: data.workload, references: data.references.length,
    messagesSha256: sha(readFileSync(join(directory, 'messages.json'))),
    rows: data.rows, requiredWarmThreshold: 4,
    scope: 'Research-only AE5R warm unchanged declarations. Full cold and changed-session costs retained; no Q03 or FR-1.2 completion claim.' };
  canonical(join(directory, 'report.json'), report);
  return join(directory, 'report.json');
}
export function verify(directory: string): string {
  directory = resolve(directory);
  const reportBytes = readFileSync(join(directory, 'report.json'), 'utf8'), report = JSON.parse(reportBytes);
  assert.equal(reportBytes, JSON.stringify(report, null, 2) + '\n');
  assert.equal(report.format, 'aether.agent-ir5-warm-campaign/1');
  assert.equal(report.commit, cleanCommit()); assert.deepEqual(report.sourceHashes, hashes());
  assert.equal(report.requiredWarmThreshold, 4);
  const messageBytes = readFileSync(join(directory, 'messages.json'), 'utf8'), messages = JSON.parse(messageBytes);
  assert.equal(messageBytes, JSON.stringify(messages, null, 2) + '\n');
  assert.equal(report.messagesSha256, sha(messageBytes));
  const data = corpus();
  assert.deepEqual(messages, { cold: data.cold, references: data.references, session: data.session });
  assert.equal(report.workload, data.workload); assert.equal(report.baseRoot, data.baseRoot);
  assert.equal(report.references, data.references.length); assert.deepEqual(report.rows, data.rows);
  return join(directory, 'report.json');
}
const [action, path] = process.argv.slice(2);
if (action && path) {
  if (action === 'measure') process.stdout.write(`${measure(path)}\n`);
  else if (action === 'verify') process.stdout.write(`${verify(path)}\n`);
  else throw new Error('usage: measure.ts measure|verify <new-directory>');
}
