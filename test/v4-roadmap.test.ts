import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PLAN, SOURCE_SHA256, SPEC_VERSION } from '../roadmap/v4/plan.ts';
import { ready, validate, waves } from '../roadmap/v4/graph.ts';
import { readArtifact, render, TRACKER_PATH } from '../roadmap/v4/render.ts';
import type { EvidenceManifest, Plan, Task } from '../roadmap/v4/model.ts';

const change = (id: string, patch: Partial<Task>): Plan => ({
  ...PLAN, tasks: PLAN.tasks.map(task => ({ ...task, status: 'planned', evidence: undefined, ...(task.id === id ? patch : {}) })),
});

test('v4 plan exactly covers the preserved functional requirements and source digest', () => {
  const source = readFileSync(new URL('../docs/PRD-v4.0.md', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), SOURCE_SHA256);
  const sourceIds = [...source.toString().matchAll(/^#### (FR-\d+\.\d+):/gm)].map(m => `V4-${m[1]}`);
  const planned = PLAN.requirements.filter(req => req.id.startsWith('V4-FR-')).map(req => req.id);
  assert.equal(sourceIds.length, 40);
  assert.deepEqual(planned, sourceIds);
  for (const [prefix, count] of [['V4-NFR-', 16], ['V4-GOV-', 3], ['V4-KPI-', 12]] as const) {
    assert.equal(PLAN.requirements.filter(req => req.id.startsWith(prefix)).length, count);
  }
  assert.deepEqual(validate(PLAN, readArtifact), []);
});

test('v4 document version and generated tracker cannot drift', () => {
  const spec = readFileSync(new URL('../docs/implementation/v4/SPEC.md', import.meta.url), 'utf8');
  assert.ok(spec.includes(`| Specification version | **${SPEC_VERSION}** |`));
  assert.equal(readFileSync(TRACKER_PATH, 'utf8'), render());
});

test('v4 first slice is ordered and closes its dependencies; waves respect every edge', () => {
  assert.deepEqual(PLAN.firstSlice.slice(0, 2), ['V4-F01', 'V4-F02']);
  const prior = new Set<string>();
  for (const id of PLAN.firstSlice) {
    const task = PLAN.tasks.find(t => t.id === id)!;
    assert.ok(task.deps.every(dep => prior.has(dep)), id);
    prior.add(id);
  }
  const positions = new Map(waves(PLAN).flatMap((wave, i) => wave.map(t => [t.id, i] as const)));
  assert.equal(positions.size, PLAN.tasks.length);
  for (const task of PLAN.tasks) for (const dep of task.deps) assert.ok(positions.get(dep)! < positions.get(task.id)!);
  const initial = { ...PLAN, tasks: PLAN.tasks.map(task => ({ ...task, status: 'planned' as const })) };
  assert.ok(ready(initial).some(task => task.id === 'V4-F01'));
  assert.ok(ready(initial).some(task => task.id === 'V4-F02'));
});

test('v4 validator rejects cycles, dangling edges, unknown coverage and duplicate identities', () => {
  assert.ok(validate(change('V4-F03', { deps: ['V4-F04'] })).some(e => e.startsWith('cycle:')));
  assert.ok(validate(change('V4-F01', { deps: ['MISSING'] })).some(e => e.startsWith('unknown dependency:')));
  assert.ok(validate(change('V4-F01', { requirements: ['MISSING'] })).some(e => e.startsWith('unknown requirement:')));
  assert.ok(validate({ ...PLAN, tasks: [...PLAN.tasks, PLAN.tasks[0]] }).some(e => e.startsWith('duplicate task:')));
  assert.ok(validate(change('V4-F01', { milestone: 'v4' })).some(e => e.startsWith('later-stage dependency:')));
  assert.ok(validate({ ...PLAN, firstSlice: [...PLAN.firstSlice].reverse() }).some(e => e.startsWith('first slice not closed/in order:')));
});

test('v4 validator rejects lost delivery ownership, missing release closure and unexplained blockers', () => {
  const owner = PLAN.tasks.find(t => t.id === 'V4-T1-01')!;
  assert.ok(validate(change(owner.id, { requirements: [] })).some(e => e.startsWith('functional requirement needs one delivery owner:')));
  assert.ok(validate(change('V4-M4', { deps: [] })).some(e => e.startsWith('release omits prerequisite:')));
  assert.ok(validate(change('V4-F01', { status: 'blocked' })).some(e => e.startsWith('missing blocked reason:')));
  assert.ok(validate(change('V4-F04', { status: 'in_progress' })).some(e => e.startsWith('unfinished dependency:')));
});

test('v4 completion requires exact-version evidence for every gate and all dependencies', () => {
  const task = PLAN.tasks.find(t => t.id === 'V4-F01')!;
  const manifest: EvidenceManifest = {
    task: task.id, specVersion: SPEC_VERSION,
    subjectCommit: 'a'.repeat(40), recordedAt: '2026-09-22T18:00:00Z',
    checks: task.gates.map(gate => ({ gate: gate.id, result: 'pass', method: 'test procedure', artifact: 'evidence/run.log' })),
  };
  const plan = change(task.id, { status: 'verified', evidence: 'evidence/manifest.json' });
  const reader = (entry: unknown) => (path: string): string | undefined =>
    path === 'evidence/manifest.json' ? JSON.stringify(entry) : path === 'evidence/run.log' ? 'recorded test output' : undefined;
  assert.deepEqual(validate(plan, reader(manifest)), []);
  for (const altered of [
    { ...manifest, specVersion: '0.0.0' },
    { ...manifest, subjectCommit: 'main' },
    { ...manifest, checks: manifest.checks.slice(1) },
    { ...manifest, checks: [...manifest.checks, manifest.checks[0]] },
    { ...manifest, checks: manifest.checks.map(c => ({ ...c, result: 'not_run' })) },
    { ...manifest, checks: manifest.checks.map(c => ({ ...c, artifact: '../outside.log' })) },
  ]) assert.ok(validate(plan, reader(altered)).some(e => e.startsWith('evidence ')));
  assert.ok(validate(plan, () => undefined).some(e => e.includes('manifest not available')));
  assert.ok(validate(plan, () => '{broken').some(e => e.includes('invalid JSON')));
  assert.ok(validate(change('V4-F04', { status: 'verified' })).some(e => e.startsWith('unfinished dependency:')));
});

test('v4 ordering fails loudly if it cannot make progress', () => {
  assert.throws(() => waves(change('V4-F03', { deps: ['V4-F04'] })), /cannot order/);
});
