/** Independent counter/arithmetic audit layered over the original source-pinned
 * execution verifier. Kept separate so historical campaign source stays intact. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { LivingCampaignManifest, LivingCampaignReport, R04JsonObservation } from '../../../../src/tier3/living-campaign.ts';
const directory = resolve(process.argv[2] ?? 'roadmap/v4/research/microworld/results/campaign01');
const read = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
execFileSync(process.execPath, ['--experimental-strip-types', 'roadmap/v4/research/microworld/campaign.ts', '--verify', directory], { stdio: 'inherit' });
const registration = read('registration.json'), result = read('results.json'), boundary = read('boundary.json');
const { after: _diagnostic, ...original } = boundary; assert.deepEqual(original, result.boundary);
const warmup = read('warmup.json') as R04JsonObservation;
assert.equal(warmup.trial, -1); assert.equal(warmup.warmup, true); assert.equal(warmup.checksum, 25534);
assert.equal(warmup.inputsPerSecond, 20_000 / (Number(warmup.elapsedNs) / 1e9));
assert.deepEqual(result.boundary.warmup, { elapsedNs: warmup.elapsedNs, inputsPerSecond: warmup.inputsPerSecond, checksum: warmup.checksum });
for (const sample of result.boundary.samples) {
  const raw = read(`trial-${sample.trial}.json`) as R04JsonObservation;
  assert.deepEqual(raw, { trial: sample.trial, warmup: false, elapsedNs: sample.elapsedNs, inputsPerSecond: sample.inputsPerSecond, checksum: sample.checksum });
  assert.ok(BigInt(raw.elapsedNs) > 0n);
}
for (const [manifest, report] of [[registration.goodManifest, result.good], [registration.brokenManifest, result.broken]] as [LivingCampaignManifest, LivingCampaignReport][]) {
  const declared = manifest.scenarios.reduce((sum, scenario) => sum + scenario.scheduling.cases, 0);
  const passed = report.cases.filter(item => item.result.passed).length, filtered = report.cases.filter(item => item.result.filtered).length;
  const missing = manifest.scenarios.flatMap(scenario => {
    const coverage = new Set(report.cases.filter(item => item.input.scenario === scenario.id).flatMap(item => item.result.coverage));
    return scenario.requiredCoverage.filter(label => !coverage.has(label)).map(label => `${scenario.id}/${label}`);
  });
  assert.equal(report.declared, declared); assert.equal(report.generated, declared); assert.equal(report.executed, declared);
  assert.equal(report.passed, passed); assert.equal(report.failed, declared - passed); assert.equal(report.filtered, filtered); assert.equal(report.survival, String(passed / declared));
  assert.deepEqual(report.missingCoverage, missing); assert.equal(report.accepted, passed === declared && filtered === 0 && missing.length === 0);
  assert.equal(report.counterexamples.length, declared - passed); assert.equal(report.productionAuthorized, false);
  assert.equal(report.evaluatedOperations, report.cases.reduce((sum, item) => sum + item.result.evaluatedOperations, 0));
  assert.ok(Number(report.elapsedMs) > 0); assert.equal(Number(report.executedCasesPerSecond), declared / (Number(report.elapsedMs) / 1000));
  assert.equal(Number(report.evaluatedOperationsPerSecond), report.evaluatedOperations / (Number(report.elapsedMs) / 1000));
}
assert.equal(result.fullCampaignThroughputQualified, false); assert.equal(result.admission.productionAuthorized, false);
console.log('Independent audit passed: warmup, each raw observation, all case/filter/coverage/survival counters and complete-campaign rates. Full-campaign qualification remains false.');
