/** Independent AE8 raw-sample, graph-root and dual-BPE verifier. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { densityCorpusV7 } from '../agent-ir7/corpus.ts';
import { children, withChildren } from '../../../../src/tier1/ast.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { AgentIrGraphSliceSessionV8 } from '../../../../src/tier1/agent-ir-v8.ts';
import { encodeAgentIrColdV7 } from '../../../../src/tier1/agent-ir-v7.ts';
import { projectTypeScript } from '../../../../src/projection/typescript.ts';

if (!process.argv[2]) throw new Error('usage: verify.mjs <evidence-directory>');
const dir = resolve(process.argv[2]), repo = resolve(import.meta.dirname, '../../../..');
const samples = JSON.parse(readFileSync(join(dir, 'samples.json'), 'utf8'));
const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
assert.equal(samples.format, 'aether.agent-ir8.raw-samples/1');
assert.equal(report.format, 'aether.agent-ir8.actual-token-report/1');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(report.sourceCommit, source, 'exact source commit');
for (const path of ['roadmap/v4/research/agent-ir8/REGISTRATION.md',
  'roadmap/v4/research/agent-ir8/measure.ts', 'roadmap/v4/research/agent-ir8/verify.mjs',
  'src/tier1/agent-ir-v8.ts', 'src/tier1/agent-ir-v7.ts', 'src/tier1/store.ts',
  'src/projection/typescript.ts', 'src/util/tokens.ts', 'package-lock.json'])
  assert.ok(report.sourceHashes[path], `required source hash: ${path}`);
for (const [path, expected] of Object.entries(report.sourceHashes))
  assert.equal(createHash('sha256').update(readFileSync(join(repo, path))).digest('hex'), expected, path);
assert.equal(JSON.parse(readFileSync(join(repo, 'node_modules/js-tiktoken/package.json'), 'utf8')).version, '1.0.21');
const fixtures = densityCorpusV7();
assert.equal(samples.rows.length, fixtures.length);
const root = term => new GraphStore().intern(term);
const frame = (role, purpose, content) => JSON.stringify({ role, purpose, content }) + '\n';
function firstInteger(node, path = []) {
  if (node.kind === 'Lit' && typeof node.value === 'bigint') return { path, value: node.value };
  for (const [i, child] of children(node).entries()) {
    const hit = firstInteger(child, [...path, i]);
    if (hit) return hit;
  }
  return null;
}
function replace(node, path, value) {
  if (!path.length) {
    assert.equal(node.kind, 'Lit');
    assert.equal(typeof node.value, 'bigint');
    return { ...node, value };
  }
  const next = [...children(node)], [i, ...tail] = path;
  next[i] = replace(next[i], tail, value);
  return withChildren(node, next);
}
const sequence = [
  ['system', 'instructions'], ['user', 'initial_context'], ['user', 'change_request'],
  ['assistant', 'selection'], ['tool', 'retrieval'], ['assistant', 'failed_attempt'],
  ['tool', 'repair'], ['assistant', 'change'], ['tool', 'response'],
];
const common = new Map([
  [0, 'Preserve every contract and effect. Select the requested declaration, then return a complete corrected declaration after feedback.'],
  [2, 'Increase the first integer literal in the first eligible function body by one. Preserve all other AST fields.'],
  [6, 'The submitted declaration left that literal unchanged. Apply the requested edit.'],
  [8, 'The changed declaration, contract, dependencies and complete module root were checked.'],
]);
for (const [i, row] of samples.rows.entries()) {
  const fixture = fixtures[i], module = fixture.module;
  assert.equal(row.id, fixture.id);
  assert.equal(row.seed, fixture.seed);
  assert.equal(row.baseRoot, root(module));
  const selected = module.members.findIndex(member => member.kind === 'FunctionDecl'
    && member.body && firstInteger(member.body));
  assert.equal(row.memberIndex, selected);
  const original = module.members[selected];
  const chosen = firstInteger(original.body);
  assert.deepEqual(row.path, chosen.path);
  assert.equal(row.originalInteger, chosen.value.toString());
  assert.equal(BigInt(row.changedInteger), chosen.value + 1n);
  const edited = { ...original, body: replace(original.body, chosen.path, chosen.value + 1n) };
  const changed = { ...module, members: module.members.map((member, index) => index === selected ? edited : member) };
  assert.equal(row.changedRoot, root(changed));
  assert.equal(row.raw.cold.baseline, projectTypeScript(module, fixture.symbols, {}));
  assert.equal(row.raw.cold.candidate, encodeAgentIrColdV7(module, fixture.seed));
  assert.equal(row.raw.selection.baseline, `SELECT ${fixture.symbols.nameOf(original.symbol)}`);
  assert.equal(row.raw.retrieval.baseline, projectTypeScript(original, fixture.symbols, {}));
  assert.equal(row.raw.failed.baseline, row.raw.retrieval.baseline);
  assert.equal(row.raw.repaired.baseline, projectTypeScript(edited, fixture.symbols, {}));
  const sender = new AgentIrGraphSliceSessionV8(row.raw.cold.candidate);
  const receiver = new AgentIrGraphSliceSessionV8(row.raw.cold.candidate);
  assert.equal(row.raw.selection.candidate, sender.select(selected));
  assert.equal(row.raw.retrieval.candidate, sender.retrieve(row.raw.selection.candidate));
  const slice = receiver.acceptRetrieval(row.raw.retrieval.candidate);
  assert.deepEqual(row.slice, { declarationRoot: slice.declarationRoot, contractRoot: slice.contractRoot,
    dependencies: slice.dependencies, effects: slice.effects });
  assert.equal(row.raw.failed.candidate, sender.encode(selected, original));
  assert.equal(row.raw.repaired.candidate, sender.encode(selected, edited));
  assert.equal(root(receiver.decode(row.raw.failed.candidate).module), row.baseRoot);
  assert.equal(root(receiver.decode(row.raw.repaired.candidate).module), row.changedRoot);
  assert.deepEqual(row.messages.map(message => [message.role, message.purpose]), sequence);
  assert.equal(row.messages.length, 9);
  const positions = [null, 'cold', null, 'selection', 'retrieval', 'failed', null, 'repaired', null];
  for (const [position, message] of row.messages.entries()) {
    for (const side of ['baseline', 'candidate']) {
      const parsed = JSON.parse(message[side]);
      const expected = common.has(position) ? common.get(position) : row.raw[positions[position]][side];
      assert.equal(message[side], frame(message.role, message.purpose, expected), 'exact frame/content');
      assert.equal(parsed.content, expected);
    }
    if (common.has(position)) assert.equal(message.baseline, message.candidate);
  }
}
const counts = {};
for (const encoding of ['cl100k_base', 'o200k_base']) {
  const tokenizer = getEncoding(encoding);
  const pair = row => ({ baseline: tokenizer.encode(row.baseline).length,
    candidate: tokenizer.encode(row.candidate).length });
  const sum = parts => {
    const baseline = parts.reduce((n, p) => n + p.baseline, 0);
    const candidate = parts.reduce((n, p) => n + p.candidate, 0);
    return { baseline, candidate, ratio: baseline / candidate, passes4x: baseline >= 4 * candidate };
  };
  const workloads = samples.rows.map(row => ({ id: row.id,
    cold: sum([pair(row.raw.cold)]), selection: sum([pair(row.raw.selection)]),
    retrieval: sum([pair(row.raw.retrieval)]), repaired: sum([pair(row.raw.repaired)]),
    session: sum(row.messages.map(pair)),
    messages: row.messages.map(message => ({ role: message.role, purpose: message.purpose, ...pair(message) })),
  }));
  counts[encoding] = { workloads, aggregate: {
    cold: sum(workloads.map(row => row.cold)),
    selection: sum(workloads.map(row => row.selection)),
    retrieval: sum(workloads.map(row => row.retrieval)),
    repaired: sum(workloads.map(row => row.repaired)),
    session: sum(workloads.map(row => row.session)),
  } };
}
assert.deepEqual(report.counts, counts, 'independent raw-sample BPE recount');
console.log(JSON.stringify({ sourceCommit: source, aggregate: Object.fromEntries(
  Object.entries(counts).map(([name, value]) => [name, value.aggregate])) }, null, 2));
