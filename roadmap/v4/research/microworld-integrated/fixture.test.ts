import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LivingCampaign } from '../../../../src/tier3/living-campaign.ts';
import { integratedFixture, integratedTrust, signIntegratedFixture } from './fixture.ts';
import { auditCombinedRaw, runCombinedProcess } from './harness.ts';
import { runPhysicalMemoryPressure } from './memory-pressure.ts';

const directories: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'aether-integrated-test-')); directories.push(path); return path; };
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));

test('same signed effectful candidate survives scheduler, memory, corrupted network and out-of-order cases', () => {
  const fixture = integratedFixture(), keys = generateKeyPairSync('ed25519');
  const authorization = signIntegratedFixture(fixture, keys.privateKey);
  const campaign = new LivingCampaign({ manifest: fixture.manifest, module: fixture.module,
    registry: fixture.registry, directory: temporary(), effectAuthorization: authorization,
    effectTrust: integratedTrust(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()) });
  const report = campaign.runEffectful();
  assert.equal(report.declared, 15);
  assert.equal(report.generated, 15);
  assert.equal(report.executed, 15);
  assert.equal(report.filtered, 0);
  assert.equal(report.passed, 15);
  assert.equal(report.effectEvents, 9);
  assert.equal(report.accepted, true);
  assert.equal(campaign.admitEffectful(report).productionAuthorized, false);
  for (const label of ['scheduler:switched', 'resource:exhausted', 'network:malformed', 'network:checksum',
    'network:drop', 'event:reordered', 'effect:committed'])
    assert.ok(report.cases.some(item => item.result.coverage.includes(label)), `missing ${label}`);
});

test('signed broken effectful candidate shrinks and replays interleaving failures durably', () => {
  const fixture = integratedFixture(true), keys = generateKeyPairSync('ed25519'), directory = temporary();
  const authorization = signIntegratedFixture(fixture, keys.privateKey), trust = integratedTrust(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const campaign = new LivingCampaign({ manifest: fixture.manifest, module: fixture.module,
    registry: fixture.registry, directory, effectAuthorization: authorization, effectTrust: trust });
  const report = campaign.runEffectful();
  assert.equal(report.accepted, false);
  assert.ok(report.counterexamples.length >= 1);
  assert.throws(() => campaign.admitEffectful(report), /terminal effects/);
  const reopened = new LivingCampaign({ manifest: fixture.manifest, module: fixture.module,
    registry: fixture.registry, directory, effectAuthorization: authorization, effectTrust: trust });
  for (const id of report.counterexamples) {
    const witness = reopened.replayCounterexample(id);
    assert.equal(witness.originalResult.passed, false);
    assert.equal(witness.shrunkResult.passed, false);
    assert.ok(witness.shrunk.schedule.length === witness.original.schedule.length);
  }
});

test('one signed candidate survives TCP faults, real post-sink SIGKILL, recovery and all generated schedules', async () => {
  const fixture = integratedFixture(), keys = generateKeyPairSync('ed25519'), directory = temporary();
  const authorization = signIntegratedFixture(fixture, keys.privateKey, 'sigkill-once-after-dispatch');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const registrationPath = join(directory, 'registration.json');
  writeFileSync(registrationPath, JSON.stringify({ authorization, publicKeyPem }));
  const source = new LivingCampaign({ manifest: fixture.manifest, module: fixture.module,
    registry: fixture.registry, directory: join(directory, 'generated'), effectAuthorization: authorization,
    effectTrust: integratedTrust(publicKeyPem) });
  assert.throws(() => source.runEffectful(), /external complete-run audit/);
  assert.throws(() => source.execute(source.generate()[0]), /isolated worker opt-in/);
  const result = await runCombinedProcess(registrationPath, join(directory, 'process'), source.generate());
  assert.equal(result.generated, 15); assert.equal(result.executed, 15);
  assert.equal(result.passed, 15); assert.equal(result.failed, 0); assert.equal(result.filtered, 0);
  assert.equal(result.attemptedCaseExecutions, 17);
  assert.equal(result.recovered, 1); assert.equal(result.unknown, 0);
  assert.equal(new Set(result.workerPids).size, 2);
  assert.ok(result.cases.some(item => item.input.scenario === 'out-of-order-events' && item.result.passed));
  auditCombinedRaw(join(directory, 'process'), result);
  const sinks = join(directory, 'process', 'effect-sinks');
  const first = readdirSync(sinks).find(name => readdirSync(join(sinks, name)).some(file => file.endsWith('.json')))!;
  const file = join(sinks, first, readdirSync(join(sinks, first)).find(name => name.endsWith('.json'))!);
  writeFileSync(file, readFileSync(file, 'utf8').replace('executionManifest', 'changedManifest'));
  assert.throws(() => auditCombinedRaw(join(directory, 'process'), result), /raw broker\/sink evidence changed/);
});

test('signed resource case executes with independently measured resident process pressure', async () => {
  const fixture = integratedFixture(), keys = generateKeyPairSync('ed25519'), directory = temporary();
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const registrationPath = join(directory, 'registration.json');
  writeFileSync(registrationPath, JSON.stringify({ memoryAuthorization: signIntegratedFixture(fixture,
    keys.privateKey), publicKeyPem }));
  const profile = JSON.parse(readFileSync(new URL('./profile.json', import.meta.url), 'utf8')) as {
    physicalMemoryPressure: { residentBytes: number; touchStrideBytes: number;
      minimumOsRssDeltaBytes: number; caseScenario: string } };
  const observed = await runPhysicalMemoryPressure(registrationPath, join(directory, 'pressure'),
    profile.physicalMemoryPressure);
  assert.ok(observed.osRssPressuredBytes - observed.osRssBaselineBytes
    >= profile.physicalMemoryPressure.minimumOsRssDeltaBytes);
  assert.ok(observed.osRssAfterCaseBytes - observed.osRssBaselineBytes
    >= profile.physicalMemoryPressure.minimumOsRssDeltaBytes);
  assert.equal(observed.result.passed, true);
  assert.equal(observed.result.filtered, false);
  assert.ok(observed.result.coverage.includes('resource:exhausted'));
});

test('physical pressure worker refuses an authorization signed by another key before execution', async () => {
  const fixture = integratedFixture(), signer = generateKeyPairSync('ed25519');
  const stranger = generateKeyPairSync('ed25519'), directory = temporary();
  const registrationPath = join(directory, 'registration.json');
  writeFileSync(registrationPath, JSON.stringify({ memoryAuthorization: signIntegratedFixture(fixture,
    signer.privateKey), publicKeyPem: stranger.publicKey.export({ type: 'spki', format: 'pem' }).toString() }));
  const profile = JSON.parse(readFileSync(new URL('./profile.json', import.meta.url), 'utf8')) as {
    physicalMemoryPressure: { residentBytes: number; touchStrideBytes: number;
      minimumOsRssDeltaBytes: number; caseScenario: string } };
  await assert.rejects(runPhysicalMemoryPressure(registrationPath, join(directory, 'pressure'),
    profile.physicalMemoryPressure), /worker exited|authorization|signature/);
});

test('versioned integrated audit refuses a changed physical pressure observation', () => {
  const campaign = fileURLToPath(new URL('./campaign.ts', import.meta.url));
  const directory = join(temporary(), 'campaign');
  for (const mode of ['--register', '--run', '--verify'])
    execFileSync(process.execPath, ['--experimental-strip-types', campaign, mode, directory],
      { encoding: 'utf8', timeout: 60_000 });
  const path = join(directory, 'memory-pressure.json');
  const memory = JSON.parse(readFileSync(path, 'utf8')) as { checksum: number };
  writeFileSync(path, JSON.stringify({ ...memory, checksum: memory.checksum ^ 1 }, null, 2) + '\n');
  const altered = spawnSync(process.execPath,
    ['--experimental-strip-types', campaign, '--verify', directory],
    { encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(altered.status, 0);
  assert.match(altered.stderr, /checksum|observationDigest/);
});

test('unknown signed post-sink result cannot pass the integrated candidate campaign', () => {
  const fixture = integratedFixture(), keys = generateKeyPairSync('ed25519');
  const authorization = signIntegratedFixture(fixture, keys.privateKey, 'unknown-after-dispatch');
  const campaign = new LivingCampaign({ manifest: fixture.manifest, module: fixture.module,
    registry: fixture.registry, directory: temporary(), effectAuthorization: authorization,
    effectTrust: integratedTrust(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()) });
  const report = campaign.runEffectful();
  assert.equal(report.accepted, false);
  assert.ok(report.indeterminateEffects > 0);
  assert.equal(report.filtered, 0);
  assert.throws(() => campaign.admitEffectful(report), /terminal effects/);
  const generated = campaign.generate(), network = generated.find(item => item.scenario === 'faulted-json-network')!;
  assert.ok(campaign.recoverEffectCase(network).unknown > 0);
  assert.throws(() => campaign.recoverEffectCase({ ...network, seed: 'forged' }), /exact generated case/);
});
