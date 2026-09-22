import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PLAN, BASELINE_COMMIT } from './plan.ts';
import { ready, validate, waves } from './graph.ts';
import type { Plan } from './model.ts';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const TRACKER_PATH = fileURLToPath(new URL('../../docs/implementation/v4/TRACKER.md', import.meta.url));
export function readArtifact(path: string): string | undefined {
  try { return readFileSync(resolve(ROOT, path), 'utf8'); } catch { return undefined; }
}
const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const anchor = (id: string) => id.toLowerCase();
const link = (id: string) => `[${id}](#${anchor(id)})`;

export function render(plan: Plan = PLAN): string {
  const errors = validate(plan, readArtifact);
  if (errors.length) throw new Error(errors.join('\n'));
  const lines = [
    '# Aether v4 implementation dependency tracker', '',
    `Specification **${plan.version}** · baseline \`${BASELINE_COMMIT}\`.`, '',
    'Generated from [plan.ts](../../../roadmap/v4/plan.ts). Read [SPEC.md](SPEC.md) for the normative contracts and [CHANGELOG.md](CHANGELOG.md) for version changes.', '',
    '> This is implementation status. Publishing the specification does not complete runtime work. A verified task needs evidence for every gate; functional delivery does not imply that the release NFR/KPI gates passed.', '',
    `**${plan.tasks.filter(t => t.status === 'verified').length}/${plan.tasks.length} tasks verified; ${plan.requirements.length} source obligations tracked (40 functional, 16 NFR, 3 governance, 12 KPI).**`, '',
    '## First implementation slice', '',
    'Recommended order (closed under prerequisites). Order among independent items reflects the requested priorities, not a technical dependency:', '',
    ...plan.firstSlice.map((id, i) => `${i + 1}. ${link(id)} — ${plan.tasks.find(t => t.id === id)!.title}`), '',
    'The four research tasks can produce decisions early; the baseline release gate also requires their evidence. A dependency is a prerequisite for closing work, not a prohibition on early exploration. “Ready” means dependencies are verified, not that a task has started.', '',
    `**Ready now:** ${ready(plan).map(t => link(t.id)).join(', ') || 'none'}.`, '',
    '## Milestones', '',
    '| Milestone | Verified | Total | Release gate |', '|---|---:|---:|---|',
  ];
  for (const [stage, gate] of [['baseline', 'V4-M0'], ['v2', 'V4-M2'], ['v3', 'V4-M3'], ['v4', 'V4-M4']]) {
    const members = plan.tasks.filter(task => task.milestone === stage);
    lines.push(`| ${stage} | ${members.filter(t => t.status === 'verified').length} | ${members.length} | ${link(gate)} |`);
  }
  lines.push('', '## Task inventory', '', '| Task | Deliverable | Owner | Milestone | Status | Prerequisites |', '|---|---|---|---|---|---|');
  for (const task of plan.tasks) lines.push(`| ${link(task.id)} | ${cell(task.title)} | ${task.owner} | ${task.milestone} | ${task.status} | ${task.deps.map(link).join(', ') || '—'} |`);
  lines.push('', '## Dependency waves', '', 'Levels are derived from prerequisites. They are not time estimates.', '');
  waves(plan).forEach((wave, i) => lines.push(`- **Wave ${i}:** ${wave.map(t => link(t.id)).join(', ')}`));
  lines.push('', '## First-slice dependency graph', '', '```mermaid', 'flowchart TD');
  for (const id of plan.firstSlice) {
    const task = plan.tasks.find(t => t.id === id)!;
    lines.push(`  ${id.replaceAll('-', '_')}["${task.id}: ${task.title}"]`);
    for (const dep of task.deps) lines.push(`  ${dep.replaceAll('-', '_')} --> ${id.replaceAll('-', '_')}`);
  }
  lines.push('```', '', '## Requirement traceability', '', '| Requirement | Source | Target | Work covering it |', '|---|---|---|---|');
  for (const req of plan.requirements) lines.push(`| ${req.id}: ${cell(req.title)} | ${cell(req.source)} | ${cell(req.target)} | ${plan.tasks.filter(t => t.requirements.includes(req.id)).map(t => link(t.id)).join(', ')} |`);
  lines.push('', '## Task contracts', '');
  for (const task of plan.tasks) {
    lines.push(`### ${task.id}`, '', `**${task.title}** · ${task.kind} · ${task.milestone} · owner: ${task.owner} · **${task.status}**`, '',
      `Prerequisites: ${task.deps.map(link).join(', ') || 'none'}.`, '', ...task.deliverables.map(d => `- ${d}`), '', 'Acceptance gates:', '',
      ...task.gates.map(g => `- **${g.id}** — ${g.criterion}`), '',
      `Evidence: ${task.evidence ? `[manifest](../../../${task.evidence})` : 'not yet produced'}.`, '');
    if (task.blockedReason) lines.push(`Blocked: ${task.blockedReason}`, '');
  }
  return lines.join('\n');
}

function main(): void {
  const output = render();
  if (process.argv.includes('--check')) {
    if (readFileSync(TRACKER_PATH, 'utf8') !== output) throw new Error('v4 tracker is stale; run npm run roadmap:v4');
    console.log(`v4 ${PLAN.version}: graph, evidence and tracker valid (${PLAN.tasks.length} tasks, ${PLAN.requirements.length} obligations).`);
  } else {
    writeFileSync(TRACKER_PATH, output);
    console.log('docs/implementation/v4/TRACKER.md regenerated.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
