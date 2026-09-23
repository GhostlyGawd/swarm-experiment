/** Exact-token V9 declaration corpus. The explicit JSON role/content frames
 * are local measurement inputs, not an estimate of provider billable tokens. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as b from '../../../../src/tier1/build.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { executableBundle, type ExecutableTarget } from '../../../../src/projection/executable.ts';
import { countTokens } from '../../../../src/util/tokens.ts';

const root = resolve(import.meta.dirname, '../../../..');
const paths = [
  'roadmap/v4/research/projections/declarations-measure.ts',
  'src/projection/executable.ts', 'src/projection/executable-runtime.ts',
  'src/projection/executable-declarations.ts', 'src/projection/executable-link.ts',
  'src/util/tokens.ts', 'src/tier1/ast.ts', 'package-lock.json',
];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(paths.map(path => [path, sha(readFileSync(join(root, path)))]));
const command = (args: readonly string[]) => {
  const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
function cleanCommit(): string {
  if (command(['status', '--porcelain'])) throw new Error('V9 token campaign requires clean source');
  return command(['rev-parse', 'HEAD']);
}
function fixtures() {
  const symbols = new SymbolSpace('declaration-tokens-v9');
  const declared = symbols.define('declared'), main = symbols.define('main');
  const declaration = b.fn({ symbol: declared, returns: b.Int,
    contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(7)), 'declared-result')] }), body: null });
  const local = b.module_({ symbol: symbols.define('local'), symbolTable: symbols.table(), members: [
    declaration, b.fn({ symbol: main, returns: b.Int, body: b.ret(b.int(7)) }),
  ] });
  const library = b.module_({ symbol: symbols.define('library'), symbolTable: symbols.table(), members: [declaration] });
  const ref = new GraphStore().intern(library);
  const imported = b.module_({ symbol: symbols.define('imported'), symbolTable: symbols.table(), members: [
    b.import_(ref, [declared]), b.fn({ symbol: main, returns: b.Int, body: b.ret(b.call(declared)) }),
  ] });
  return { symbols, cases: [
    { name: 'local-null-body', module: local, modules: new Map() },
    { name: 'exact-import-null-body', module: imported, modules: new Map([[ref, library]]) },
  ] };
}
type Message = { role: 'system' | 'user'; content: string };
function corpus() {
  const { symbols, cases } = fixtures();
  const rows = [], messages: Record<string, Message[]> = {};
  for (const item of cases) for (const target of ['typescript', 'python', 'rust'] as const satisfies readonly ExecutableTarget[]) {
    const bundle = executableBundle(item.module, symbols, target, { modules: item.modules });
    const key = `${item.name}:${target}`;
    const payload: Message[] = [
      { role: 'system', content: bundle.runtime },
      ...[...(bundle.dependencies ?? new Map())].sort(([a], [b]) => a.localeCompare(b))
        .map(([name, source]) => ({ role: 'user' as const, content: `# ${name}\n${source}` })),
      { role: 'user', content: bundle.source },
    ];
    messages[key] = payload;
    const framed = payload.map(message => JSON.stringify(message));
    rows.push({ case: item.name, target, root: new GraphStore().intern(item.module),
      messageCount: framed.length, bytes: framed.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      cl100kTokens: framed.reduce((sum, text) => sum + countTokens(text, 'cl100k_base'), 0),
      o200kTokens: framed.reduce((sum, text) => sum + countTokens(text, 'o200k_base'), 0) });
  }
  return { rows, messages };
}
function canonical(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
export function measure(directory: string): string {
  directory = resolve(directory);
  if (existsSync(directory)) throw new Error('V9 token output already exists');
  const commit = cleanCommit(), sourceHashes = hashes();
  const result = corpus(); mkdirSync(directory, { recursive: true });
  canonical(join(directory, 'messages.json'), result.messages);
  canonical(join(directory, 'report.json'), { format: 'aether.declaration-token-corpus/1', commit,
    recordedAt: new Date().toISOString(), sourceHashes,
    tokenizer: { package: 'js-tiktoken', lockfileSha256: sourceHashes['package-lock.json'],
      encodings: ['cl100k_base', 'o200k_base'] },
    framing: 'sum of actual BPE counts over each complete JSON role/content message; local measurement, not API billing',
    messagesSha256: sha(readFileSync(join(directory, 'messages.json'))), rows: result.rows,
    release4xVerdict: 'not_qualified_by_this_corpus' });
  return join(directory, 'report.json');
}
export function verify(directory: string): string {
  directory = resolve(directory);
  const bytes = readFileSync(join(directory, 'report.json'), 'utf8'), report = JSON.parse(bytes);
  assert.equal(bytes, JSON.stringify(report, null, 2) + '\n');
  assert.equal(report.format, 'aether.declaration-token-corpus/1');
  assert.equal(report.commit, cleanCommit()); assert.deepEqual(report.sourceHashes, hashes());
  assert.equal(report.tokenizer.lockfileSha256, report.sourceHashes['package-lock.json']);
  assert.equal(report.release4xVerdict, 'not_qualified_by_this_corpus');
  const messageBytes = readFileSync(join(directory, 'messages.json'), 'utf8');
  assert.equal(report.messagesSha256, sha(messageBytes));
  const retained = JSON.parse(messageBytes), reconstructed = corpus();
  assert.equal(messageBytes, JSON.stringify(retained, null, 2) + '\n');
  assert.deepEqual(retained, reconstructed.messages);
  assert.deepEqual(report.rows, reconstructed.rows);
  return join(directory, 'report.json');
}
const [action, path] = process.argv.slice(2);
if (action && path) {
  if (action === 'measure') process.stdout.write(`${measure(path)}\n`);
  else if (action === 'verify') process.stdout.write(`${verify(path)}\n`);
  else throw new Error('usage: declarations-measure.ts measure|verify <directory>');
}
