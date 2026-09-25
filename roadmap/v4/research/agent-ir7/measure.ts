/** Preregistered offline actual-token campaign. Retains every framed raw string. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { densityCorpusV7 } from './corpus.ts';
import { children, withChildren, type Term } from '../../../../src/tier1/ast.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { AgentIrSessionV7, encodeAgentIrColdV7, decodeAgentIrColdV7 } from '../../../../src/tier1/agent-ir-v7.ts';
import { AgentIrSessionV6 } from '../../../../src/tier1/agent-ir-v6.ts';
import { encode, IrContext } from '../../../../src/tier1/agent-ir.ts';
import { projectTypeScript } from '../../../../src/projection/typescript.ts';
import { sessionWire, type SessionMessage } from '../../../../bench/v4/tokens.ts';
import { countTokens } from '../../../../src/util/tokens.ts';

const repo = resolve(import.meta.dirname, '../../../..');
export const SOURCE_PATHS = [
  'roadmap/v4/research/agent-ir7/REGISTRATION.md',
  'roadmap/v4/research/agent-ir7/corpus.ts',
  'roadmap/v4/research/agent-ir7/measure.ts',
  'roadmap/v4/research/agent-ir7/verify.mjs',
  'src/tier1/agent-ir-v7.ts', 'src/tier1/agent-ir-v6.ts', 'src/tier1/agent-ir.ts',
  'src/tier1/ast.ts', 'src/tier1/ids.ts', 'src/tier1/store.ts',
  'src/tier1/symbols.ts', 'src/util/rng.ts', 'src/util/tokens.ts',
  'src/index.ts', 'src/tier1/index.ts',
  'src/examples/ledger.ts', 'src/projection/typescript.ts',
  'test/tier1/agent-ir.test.ts', 'test/tier1/agent-ir-v7.test.ts',
  'bench/v4/tokens.ts', 'package-lock.json',
  'roadmap/v4/research/projections/corpus.ts',
  'roadmap/v4/research/projections/corpus-composites.ts',
  'roadmap/v4/research/projections/corpus-continuations.ts',
  'roadmap/v4/research/projections/corpus-completion.ts',
];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sourceHashes = () => Object.fromEntries(SOURCE_PATHS.map(path => [path, sha(readFileSync(join(repo, path)))]));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const root = (term: Term) => new GraphStore().intern(term);

function firstBodyInteger(node: Term, path: number[] = []): { path: number[]; value: bigint } | null {
  if (node.kind === 'Lit' && typeof node.value === 'bigint') return { path, value: node.value };
  for (const [i, child] of children(node).entries()) {
    const hit = firstBodyInteger(child, [...path, i]);
    if (hit) return hit;
  }
  return null;
}
function replaceInteger(node: Term, path: readonly number[], value: bigint): Term {
  if (!path.length) {
    if (node.kind !== 'Lit' || typeof node.value !== 'bigint') throw new TypeError('registered integer edit');
    return { ...node, value };
  }
  const next = [...children(node)], [index, ...tail] = path;
  next[index] = replaceInteger(next[index], tail, value);
  return withChildren(node, next);
}

function collect() {
  const fixtures = densityCorpusV7();
  assert.deepEqual(fixtures.map(f => f.id), [
    'ledger', 'scalar-math', 'loop-contract', 'external-effect', 'fixed-lazy',
    'composite-alias-collections', 'continuation-capture-task', 'scalar-five-kind-completion',
  ]);
  return fixtures.map(fixture => {
    const module = fixture.module;
    if (module.kind !== 'Module') throw new TypeError('registered module');
    const baselineCold = projectTypeScript(module, fixture.symbols, {});
    const candidateCold = encodeAgentIrColdV7(module, fixture.seed);
    const priorCold = encode(module, new IrContext()).text;
    const cold = decodeAgentIrColdV7(candidateCold);
    assert.equal(cold.root, root(module));
    assert.deepEqual(cold.module, module);
    const index = module.members.findIndex(member => member.kind === 'FunctionDecl'
      && member.body && firstBodyInteger(member.body));
    if (index < 0) throw new TypeError(`registered integer edit missing: ${fixture.id}`);
    const original = module.members[index];
    if (original.kind !== 'FunctionDecl' || !original.body) throw new TypeError('registered function');
    const chosen = firstBodyInteger(original.body)!;
    const edited = { ...original, body: replaceInteger(original.body, chosen.path, chosen.value + 1n) };
    const sender = new AgentIrSessionV7(candidateCold), receiver = new AgentIrSessionV7(candidateCold);
    const failed = sender.encode(index, original), repaired = sender.encode(index, edited);
    const prior = new AgentIrSessionV6(priorCold);
    const priorFailed = prior.encode(index, original), priorRepaired = prior.encode(index, edited);
    assert.equal(root(receiver.decode(failed).module), root(module));
    const expectedModule = { ...module, members: module.members.map((member, i) => i === index ? edited : member) };
    assert.equal(root(receiver.decode(repaired).module), root(expectedModule));
    assert.equal(root(receiver.decode(repaired).declaration), root(edited));
    const baselineDeclaration = projectTypeScript(original, fixture.symbols, {});
    const baselineEdited = projectTypeScript(edited, fixture.symbols, {});
    const same = (content: string) => ({ baseline: content, candidate: content });
    const session: SessionMessage[] = [
      { role: 'system', purpose: 'instructions', ...same('Return a complete updated declaration preserving all contracts and effects. Correct failed attempts using tool feedback.') },
      { role: 'user', purpose: 'initial_context', baseline: baselineCold, candidate: candidateCold },
      { role: 'user', purpose: 'change_request', ...same('Increase the first integer literal in the first eligible function body by one. Preserve all other AST fields.') },
      { role: 'assistant', purpose: 'failed_attempt', baseline: baselineDeclaration, candidate: failed },
      { role: 'tool', purpose: 'repair', ...same('The submitted declaration left that literal unchanged. Apply the requested edit.') },
      { role: 'assistant', purpose: 'change', baseline: baselineEdited, candidate: repaired },
      { role: 'tool', purpose: 'response', ...same('The changed declaration and exact module root were checked.') },
    ];
    const priorSession = session.map((row, position) => ({ ...row, candidate:
      position === 1 ? priorCold : position === 3 ? priorFailed : position === 5 ? priorRepaired : row.candidate }));
    return {
      id: fixture.id, seed: fixture.seed, memberIndex: index, path: chosen.path,
      originalInteger: chosen.value.toString(), changedInteger: (chosen.value + 1n).toString(),
      originalRoot: root(module), changedRoot: root(expectedModule),
      cold: { baseline: baselineCold, candidate: candidateCold },
      prior: { cold: priorCold, failed: priorFailed, repaired: priorRepaired,
        session: priorSession.map(row => sessionWire(row, 'candidate')) },
      failed: { baseline: baselineDeclaration, candidate: failed },
      repaired: { baseline: baselineEdited, candidate: repaired },
      session: session.map(row => ({ role: row.role, purpose: row.purpose,
        baseline: sessionWire(row, 'baseline'), candidate: sessionWire(row, 'candidate') })),
    };
  });
}

function reportRows(rows: ReturnType<typeof collect>) {
  const tokenizers = ['cl100k_base', 'o200k_base'] as const;
  return Object.fromEntries(tokenizers.map(tokenizer => {
    const count = (baseline: string, candidate: string) => ({
      baseline: countTokens(baseline, tokenizer), candidate: countTokens(candidate, tokenizer),
    });
    const sum = (pairs: Array<{ baseline: number; candidate: number }>) => {
      const baseline = pairs.reduce((n, row) => n + row.baseline, 0);
      const candidate = pairs.reduce((n, row) => n + row.candidate, 0);
      return { baseline, candidate, ratio: baseline / candidate, passes4x: baseline >= 4 * candidate };
    };
    const workloads = rows.map(row => ({
      id: row.id,
      cold: sum([count(row.cold.baseline, row.cold.candidate)]),
      repaired: sum([count(row.repaired.baseline, row.repaired.candidate)]),
      session: sum(row.session.map(message => count(message.baseline, message.candidate))),
      priorCold: countTokens(row.prior.cold, tokenizer),
      priorSession: row.prior.session.reduce((n, message) => n + countTokens(message, tokenizer), 0),
      messages: row.session.map(message => ({ role: message.role, purpose: message.purpose,
        ...count(message.baseline, message.candidate) })),
    }));
    const aggregateCold = sum(workloads.map(row => row.cold));
    const aggregateSession = sum(workloads.map(row => row.session));
    const priorCold = workloads.reduce((n, row) => n + row.priorCold, 0);
    const priorSession = workloads.reduce((n, row) => n + row.priorSession, 0);
    return [tokenizer, { workloads,
      aggregate: {
        cold: aggregateCold,
        repaired: sum(workloads.map(row => row.repaired)),
        session: aggregateSession,
        ae6Control: { cold: priorCold, session: priorSession,
          coldImprovement: priorCold / aggregateCold.candidate,
          sessionImprovement: priorSession / aggregateSession.candidate },
      },
    }];
  }));
}

const rows = collect();
const report = {
  format: 'aether.agent-ir7.actual-token-report/1',
  registration: 'roadmap/v4/research/agent-ir7/REGISTRATION.md',
  sourceCommit: git('rev-parse', 'HEAD'), sourceHashes: sourceHashes(),
  tokenizerPackage: 'js-tiktoken@1.0.21',
  baseline: 'complete TypeScript projection', candidate: 'AE7 complete cold + R7/E7',
  status: 'authored_diagnostic_only; not FR-1.2 or Q03 qualification',
  counts: reportRows(rows),
};
if (process.argv[2] === 'preview') {
  console.log(JSON.stringify({ sourceCommit: report.sourceCommit, counts: Object.fromEntries(
    Object.entries(report.counts).map(([key, value]) => [key, (value as { aggregate: unknown }).aggregate])) }, null, 2));
} else if (process.argv[2] === 'record') {
  if (git('status', '--porcelain')) throw new Error('AE7 record requires a clean source commit');
  const target = process.argv[3] ?? join(import.meta.dirname, 'results', `source-${report.sourceCommit.slice(0, 7)}`);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'samples.json'), JSON.stringify({ format: 'aether.agent-ir7.raw-samples/1', rows }, null, 2) + '\n');
  writeFileSync(join(target, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(target);
} else throw new Error('usage: measure.ts preview|record [output-directory]');
