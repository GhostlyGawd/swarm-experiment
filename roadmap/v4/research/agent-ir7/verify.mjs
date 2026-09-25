/** Independent raw-string BPE recount and exact-source/root verifier. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { densityCorpusV7 } from './corpus.ts';
import { children, withChildren } from '../../../../src/tier1/ast.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { decodeAgentIrColdV7, AgentIrSessionV7 } from '../../../../src/tier1/agent-ir-v7.ts';
import { AgentIrSessionV6 } from '../../../../src/tier1/agent-ir-v6.ts';
import { encode, IrContext } from '../../../../src/tier1/agent-ir.ts';
import { projectTypeScript } from '../../../../src/projection/typescript.ts';

const dir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: verify.mjs <evidence-directory>');
const repo = resolve(import.meta.dirname, '../../../..');
const samples = JSON.parse(readFileSync(join(dir, 'samples.json'), 'utf8'));
const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
assert.equal(samples.format, 'aether.agent-ir7.raw-samples/1');
assert.equal(report.format, 'aether.agent-ir7.actual-token-report/1');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(report.sourceCommit, source, 'exact source commit');
for (const required of ['roadmap/v4/research/agent-ir7/REGISTRATION.md',
  'roadmap/v4/research/agent-ir7/measure.ts', 'roadmap/v4/research/agent-ir7/verify.mjs',
  'src/tier1/agent-ir-v7.ts', 'src/tier1/agent-ir-v6.ts', 'src/tier1/agent-ir.ts',
  'src/tier1/ast.ts', 'src/tier1/store.ts', 'src/examples/ledger.ts',
  'src/projection/typescript.ts', 'src/util/tokens.ts', 'bench/v4/tokens.ts',
  'package-lock.json']) assert.ok(report.sourceHashes[required], `source inventory: ${required}`);
for (const [path, expected] of Object.entries(report.sourceHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(join(repo, path))).digest('hex'), expected, `source hash: ${path}`);
}
assert.equal(JSON.parse(readFileSync(join(repo, 'node_modules/js-tiktoken/package.json'), 'utf8')).version, '1.0.21');
const fixtures = densityCorpusV7();
assert.equal(samples.rows.length, fixtures.length);
const root = term => new GraphStore().intern(term);
function firstInteger(node, path = []) {
  if (node.kind === 'Lit' && typeof node.value === 'bigint') return { path, value: node.value };
  for (const [index, child] of children(node).entries()) {
    const found = firstInteger(child, [...path, index]);
    if (found) return found;
  }
  return null;
}
function replace(node, path, value) {
  if (!path.length) {
    assert.equal(node.kind, 'Lit');
    assert.equal(typeof node.value, 'bigint');
    return { ...node, value };
  }
  const next = [...children(node)], [index, ...tail] = path;
  next[index] = replace(next[index], tail, value);
  return withChildren(node, next);
}
function frame(role, purpose, content) {
  return JSON.stringify({ role, purpose, content }) + '\n';
}
for (const [i, row] of samples.rows.entries()) {
  const fixture = fixtures[i], module = fixture.module;
  assert.equal(row.id, fixture.id);
  assert.equal(row.seed, fixture.seed);
  assert.equal(row.originalRoot, root(module));
  assert.equal(row.cold.baseline, projectTypeScript(module, fixture.symbols, {}));
  const cold = decodeAgentIrColdV7(row.cold.candidate);
  assert.equal(cold.root, row.originalRoot);
  assert.deepEqual(cold.module, module);
  assert.equal(cold.seed, fixture.seed);
  const firstMember = module.members.findIndex(member => member.kind === 'FunctionDecl'
    && member.body && firstInteger(member.body));
  assert.equal(row.memberIndex, firstMember, 'registered first eligible function');
  const original = module.members[row.memberIndex];
  assert.equal(original.kind, 'FunctionDecl');
  const chosen = firstInteger(original.body);
  assert.deepEqual(row.path, chosen.path, 'registered first body literal');
  assert.equal(row.originalInteger, chosen.value.toString());
  const edit = replace(original.body, row.path, BigInt(row.changedInteger));
  const edited = { ...original, body: edit };
  assert.equal(BigInt(row.changedInteger), BigInt(row.originalInteger) + 1n);
  assert.equal(row.failed.baseline, projectTypeScript(original, fixture.symbols, {}));
  assert.equal(row.repaired.baseline, projectTypeScript(edited, fixture.symbols, {}));
  assert.equal(row.prior.cold, encode(module, new IrContext()).text);
  const prior = new AgentIrSessionV6(row.prior.cold);
  assert.equal(row.prior.failed, prior.encode(row.memberIndex, original));
  assert.equal(row.prior.repaired, prior.encode(row.memberIndex, edited));
  const session = new AgentIrSessionV7(row.cold.candidate);
  assert.equal(session.encode(row.memberIndex, original), row.failed.candidate);
  assert.equal(session.encode(row.memberIndex, edited), row.repaired.candidate);
  assert.equal(root(session.decode(row.failed.candidate).module), row.originalRoot);
  assert.equal(root(session.decode(row.repaired.candidate).declaration), root(edited));
  assert.equal(root(session.decode(row.repaired.candidate).module), row.changedRoot);
  assert.deepEqual(row.session.map(message => [message.role, message.purpose]), [
    ['system', 'instructions'], ['user', 'initial_context'], ['user', 'change_request'],
    ['assistant', 'failed_attempt'], ['tool', 'repair'], ['assistant', 'change'], ['tool', 'response'],
  ]);
  for (const message of row.session) {
    for (const side of ['baseline', 'candidate']) {
      const parsed = JSON.parse(message[side]);
      assert.equal(message[side], frame(message.role, message.purpose, parsed.content), 'exact JSONL framing');
    }
  }
  assert.equal(JSON.parse(row.session[1].baseline).content, row.cold.baseline);
  assert.equal(JSON.parse(row.session[1].candidate).content, row.cold.candidate);
  assert.equal(JSON.parse(row.session[3].baseline).content, row.failed.baseline);
  assert.equal(JSON.parse(row.session[3].candidate).content, row.failed.candidate);
  assert.equal(JSON.parse(row.session[5].baseline).content, row.repaired.baseline);
  assert.equal(JSON.parse(row.session[5].candidate).content, row.repaired.candidate);
  for (const position of [0, 2, 4, 6])
    assert.equal(row.session[position].baseline, row.session[position].candidate, 'same non-code messages');
  assert.deepEqual([0, 2, 4, 6].map(position => JSON.parse(row.session[position].baseline).content), [
    'Return a complete updated declaration preserving all contracts and effects. Correct failed attempts using tool feedback.',
    'Increase the first integer literal in the first eligible function body by one. Preserve all other AST fields.',
    'The submitted declaration left that literal unchanged. Apply the requested edit.',
    'The changed declaration and exact module root were checked.',
  ]);
  assert.equal(row.prior.session.length, row.session.length);
  for (const [position, priorWire] of row.prior.session.entries()) {
    const message = row.session[position], parsed = JSON.parse(priorWire);
    const expected = position === 1 ? row.prior.cold : position === 3 ? row.prior.failed
      : position === 5 ? row.prior.repaired : JSON.parse(message.candidate).content;
    assert.equal(priorWire, frame(message.role, message.purpose, expected));
    assert.equal(parsed.content, expected);
  }
}
const counts = {};
for (const name of ['cl100k_base', 'o200k_base']) {
  const tokenizer = getEncoding(name);
  const pair = row => ({ baseline: tokenizer.encode(row.baseline).length, candidate: tokenizer.encode(row.candidate).length });
  const sum = parts => {
    const baseline = parts.reduce((n, p) => n + p.baseline, 0);
    const candidate = parts.reduce((n, p) => n + p.candidate, 0);
    return { baseline, candidate, ratio: baseline / candidate, passes4x: baseline >= 4 * candidate };
  };
  const workloads = samples.rows.map(row => ({
    id: row.id, cold: sum([pair(row.cold)]), repaired: sum([pair(row.repaired)]),
    session: sum(row.session.map(pair)),
    priorCold: tokenizer.encode(row.prior.cold).length,
    priorSession: row.prior.session.reduce((n, message) => n + tokenizer.encode(message).length, 0),
    messages: row.session.map(message => ({ role: message.role, purpose: message.purpose, ...pair(message) })),
  }));
  const aggregateCold = sum(workloads.map(row => row.cold));
  const aggregateSession = sum(workloads.map(row => row.session));
  const priorCold = workloads.reduce((n, row) => n + row.priorCold, 0);
  const priorSession = workloads.reduce((n, row) => n + row.priorSession, 0);
  counts[name] = { workloads, aggregate: {
    cold: aggregateCold,
    repaired: sum(workloads.map(row => row.repaired)),
    session: aggregateSession,
    ae6Control: { cold: priorCold, session: priorSession,
      coldImprovement: priorCold / aggregateCold.candidate,
      sessionImprovement: priorSession / aggregateSession.candidate },
  } };
}
assert.deepEqual(report.counts, counts, 'raw-sample BPE recount');
console.log(JSON.stringify({ sourceCommit: source, aggregate: Object.fromEntries(
  Object.entries(counts).map(([name, value]) => [name, value.aggregate])) }, null, 2));
