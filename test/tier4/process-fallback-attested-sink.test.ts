import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkConservativeFallbackProof } from '../../src/tier3/fallback-proof.ts';
import { verifySinkReceipt } from '../../src/fabric/sink-receipt.ts';
import type { ProcessHost } from '../../src/tier4/process-host.ts';
import { attestedFallbackFixture } from './process-fallback-attested-sink-fixture.ts';

const args = [{ tag: 'int', value: '7' }] as const;
const temporary = () => mkdtempSync(join(tmpdir(), 'aether-fallback-sink-'));
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function assertSignedDecision(fixture: Awaited<ReturnType<typeof attestedFallbackFixture>>,
  disposition: 'committed' | 'not_committed'): void {
  const head = fixture.witnessedDecisions();
  assert.equal(head.revision, '1');
  assert.equal(head.decisions.length, 1);
  const row = head.decisions[0];
  assert.equal(row.receipt.body.disposition, disposition);
  assert.equal(verifySinkReceipt(row.receipt, fixture.anchor, { repositoryId: row.repositoryId,
    deploymentId: row.deploymentId, request: row.request,
    sinkAuthorityId: fixture.anchor.sinkAuthorityId, sinkId: fixture.anchor.sinkId,
    adapterArtifactDigest: fixture.adapterArtifactDigest, disposition, value: row.value }), true);
}

test('signed sink commit keeps proved Tier 2 idle across host and fallback reopen', async () => {
  const directory = temporary();
  const fixture = await attestedFallbackFixture(directory, 'commit');
  let host: ProcessHost | null = null;
  try {
    const opened = await fixture.open(); host = opened.host;
    assert.equal(opened.supervisor.conservativeProofDigest,
      checkConservativeFallbackProof(fixture.module, fixture.manifest, fixture.tier2, fixture.conservativeProof));
    const result = await opened.supervisor.call(args, { operationId: 'signed-commit' });
    assert.deepEqual(plain(result), { state: 'completed', tier: 1, operationId: 'signed-commit',
      value: { tag: 'int', value: '8' }, productionAuthorized: false });
    assert.equal(fixture.decisionCount(), 1);
    assertSignedDecision(fixture, 'committed');
    assert.equal(opened.supervisor.pendingRepairs().length, 0, 'Tier 2 was never attempted');
    assert.deepEqual(plain(await opened.supervisor.call(args, { operationId: 'signed-commit' })), plain(result));
    assert.equal(fixture.decisionCount(), 1);
    await host.close(); host = null;
    const reopened = await fixture.open(); host = reopened.host;
    assert.deepEqual(plain(await reopened.supervisor.call(args, { operationId: 'signed-commit' })), plain(result));
    assert.equal(fixture.decisionCount(), 1, 'reopen and replay cannot duplicate external effect');
    assert.equal(reopened.supervisor.pendingRepairs().length, 0);
    await fixture.stopWitness();
    await assert.rejects(reopened.supervisor.call(args, { operationId: 'signed-commit' }),
      /witness|uncertain/i, 'cached success still needs current witness custody');
    await fixture.startWitness();
    assert.deepEqual(plain(await reopened.supervisor.call(args, { operationId: 'signed-commit' })), plain(result));
  } finally { await host?.close(); await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('signed noncommit fence permits independently proved pure Tier 2 after reconciliation', async () => {
  const directory = temporary();
  const fixture = await attestedFallbackFixture(directory, 'fence');
  let host: ProcessHost | null = null;
  try {
    const opened = await fixture.open(); host = opened.host;
    const result = await opened.supervisor.call(args, { operationId: 'signed-fence' });
    assert.deepEqual(plain(result), { state: 'completed', tier: 2, operationId: 'signed-fence',
      value: { tag: 'int', value: '8' }, productionAuthorized: false });
    assert.equal(fixture.decisionCount(), 1, 'the only sink decision is the signed noncommit fence');
    assertSignedDecision(fixture, 'not_committed');
    assert.equal(opened.supervisor.pendingRepairs().length, 1);
    assert.equal(fixture.request() !== null, true);
    assert.deepEqual(plain(await opened.supervisor.call(args, { operationId: 'signed-fence' })), plain(result));
    await host.close(); host = null;
    const reopened = await fixture.open(); host = reopened.host;
    assert.deepEqual(plain(await reopened.supervisor.call(args, { operationId: 'signed-fence' })), plain(result));
    assert.equal(fixture.decisionCount(), 1);
    assertSignedDecision(fixture, 'not_committed');
  } finally { await host?.close(); await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('witness outage around Tier 1 dispatch cannot authorize pure Tier 2', async () => {
  const directory = temporary();
  const fixture = await attestedFallbackFixture(directory, 'outage');
  let host: ProcessHost | null = null;
  try {
    const opened = await fixture.open(); host = opened.host;
    await assert.rejects(opened.supervisor.call(args, { operationId: 'signed-outage' }),
      /witness|sink decision|uncertain/i);
    assert.equal(fixture.decisionCount(), 0);
    assert.equal(opened.supervisor.pendingRepairs().length, 0);
    await fixture.startWitness();
    const reconciled = await opened.supervisor.call(args, { operationId: 'signed-outage' });
    assert.deepEqual(plain(reconciled), { state: 'completed', tier: 2, operationId: 'signed-outage',
      value: { tag: 'int', value: '8' }, productionAuthorized: false },
      'Tier 2 can run only after the restarted witness authenticates a noncommit fence');
    assert.equal(fixture.decisionCount(), 1);
  } finally { await host?.close(); await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
});
