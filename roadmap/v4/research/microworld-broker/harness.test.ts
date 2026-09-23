import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCases, runCase, shrinkFailure, type BrokerCase } from './harness.ts';

const directories: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), 'aether-broker-world-test-')); directories.push(path); return path; }
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));

test('real broker tolerates duplicate delivery, receipt fault, reopen and isolated replay', () => {
  const directory = temp(), input = generateCases('test/seed', 1, join(directory, 'generated'))[0];
  const good = runCase(input, 'stable-effect-id', join(directory, 'good'));
  const broken = runCase(input, 'attempt-derived-effect-id', join(directory, 'broken'));
  assert.equal(good.passed, true);
  assert.equal(good.sinkWrites, 1);
  assert.equal(good.journalEvents, 1);
  assert.equal(good.replayConsumed, 1);
  assert.equal(good.withheldDeliveries, 1);
  assert.ok(good.coverage.includes('fault:receipt-write'));
  assert.ok(good.coverage.includes('broker:reconciled'));
  assert.equal(broken.failure, 'duplicate-effect');
  assert.equal(broken.sinkWrites, 2);
  assert.equal(broken.journalEvents, 2);
  assert.equal(broken.replayConsumed, 2);
});

test('seeded duplicate-effect bug shrinks to a durable four-action replay witness', () => {
  const directory = temp(), input = generateCases('test/seed', 1, join(directory, 'generated'))[0];
  const witness = shrinkFailure(input, 'attempt-derived-effect-id', 'duplicate-effect', join(directory, 'witness'), 64);
  assert.deepEqual(witness.shrunk.actions, ['send', 'duplicate', 'deliver', 'deliver']);
  assert.ok(witness.reductions > 0);
  assert.equal(witness.shrunkResult.failure, 'duplicate-effect');
  assert.equal(runCase(witness.shrunk, witness.candidate, join(directory, 'replay')).failure, 'duplicate-effect');
});

test('a partition with no healing cannot silently count as a successful effect case', () => {
  const directory = temp(), input = generateCases('test/seed', 1, join(directory, 'generated'))[0];
  const isolated: BrokerCase = { ...input, actions: ['send', 'partition', 'deliver'] };
  const result = runCase(isolated, 'stable-effect-id', join(directory, 'partitioned'));
  assert.equal(result.failure, 'missing-effect');
  assert.equal(result.withheldDeliveries, 1);
  assert.equal(result.sinkWrites, 0);
});
