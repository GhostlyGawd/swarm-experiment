import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CRITICAL_PATH, EPICS, FEATURES, FIRST_SLICE, SEQUENCING_RATIONALE,
  type Feature, type Size,
} from '../roadmap/features.ts';
import {
  WEIGHT, byId, classifySequence, cycles, dependents, leaks, problems, ready, requirements, waves,
} from '../roadmap/graph.ts';
import { ROADMAP_PATH, expected } from '../roadmap/render.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const doc = () => readFileSync(ROADMAP_PATH, 'utf8');

/** Rows of every `| # | Feature | … | Size |` table in the inventory. */
function tableRows(): Array<{ id: string; title: string; size: string }> {
  const out: Array<{ id: string; title: string; size: string }> = [];
  for (const line of doc().split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const id = cells[0].replace(/\*/g, '');
    if (!/^[A-I]\d+$/.test(id)) continue;
    out.push({
      id,
      title: cells[1].replace(/\*\*/g, ''),
      size: cells[cells.length - 1].replace(/\*/g, ''),
    });
  }
  return out;
}

test('the graph is structurally sound', () => {
  const found = problems();
  assert.deepEqual(found, [], found.map((p) => `${p.kind}: ${p.detail}`).join('\n'));
});

test('the dependency graph is acyclic', () => {
  const found = cycles();
  assert.deepEqual(found, [], `cycles: ${found.map((c) => c.join(' -> ')).join('; ')}`);
});

test('feature ids are unique and well formed', () => {
  const seen = new Set<string>();
  for (const feature of FEATURES) {
    assert.match(feature.id, /^[A-I]\d+$/, feature.id);
    assert.equal(feature.id[0], feature.epic, `${feature.id} is filed under ${feature.epic}`);
    assert.equal(seen.has(feature.id), false, `duplicate id ${feature.id}`);
    seen.add(feature.id);
    assert.ok(feature.title.length > 0 && feature.why.length > 0, feature.id);
    assert.ok((feature.status ?? 'open') === 'open' || feature.status === 'complete', feature.id);
  }
});

test('the document and the graph list the same features, in the same order', () => {
  const rows = tableRows();
  assert.deepEqual(rows.map((r) => r.id), FEATURES.map((f) => f.id),
    'docs/ROADMAP.md and roadmap/features.ts disagree about which features exist or their order');
  for (const row of rows) {
    const feature = byId.get(row.id)!;
    assert.equal(row.size, feature.size, `${row.id}: size differs between the doc and the graph`);
    // Titles are compared on their first clause, since the table wraps prose.
    const head = (s: string) => s.split(/[:—(]/)[0].trim().toLowerCase();
    assert.equal(head(row.title), head(feature.title), `${row.id}: title differs`);
  }
});

test('every epic is represented and every feature belongs to one', () => {
  const used = new Set(FEATURES.map((f) => f.epic));
  for (const epic of EPICS) assert.ok(used.has(epic.id), `epic ${epic.id} has no features`);
  const declared = new Set(EPICS.map((e) => e.id));
  for (const feature of FEATURES) assert.ok(declared.has(feature.epic), feature.id);
});

test('the generated section of the document is current', () => {
  assert.equal(doc(), expected(),
    'docs/ROADMAP.md is stale relative to the graph. Run: npm run roadmap');
});

test('the recommended first slice is closed under dependencies', () => {
  const escaping = leaks(FIRST_SLICE);
  assert.deepEqual(escaping, [],
    escaping.map((e) => `${e.id} needs ${e.missing.join(', ')} from outside the slice`).join('; '));
});

test('the first slice is actually startable, in order', () => {
  const have = new Set<string>();
  for (const id of FIRST_SLICE) {
    const feature = byId.get(id);
    assert.ok(feature, `first slice names unknown feature ${id}`);
    assert.ok(
      feature!.deps.every((d) => have.has(d)),
      `${id} appears before its blockers ${feature!.deps.filter((d) => !have.has(d)).join(', ')}`,
    );
    have.add(id);
  }
});

test('the critical path is a real path, and opinions are labelled as such', () => {
  for (const id of CRITICAL_PATH) assert.ok(byId.has(id), `unknown feature ${id}`);
  const links = classifySequence(CRITICAL_PATH);
  assert.ok(links.length > 0);

  // Both kinds are legitimate. What is not legitimate is presenting a judgment
  // as a dependency, so each judgment must be labelled *and* justified.
  const judgments = links.filter((l) => l.strength === 'judgment');
  const text = doc();
  for (const link of judgments) {
    assert.match(
      text,
      new RegExp(`${link.from}\\s*→\\s*${link.to}[^\\n]*sequencing judgment`),
      `${link.from} → ${link.to} is not forced by the graph, and the document does not say so`,
    );
    const rationale = SEQUENCING_RATIONALE[`${link.from}->${link.to}`];
    assert.ok(
      rationale && rationale.length > 40,
      `${link.from} → ${link.to} is an opinion with no recorded rationale`,
    );
  }
  // ...and a rationale for a step that *is* forced would be misleading noise.
  for (const key of Object.keys(SEQUENCING_RATIONALE)) {
    const [from, to] = key.split('->');
    const link = links.find((l) => l.from === from && l.to === to);
    assert.ok(link, `SEQUENCING_RATIONALE has ${key}, which is not a step on the path`);
    assert.equal(link!.strength, 'judgment',
      `${key} has a rationale but the graph forces it; the rationale is misleading`);
  }
  for (const link of links.filter((l) => l.strength === 'hard')) {
    assert.ok(requirements(link.to).has(link.from), `${link.from} → ${link.to}`);
  }
});

test('C5 is off the critical path, as claimed', () => {
  const downstream = dependents('C5');
  const onPath = CRITICAL_PATH.filter((id) => downstream.has(id));
  assert.deepEqual(onPath, [],
    `the critical path depends on C5 via ${onPath.join(', ')}, so it is not off it`);
  // ...and it is genuinely cheap and near the root.
  assert.equal(byId.get('C5')!.size, 'S');
  assert.ok(waves().get('C5')! <= 1, 'C5 should be reachable in the first wave after A1');
});

test('wave numbers respect every dependency', () => {
  const depth = waves();
  for (const feature of FEATURES) {
    for (const dep of feature.deps) {
      assert.ok(
        depth.get(dep)! < depth.get(feature.id)!,
        `${feature.id} (wave ${depth.get(feature.id)}) is not after ${dep} (wave ${depth.get(dep)})`,
      );
    }
  }
});

test('nothing is stranded: every feature is reachable from a startable one', () => {
  const startable = new Set(ready(new Set()).map((f) => f.id));
  for (const feature of FEATURES) {
    if (startable.has(feature.id)) continue;
    const roots = [...requirements(feature.id)].filter((id) => startable.has(id));
    assert.ok(roots.length > 0, `${feature.id} has no startable ancestor`);
  }
});

test('sizes are drawn from the declared scale', () => {
  const sizes: Size[] = ['S', 'M', 'L', 'XL'];
  for (const feature of FEATURES) {
    assert.ok(sizes.includes(feature.size), `${feature.id}: ${feature.size}`);
    assert.ok(WEIGHT[feature.size] > 0);
  }
});

test('every feature has evidence matching its completion status', () => {
  for (const feature of FEATURES) {
    const evidence = feature.evidence;
    if (evidence.kind === 'none') {
      assert.ok(evidence.reason.length > 10, `${feature.id}: give a real reason`);
      continue;
    }
    for (const file of evidence.files) {
      const source = readFileSync(`${ROOT}${file}`, 'utf8');
      const found = source.toLowerCase().includes(evidence.pattern.toLowerCase());
      if ((feature.status ?? 'open') === 'complete') {
        assert.equal(evidence.kind, 'present', `${feature.id}: completed work needs positive evidence`);
        assert.equal(found, true, `${feature.id}: completion evidence is missing from ${file}`);
      } else {
        assert.equal(evidence.kind, 'absent', `${feature.id}: open work needs absence evidence`);
        assert.equal(
          found,
          false,
          `${feature.id} claims to be unbuilt, but ${file} already mentions ` +
            `"${evidence.pattern}" — the roadmap is listing something that exists`,
        );
      }
    }
  }
});

test('the two confirmed language holes are still holes', () => {
  // These are the two the brainstorm called out specifically; if either is
  // fixed, the roadmap entry that depends on the claim must be revisited.
  const ast = readFileSync(`${ROOT}src/tier1/ast.ts`, 'utf8');
  assert.ok(ast.includes("t: 'Result'"), 'Result is still declared as a type');
  assert.equal(
    readFileSync(`${ROOT}src/tier1/build.ts`, 'utf8').includes('ok('),
    false,
    'Result gained a value-level constructor; B1 needs rewording',
  );
  assert.equal(ast.includes("kind: 'Import'"), false, 'a module still cannot reference another');
});

// ---------------------------------------------------------------------------
// The validator, validated.
//
// Every check above passes today. That is only evidence the roadmap is sound
// if the checks are capable of failing, so each is shown rejecting a graph
// built to violate exactly the property it claims to enforce.
// ---------------------------------------------------------------------------

const stub = (id: string, deps: string[]): Feature => ({
  id,
  epic: id[0],
  title: `fixture ${id}`,
  why: 'fixture',
  size: 'S',
  deps,
  evidence: { kind: 'none', reason: 'a fixture for testing the validator itself' },
});

test('the validator rejects a dependency cycle', () => {
  const looped = [stub('A1', ['A2']), stub('A2', ['A1'])];
  const found = cycles(looped);
  assert.equal(found.length > 0, true, 'a two-node cycle went undetected');
  assert.ok(problems(looped).some((p) => p.kind === 'cycle'));
  // And a self-loop, which is the degenerate case.
  assert.ok(problems([stub('A1', ['A1'])]).some((p) => p.kind === 'self_dependency'));
});

test('the validator rejects a dangling dependency', () => {
  const found = problems([stub('A1', ['A9'])]);
  assert.ok(found.some((p) => p.kind === 'unknown_dependency' && p.detail === 'A1 -> A9'));
});

test('the validator rejects an unknown epic', () => {
  const orphan = { ...stub('A1', []), epic: 'Z' };
  assert.ok(problems([orphan]).some((p) => p.kind === 'unknown_epic'));
});

test('the validator rejects a slice that is not closed', () => {
  const graph = [stub('A1', []), stub('A2', ['A1'])];
  assert.deepEqual(leaks(['A2'], graph), [{ id: 'A2', missing: ['A1'] }]);
  assert.deepEqual(leaks(['A1', 'A2'], graph), []);
});

test('the validator distinguishes a forced order from an opinion', () => {
  const graph = [stub('A1', []), stub('A2', ['A1']), stub('B1', [])];
  assert.deepEqual(
    classifySequence(['A1', 'A2'], graph).map((l) => l.strength),
    ['hard'],
  );
  assert.deepEqual(
    classifySequence(['A2', 'B1'], graph).map((l) => l.strength),
    ['judgment'],
  );
});

test('the evidence check fails when a feature has actually been built', () => {
  // `store.ts` certainly contains the word "export", so a feature claiming to
  // be unbuilt on that basis must be reported as already shipped.
  const built = {
    ...stub('A1', []),
    evidence: { kind: 'absent' as const, pattern: 'export', files: ['src/tier1/store.ts'] },
  };
  const source = readFileSync(`${ROOT}${built.evidence.files[0]}`, 'utf8');
  assert.equal(
    source.toLowerCase().includes(built.evidence.pattern.toLowerCase()),
    true,
    'the evidence check would not have caught an already-built feature',
  );
});
