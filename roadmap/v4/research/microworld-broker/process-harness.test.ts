import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCases } from './harness.ts';
import { runProcessCase } from './process-harness.ts';

const directories: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), 'aether-process-world-test-')); directories.push(path); return path; }
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));

test('real TCP faults, independent worker SIGKILL, broker reconciliation and replay preserve one stable effect', async () => {
  const directory = temp(), input = generateCases('process/test', 1, join(directory, 'generated'))[0];
  const result = await runProcessCase(input, 'stable-effect-id', join(directory, 'stable'));
  assert.equal(result.passed, true);
  assert.equal(result.sinkWrites, 1);
  assert.equal(result.journalEvents, 1);
  assert.equal(result.replayConsumed, 1);
  assert.equal(new Set(result.workerPids).size, 2);
  assert.deepEqual(result.coverage, ['broker:isolated-replay', 'broker:reconciled-after-process-restart', 'process:sigkill-after-sink',
    'tcp:duplicate-delivery', 'tcp:malformed-frame', 'tcp:truncated-frame']);
});

test('attempt-derived effect identity fails the same real process and socket campaign', async () => {
  const directory = temp(), input = generateCases('process/test', 1, join(directory, 'generated'))[0];
  const result = await runProcessCase(input, 'attempt-derived-effect-id', join(directory, 'attempt'));
  assert.equal(result.failure, 'duplicate-effect');
  assert.equal(result.sinkWrites, 2);
  assert.equal(result.journalEvents, 2);
  assert.equal(result.replayConsumed, 2);
});
