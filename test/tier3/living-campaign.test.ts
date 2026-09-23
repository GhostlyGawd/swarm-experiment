import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LivingCampaign, type LivingCampaignManifest, type CampaignScenario } from '../../src/tier3/living-campaign.ts';
import { livingFixture } from '../../roadmap/v4/research/microworld/fixture.ts';
import * as b from '../../src/tier1/build.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { capability } from '../../src/tier1/ids.ts';

function setup(broken = false, transform: (manifest: LivingCampaignManifest) => LivingCampaignManifest = value => value) {
  const fixture = livingFixture(broken), directory = mkdtempSync(join(tmpdir(), 'aether-living-'));
  const manifest = transform(fixture.manifest), campaign = new LivingCampaign({ ...fixture, manifest, directory });
  return { ...fixture, manifest, directory, campaign, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
test('all declared real-runtime schedules, materialized resources, network faults and out-of-order events survive', () => {
  const f = setup(); try {
    const report = f.campaign.run(); assert.equal(report.accepted, true); assert.equal(report.survival, '1');
    assert.deepEqual([report.declared, report.generated, report.executed, report.passed, report.filtered], [15, 15, 15, 15, 0]);
    assert.equal(f.campaign.admit(report).productionAuthorized, false);
    const schedules = report.cases.filter(item => item.input.scenario === 'two-writers'); assert.equal(new Set(schedules.map(item => item.input.schedule.join())).size, 6);
    const memory = report.cases.find(item => item.input.scenario === 'bounded-allocation')!.result;
    assert.equal(memory.peakAllocatedBytes, 4096); assert.equal(memory.allocatedBytes, 1); assert.ok(memory.allocationChecksum > 0);
    const network = report.cases.find(item => item.input.scenario === 'faulted-json-network')!.result;
    assert.deepEqual([network.networkFrames, network.deliveredFrames, network.rejectedFrames, network.droppedFrames], [6, 4, 1, 1]);
    assert.ok(report.evaluatedOperations > report.executed); assert.equal(report.counterexamples.length, 0);
  } finally { f.cleanup(); }
});
test('lost updates fail actual interleavings; shrinking preserves all operations and exact durable replay', () => {
  const f = setup(true); try {
    const report = f.campaign.run(); assert.equal(report.accepted, false); assert.equal(report.failed, 4); assert.throws(() => f.campaign.admit(report), /100% survival/);
    const reopened = new LivingCampaign({ ...f, directory: f.directory });
    let reductions = 0;
    for (const id of report.counterexamples) {
      const counterexample = reopened.replayCounterexample(id); assert.equal(counterexample.originalResult.failure!.property, '$checks/final-value/assertion');
      assert.equal(counterexample.shrunk.schedule.length, 4); assert.deepEqual([...counterexample.shrunk.schedule].sort(), ['a', 'a', 'b', 'b']); reductions += counterexample.reductions;
    }
    assert.ok(reductions > 0); assert.throws(() => reopened.admit(report), /unmodified/);
  } finally { f.cleanup(); }
});
test('zero-exclusion admission refuses missing coverage even when all calls succeed', () => {
  const f = setup(false, manifest => ({ ...manifest, scenarios: manifest.scenarios.map((scenario, index) => index ? scenario : { ...scenario, requiredCoverage: [...scenario.requiredCoverage, 'unmeasured:partition-heal'] }) }));
  try { const report = f.campaign.run(); assert.equal(report.passed, report.declared); assert.equal(report.accepted, false); assert.deepEqual(report.missingCoverage, ['two-writers/unmeasured:partition-heal']); assert.throws(() => f.campaign.admit(report)); } finally { f.cleanup(); }
});
test('complete enumeration cannot be silently capped or actor steps excluded on replay', () => {
  const fixture = livingFixture(), directory = mkdtempSync(join(tmpdir(), 'aether-living-bounds-'));
  try {
    assert.throws(() => new LivingCampaign({ ...fixture, directory, manifest: { ...fixture.manifest, scenarios: [{ ...fixture.manifest.scenarios[0], scheduling: { mode: 'enumerate', cases: 5 } }] } }), /enumeration|schedule/);
    const campaign = new LivingCampaign({ ...fixture, directory }), input = campaign.generate()[0];
    assert.throws(() => campaign.execute({ ...input, schedule: input.schedule.slice(1) }), /omits or duplicates/);
    assert.throws(() => campaign.execute({ ...input, manifestDigest: 'wrong' }), /manifest/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('seeded failures shrink integer inputs toward a reproducing minimal boundary', () => {
  const fixture = livingFixture(), directory = mkdtempSync(join(tmpdir(), 'aether-living-shrink-'));
  const scenario: CampaignScenario = { ...fixture.manifest.scenarios[0], id: 'negative-input', kind: 'resource', scheduling: { mode: 'seeded', cases: 3 }, variables: [{ name: 'x', minimum: -100, maximum: -1 }], records: [], allocationLimitBytes: 1,
    actors: [{ id: 'a', steps: [{ kind: 'reserve', id: 'memory', bytes: 1, expect: 'allocated' }, { kind: 'call', id: 'wrong', symbol: fixture.symbols.identity, args: [{ tag: 'variable', name: 'x' }], expect: { tag: 'int', value: '0' } }] }],
    checks: [{ kind: 'call', id: 'check', symbol: fixture.symbols.identity, args: [{ tag: 'int', value: '0' }], expect: { tag: 'int', value: '0' } }], requiredCoverage: ['resource:allocated'] };
  try {
    const campaign = new LivingCampaign({ ...fixture, directory, manifest: { ...fixture.manifest, scenarios: [scenario] } }), report = campaign.run();
    assert.equal(report.failed, 3); const evidence = campaign.replayCounterexample(report.counterexamples[0]);
    assert.equal(evidence.original.variables.x, -100); assert.equal(evidence.shrunk.variables.x, -1); assert.equal(evidence.shrunkResult.failure!.property, 'a/wrong/assertion');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('precondition filtering is explicit failed coverage, never success', () => {
  const f = livingFixture(), directory = mkdtempSync(join(tmpdir(), 'aether-living-filter-'));
  const module = f.module as Extract<Term, { kind: 'Module' }>;
  const changed = { ...module, members: module.members.map(node => node.kind === 'FunctionDecl' && node.symbol === f.symbols.read ? { ...node, contract: b.contract({ requires: [b.clause(b.bool(false), 'not-admitted')] }) } : node) };
  try {
    const campaign = new LivingCampaign({ ...f, module: changed, directory, manifest: { ...f.manifest, candidateRoot: new GraphStore().intern(changed), scenarios: [f.manifest.scenarios[0]] } }), report = campaign.run();
    assert.equal(report.executed, 6); assert.equal(report.filtered, 6); assert.equal(report.passed, 0); assert.equal(report.accepted, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('serialized success bits and mutated reports cannot issue campaign admission', () => {
  const f = setup(); try {
    const report = f.campaign.run(); assert.throws(() => f.campaign.admit(JSON.parse(JSON.stringify(report))), /unmodified/);
    (report as { declared: number }).declared--; assert.throws(() => f.campaign.admit(report), /unmodified/);
  } finally { f.cleanup(); }
});
test('persisted counterexample tampering fails and caller manifest changes do not alter admitted profile', () => {
  const f = setup(true); try {
    const before = f.campaign.generate(); (f.manifest as { seed: string }).seed = 'tampered'; assert.deepEqual(f.campaign.generate(), before);
    const report = f.campaign.run(), id = report.counterexamples[0], path = join(f.directory, 'counterexamples', `${id.split(':').at(-1)}.json`);
    const bytes = JSON.parse(readFileSync(path, 'utf8')); bytes.shrunkResult.passed = true; writeFileSync(path, JSON.stringify(bytes));
    assert.throws(() => f.campaign.replayCounterexample(id), /digest mismatch/); assert.ok(readdirSync(join(f.directory, 'cases')).length > 0);
  } finally { f.cleanup(); }
});
test('live/opaque effects fail explicitly instead of inheriting implicit successful Unit dispatch', () => {
  const f = livingFixture(), directory = mkdtempSync(join(tmpdir(), 'aether-living-effects-')), cap = capability('cap:campaign:append');
  f.registry.declare(cap, { arity: 0, description: 'must never commit', effectful: true });
  const module = f.module as Extract<Term, { kind: 'Module' }>;
  const changed = { ...module, members: module.members.map(node => node.kind === 'FunctionDecl' && node.symbol === f.symbols.update ? { ...node, purity: 'effectful' as const, capabilities: [cap], body: b.block(b.invoke(cap), b.ret(b.unit())) } : node) };
  try {
    const campaign = new LivingCampaign({ ...f, module: changed, directory, manifest: { ...f.manifest, candidateRoot: new GraphStore().intern(changed), scenarios: [f.manifest.scenarios[0]] } }), report = campaign.run();
    assert.equal(report.passed, 0); assert.equal(report.filtered, 0); assert.ok(report.cases.every(item => item.result.failure!.property.endsWith('fault:effect_failed')));
    assert.throws(() => campaign.admit(report));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('real SIGKILL around immutable report publication leaves complete artifacts and permits safe replay', () => {
  for (const phase of ['before', 'after']) {
    const directory = mkdtempSync(join(tmpdir(), 'aether-living-crash-'));
    try {
      const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
        const real = fs.linkSync; fs.linkSync = (...args) => { const stop = String(args[1]).includes('/reports/');
          if (stop && ${JSON.stringify(phase)} === 'before') process.kill(process.pid, 'SIGKILL');
          const value = real(...args); if (stop) process.kill(process.pid, 'SIGKILL'); return value; }; syncBuiltinESMExports();
        const {LivingCampaign} = await import(${JSON.stringify(pathToFileURL(resolve('src/tier3/living-campaign.ts')).href)});
        const {livingFixture} = await import(${JSON.stringify(pathToFileURL(resolve('roadmap/v4/research/microworld/fixture.ts')).href)});
        new LivingCampaign({...livingFixture(), directory:${JSON.stringify(directory)}}).run();`;
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const reports = readdirSync(join(directory, 'reports')).filter(name => !name.startsWith('.tmp'));
      assert.equal(reports.length, phase === 'before' ? 0 : 1);
      if (reports.length) assert.equal(JSON.parse(readFileSync(join(directory, 'reports', reports[0]), 'utf8')).executed, 15);
      const campaign = new LivingCampaign({ ...livingFixture(), directory }), report = campaign.run(); assert.equal(report.accepted, true); campaign.admit(report);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
test('undelivered frames, instruction exhaustion and ambiguous actor identities cannot be hidden', () => {
  const f = setup(false, manifest => ({ ...manifest, scenarios: [{ ...manifest.scenarios[2], actors: manifest.scenarios[2].actors.map(actor => ({ ...actor, steps: [...actor.steps, { kind: 'send' as const, id: 'unconsumed', event: { order: 0, sequence: 3, allocation: 1, checksum: 51 }, mutation: 'none' as const }] })) }] }));
  try { const report = f.campaign.run(); assert.equal(report.failed, 3); assert.ok(report.cases.every(item => item.result.failure!.property === 'network/undelivered')); } finally { f.cleanup(); }
  const exhausted = setup(false, manifest => ({ ...manifest, maxStepsPerCall: 1, scenarios: [manifest.scenarios[0]] }));
  try { const report = exhausted.campaign.run(); assert.equal(report.failed, 6); assert.ok(report.cases.every(item => item.result.failure!.property.endsWith('fault:step_budget'))); } finally { exhausted.cleanup(); }
  const fixture = livingFixture(), directory = mkdtempSync(join(tmpdir(), 'aether-living-names-'));
  try { assert.throws(() => new LivingCampaign({ ...fixture, directory, manifest: { ...fixture.manifest, scenarios: [{ ...fixture.manifest.scenarios[0], id: 'a/b' }] } }), /delimiter-free/); } finally { rmSync(directory, { recursive: true, force: true }); }
});
