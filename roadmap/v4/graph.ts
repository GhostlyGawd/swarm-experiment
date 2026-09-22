import type { EvidenceManifest, Plan, Task } from './model.ts';

export type ReadArtifact = (path: string) => string | undefined;
const stages = ['baseline', 'v2', 'v3', 'v4'];
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const safePath = (value: unknown): value is string => nonempty(value)
  && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..')
  && !value.includes(':');

/** Checks planning consistency and evidence records; does not certify runtime behavior. */
export function validate(plan: Plan, readArtifact?: ReadArtifact): string[] {
  const errors: string[] = [];
  const lookup = new Map(plan.tasks.map(task => [task.id, task]));
  const requirements = new Set(plan.requirements.map(req => req.id));
  const duplicate = (items: readonly string[], label: string) => {
    const seen = new Set<string>();
    for (const id of items) { if (seen.has(id)) errors.push(`duplicate ${label}: ${id}`); seen.add(id); }
  };
  if (!/^\d+\.\d+\.\d+$/.test(plan.version)) errors.push('invalid specification version');
  duplicate(plan.tasks.map(task => task.id), 'task');
  duplicate(plan.requirements.map(req => req.id), 'requirement');
  duplicate(plan.firstSlice, 'first-slice task');
  duplicate(plan.tasks.flatMap(task => task.gates.map(gate => gate.id)), 'gate');
  for (const req of plan.requirements) {
    if (![req.id, req.title, req.source, req.target].every(nonempty)) errors.push(`incomplete requirement: ${req.id}`);
    if (!plan.tasks.some(task => task.requirements.includes(req.id))) errors.push(`uncovered requirement: ${req.id}`);
    if (req.id.startsWith('V4-FR-')) {
      const owners = plan.tasks.filter(task => /^V4-T\d-\d+$/.test(task.id) && task.requirements.includes(req.id));
      if (owners.length !== 1) errors.push(`functional requirement needs one delivery owner: ${req.id}`);
    }
  }
  for (const task of plan.tasks) {
    if (!/^V4-(F\d{2}|R\d{2}|T[1-4]-\d{2}|Q\d{2}|M[0234])$/.test(task.id)) errors.push(`invalid task id: ${task.id}`);
    if (!stages.includes(task.milestone)) errors.push(`invalid milestone: ${task.id}`);
    if (!['planned', 'in_progress', 'blocked', 'verified'].includes(task.status)) errors.push(`invalid status: ${task.id}`);
    if (!['implementation', 'research', 'assurance', 'release'].includes(task.kind)) errors.push(`invalid kind: ${task.id}`);
    if (![task.title, task.owner].every(nonempty) || !task.deliverables.length || !task.deliverables.every(nonempty)) errors.push(`incomplete task: ${task.id}`);
    if (!task.gates.length || task.gates.some(gate => !nonempty(gate.criterion) || !gate.id.startsWith(`${task.id}/G`))) errors.push(`invalid gates: ${task.id}`);
    duplicate(task.deps, `${task.id} dependency`);
    duplicate(task.requirements, `${task.id} coverage`);
    for (const req of task.requirements) if (!requirements.has(req)) errors.push(`unknown requirement: ${task.id} -> ${req}`);
    for (const dep of task.deps) {
      const dependency = lookup.get(dep);
      if (!dependency) errors.push(`unknown dependency: ${task.id} -> ${dep}`);
      else {
        if (stages.indexOf(dependency.milestone) > stages.indexOf(task.milestone)) errors.push(`later-stage dependency: ${task.id} -> ${dep}`);
        if ((task.status === 'verified' || task.status === 'in_progress') && dependency.status !== 'verified') errors.push(`unfinished dependency: ${task.id} -> ${dep}`);
      }
    }
    if (task.status === 'blocked' && !nonempty(task.blockedReason)) errors.push(`missing blocked reason: ${task.id}`);
    if (task.status === 'verified') validateEvidence(task, plan.version, readArtifact, errors);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'visiting') { errors.push(`cycle: ${[...path, id].join(' -> ')}`); return; }
    if (state.get(id) === 'done') return;
    state.set(id, 'visiting');
    for (const dep of lookup.get(id)?.deps ?? []) if (lookup.has(dep)) visit(dep, [...path, id]);
    state.set(id, 'done');
  };
  for (const task of plan.tasks) visit(task.id, []);
  for (const release of plan.tasks.filter(task => task.kind === 'release')) {
    const reachable = new Set<string>();
    const collect = (id: string): void => {
      if (reachable.has(id)) return;
      reachable.add(id);
      for (const dep of lookup.get(id)?.deps ?? []) collect(dep);
    };
    for (const dep of release.deps) collect(dep);
    for (const task of plan.tasks) {
      if (task.id !== release.id && stages.indexOf(task.milestone) <= stages.indexOf(release.milestone)
        && !reachable.has(task.id)) errors.push(`release omits prerequisite: ${release.id} needs ${task.id}`);
    }
  }
  const prior = new Set<string>();
  for (const id of plan.firstSlice) {
    const task = lookup.get(id);
    if (!task) errors.push(`unknown first-slice task: ${id}`);
    else for (const dep of task.deps) if (!prior.has(dep)) errors.push(`first slice not closed/in order: ${id} needs ${dep}`);
    prior.add(id);
  }
  return errors;
}

function validateEvidence(task: Task, version: string, read: ReadArtifact | undefined, errors: string[]): void {
  const fail = (reason: string) => errors.push(`evidence ${task.id}: ${reason}`);
  if (!safePath(task.evidence)) { fail('missing or unsafe manifest path'); return; }
  const text = read?.(task.evidence);
  if (text === undefined) { fail('manifest not available'); return; }
  let manifest: EvidenceManifest;
  try { manifest = JSON.parse(text); } catch { fail('invalid JSON'); return; }
  if (!manifest || manifest.task !== task.id || manifest.specVersion !== version) { fail('task/specification mismatch'); return; }
  if (!/^[a-f0-9]{40}$/.test(manifest.subjectCommit ?? '')) fail('missing exact subject commit');
  if (!nonempty(manifest.recordedAt) || !Number.isFinite(Date.parse(manifest.recordedAt))) fail('invalid recording date');
  if (!Array.isArray(manifest.checks)) { fail('missing checks'); return; }
  const expected = new Set(task.gates.map(g => g.id));
  const seen = new Set<string>();
  for (const check of manifest.checks) {
    if (!check || !expected.has(check.gate) || seen.has(check.gate)) { fail('unknown or duplicate check'); continue; }
    seen.add(check.gate);
    if (check.result !== 'pass') fail(`gate did not pass: ${check.gate}`);
    if (!nonempty(check.method) || !safePath(check.artifact) || !nonempty(read?.(check.artifact))) fail(`missing method/artifact: ${check.gate}`);
  }
  for (const id of expected) if (!seen.has(id)) fail(`missing gate: ${id}`);
}

export function ready(plan: Plan): Task[] {
  const complete = new Set(plan.tasks.filter(task => task.status === 'verified').map(task => task.id));
  return plan.tasks.filter(task => task.status === 'planned' && task.deps.every(dep => complete.has(dep)));
}

/** Topological levels describe dependency depth, not duration or staffing. */
export function waves(plan: Plan): Task[][] {
  const done = new Set<string>();
  const result: Task[][] = [];
  while (done.size < plan.tasks.length) {
    const wave = plan.tasks.filter(task => !done.has(task.id) && task.deps.every(dep => done.has(dep)));
    if (!wave.length) throw new Error('cannot order cyclic, duplicate or incomplete graph');
    result.push(wave);
    for (const task of wave) done.add(task.id);
  }
  return result;
}
