import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../../..');
const campaign = join(root, 'roadmap/v4/research/projection-throughput/campaign.ts');
const verifier = join(root, 'roadmap/v4/research/projection-throughput/verify.ts');
function command(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', script, ...args],
    { cwd: root, encoding: 'utf8', timeout: 60_000 });
}
test('actual three-target projection trials recount and reject edited line evidence', () => {
  const parent = mkdtempSync(join(tmpdir(), 'aether-projection-rate-test-'));
  const directory = join(parent, 'result');
  try {
    for (const mode of ['--register', '--run']) {
      const process = command(campaign, [mode, directory]);
      assert.equal(process.status, 0, process.stderr);
    }
    let result = command(verifier, [directory]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.outputsPerTrial, 48);
    assert.equal(report.measuredTrials, 5);
    const trialPath = join(directory, 'trials', '0.json');
    const trial = JSON.parse(readFileSync(trialPath, 'utf8'));
    trial.outputs[0].sourceLines++;
    writeFileSync(trialPath, JSON.stringify(trial));
    result = command(verifier, [directory]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sourceLines|projection source LF rule/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
