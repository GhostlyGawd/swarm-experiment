/** Frozen AE8 nine-message graph-slice actual-token campaign. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { densityCorpusV7 } from '../agent-ir7/corpus.ts';
import { children, withChildren, type Term } from '../../../../src/tier1/ast.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { AgentIrGraphSliceSessionV8 } from '../../../../src/tier1/agent-ir-v8.ts';
import { encodeAgentIrColdV7 } from '../../../../src/tier1/agent-ir-v7.ts';
import { projectTypeScript } from '../../../../src/projection/typescript.ts';
import { countTokens } from '../../../../src/util/tokens.ts';

const repo = resolve(import.meta.dirname, '../../../..');
const paths = [
  'roadmap/v4/research/agent-ir8/REGISTRATION.md',
  'roadmap/v4/research/agent-ir8/measure.ts',
  'roadmap/v4/research/agent-ir8/verify.mjs',
  'roadmap/v4/research/agent-ir7/corpus.ts',
  'src/tier1/agent-ir-v8.ts', 'src/tier1/agent-ir-v7.ts',
  'src/tier1/agent-ir-v6.ts', 'src/tier1/agent-ir.ts',
  'src/tier1/ast.ts', 'src/tier1/store.ts', 'src/tier1/ids.ts',
  'src/tier1/symbols.ts', 'src/util/rng.ts', 'src/util/tokens.ts',
  'src/examples/ledger.ts', 'src/projection/typescript.ts',
  'src/index.ts', 'src/tier1/index.ts',
  'test/tier1/agent-ir.test.ts', 'test/tier1/agent-ir-v8.test.ts',
  'package-lock.json',
  'roadmap/v4/research/projections/corpus.ts',
  'roadmap/v4/research/projections/corpus-composites.ts',
  'roadmap/v4/research/projections/corpus-continuations.ts',
  'roadmap/v4/research/projections/corpus-completion.ts',
];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sourceHashes = () => Object.fromEntries(paths.map(path => [path, sha(readFileSync(join(repo, path)))]));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const root = (term: Term) => new GraphStore().intern(term);
const frame = (role: string, purpose: string, content: string) =>
  JSON.stringify({ role, purpose, content }) + '\n';

function firstInteger(node: Term, path: number[] = []): { path: number[]; value: bigint } | null {
  if (node.kind === 'Lit' && typeof node.value === 'bigint') return { path, value: node.value };
  for (const [index, child] of children(node).entries()) {
    const hit = firstInteger(child, [...path, index]);
    if (hit) return hit;
  }
  return null;
}
function replace(node: Term, path: readonly number[], value: bigint): Term {
  if (!path.length) {
    if (node.kind !== 'Lit' || typeof node.value !== 'bigint') throw new TypeError('registered literal');
    return { ...node, value };
  }
  const next = [...children(node)], [index, ...tail] = path;
  next[index] = replace(next[index], tail, value);
  return withChildren(node, next);
}

function collect() {
  const fixtures = densityCorpusV7();
  assert.deepEqual(fixtures.map(row => row.id), [
    'ledger', 'scalar-math', 'loop-contract', 'external-effect', 'fixed-lazy',
    'composite-alias-collections', 'continuation-capture-task', 'scalar-five-kind-completion',
  ]);
  return fixtures.map(fixture => {
    const module = fixture.module;
    if (module.kind !== 'Module') throw new TypeError('registered complete module');
    const memberIndex = module.members.findIndex(member => member.kind === 'FunctionDecl'
      && member.body && firstInteger(member.body));
    const original = module.members[memberIndex];
    if (original?.kind !== 'FunctionDecl' || !original.body) throw new TypeError('registered function');
    const chosen = firstInteger(original.body)!;
    const edited = { ...original, body: replace(original.body, chosen.path, chosen.value + 1n) };
    const cold = encodeAgentIrColdV7(module, fixture.seed);
    const sender = new AgentIrGraphSliceSessionV8(cold), receiver = new AgentIrGraphSliceSessionV8(cold);
    const selection = sender.select(memberIndex);
    const retrieval = sender.retrieve(selection);
    const slice = receiver.acceptRetrieval(retrieval);
    assert.equal(slice.declarationRoot, root(original));
    const failed = sender.encode(memberIndex, original), repaired = sender.encode(memberIndex, edited);
    const changed = { ...module, members: module.members.map((member, i) => i === memberIndex ? edited : member) };
    assert.equal(root(receiver.decode(failed).module), root(module));
    assert.equal(root(receiver.decode(repaired).module), root(changed));
    assert.equal(root(receiver.decode(repaired).declaration), root(edited));
    const baselineCold = projectTypeScript(module, fixture.symbols, {});
    const baselineOriginal = projectTypeScript(original, fixture.symbols, {});
    const baselineEdited = projectTypeScript(edited, fixture.symbols, {});
    const same = (role: string, purpose: string, content: string) => ({ role, purpose,
      baseline: frame(role, purpose, content), candidate: frame(role, purpose, content) });
    const paired = (role: string, purpose: string, baseline: string, candidate: string) => ({ role, purpose,
      baseline: frame(role, purpose, baseline), candidate: frame(role, purpose, candidate) });
    const messages = [
      same('system', 'instructions', 'Preserve every contract and effect. Select the requested declaration, then return a complete corrected declaration after feedback.'),
      paired('user', 'initial_context', baselineCold, cold),
      same('user', 'change_request', 'Increase the first integer literal in the first eligible function body by one. Preserve all other AST fields.'),
      paired('assistant', 'selection', `SELECT ${fixture.symbols.nameOf(original.symbol)}`, selection),
      paired('tool', 'retrieval', baselineOriginal, retrieval),
      paired('assistant', 'failed_attempt', baselineOriginal, failed),
      same('tool', 'repair', 'The submitted declaration left that literal unchanged. Apply the requested edit.'),
      paired('assistant', 'change', baselineEdited, repaired),
      same('tool', 'response', 'The changed declaration, contract, dependencies and complete module root were checked.'),
    ];
    return {
      id: fixture.id, seed: fixture.seed, memberIndex,
      path: chosen.path, originalInteger: chosen.value.toString(), changedInteger: (chosen.value + 1n).toString(),
      baseRoot: root(module), changedRoot: root(changed),
      slice: { declarationRoot: slice.declarationRoot, contractRoot: slice.contractRoot,
        dependencies: slice.dependencies, effects: slice.effects },
      raw: { cold: { baseline: baselineCold, candidate: cold },
        selection: { baseline: `SELECT ${fixture.symbols.nameOf(original.symbol)}`, candidate: selection },
        retrieval: { baseline: baselineOriginal, candidate: retrieval },
        failed: { baseline: baselineOriginal, candidate: failed },
        repaired: { baseline: baselineEdited, candidate: repaired } },
      messages,
    };
  });
}

function counts(rows: ReturnType<typeof collect>) {
  return Object.fromEntries((['cl100k_base', 'o200k_base'] as const).map(encoding => {
    const pair = (row: { baseline: string; candidate: string }) => ({
      baseline: countTokens(row.baseline, encoding), candidate: countTokens(row.candidate, encoding),
    });
    const sum = (parts: Array<{ baseline: number; candidate: number }>) => {
      const baseline = parts.reduce((n, part) => n + part.baseline, 0);
      const candidate = parts.reduce((n, part) => n + part.candidate, 0);
      return { baseline, candidate, ratio: baseline / candidate, passes4x: baseline >= 4 * candidate };
    };
    const workloads = rows.map(row => ({ id: row.id,
      cold: sum([pair(row.raw.cold)]), selection: sum([pair(row.raw.selection)]),
      retrieval: sum([pair(row.raw.retrieval)]), repaired: sum([pair(row.raw.repaired)]),
      session: sum(row.messages.map(pair)),
      messages: row.messages.map(message => ({ role: message.role, purpose: message.purpose, ...pair(message) })),
    }));
    return [encoding, { workloads, aggregate: {
      cold: sum(workloads.map(row => row.cold)),
      selection: sum(workloads.map(row => row.selection)),
      retrieval: sum(workloads.map(row => row.retrieval)),
      repaired: sum(workloads.map(row => row.repaired)),
      session: sum(workloads.map(row => row.session)),
    } }];
  }));
}

const rows = collect();
const report = { format: 'aether.agent-ir8.actual-token-report/1',
  sourceCommit: git('rev-parse', 'HEAD'), sourceHashes: sourceHashes(),
  corpus: 'eight authored AE7 fixtures, preregistered nine-message graph-slice sessions',
  tokenizerPackage: 'js-tiktoken@1.0.21',
  status: 'authored_diagnostic_only; not representative FR-1.2 or Q03 qualification',
  counts: counts(rows) };
if (process.argv[2] === 'preview') {
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report.counts).map(([name, value]) =>
    [name, (value as { aggregate: unknown }).aggregate])), null, 2));
} else if (process.argv[2] === 'record') {
  if (git('status', '--porcelain')) throw new Error('AE8 record requires clean source');
  const dir = process.argv[3] ?? join(import.meta.dirname, 'results', `source-${report.sourceCommit.slice(0, 7)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'samples.json'), JSON.stringify({ format: 'aether.agent-ir8.raw-samples/1', rows }, null, 2) + '\n');
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(dir);
} else throw new Error('usage: measure.ts preview|record [output-directory]');
