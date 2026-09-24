import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { advanceWitnessHead, readWitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { readSinkStateHead } from '../../src/fabric/sink-state-witness.ts';
import { PROCESS_INVOKE, ProcessHost } from '../../src/tier4/process-host.ts';
import { budgetedSinkHostFixture } from './process-budgeted-sink-host-fixture.ts';

test('V12 direct ProcessHost charges one witnessed signed sink commit across retry and reopen', async () => {
  const fixture = await budgetedSinkHostFixture();
  let host: ProcessHost | null = null;
  try {
    host = await ProcessHost.open(fixture.options);
    const tokens = (target: string) => host!.issueScopedTokens(fixture.entry, 60_000,
      new Map([[fixture.capability, ['account', target]]]));
    const hostFile = join(fixture.options.directory, 'host.json');
    const before = readFileSync(hostFile, 'utf8');
    const alice = tokens('alice');
    const invoke = alice.find(token => token.body.capability === PROCESS_INVOKE)!;

    await assert.rejects(host.call(fixture.entry, [{ tag: 'string', value: 'alice' }],
      { operationId: 'call:alice', tokens: [invoke] }), /authority_denied/);
    assert.equal(readFileSync(hostFile, 'utf8'), before);
    assert.equal(fixture.bridge.records().length, 0);
    assert.equal(readSinkStateHead(fixture.sinkWitness).revision, '0');

    // The inventory pins the complete effect subject. An unplanned target
    // cannot borrow Alice's budget handle.
    const wrong = await host.call(fixture.entry, [{ tag: 'string', value: 'bob' }],
      { operationId: 'call:unplanned', tokens: tokens('bob') });
    if (wrong.state === 'completed') assert.equal(wrong.execution.ok, false);
    assert.equal(fixture.bridge.records().length, 0);
    assert.equal(readSinkStateHead(fixture.sinkWitness).revision, '0');

    const complete = await host.call(fixture.entry, [{ tag: 'string', value: 'alice' }],
      { operationId: 'call:alice', tokens: tokens('alice') });
    assert.equal(complete.state, 'completed', JSON.stringify(complete));
    if (complete.state === 'completed' && complete.execution.ok)
      assert.deepEqual(encodeCanonical(complete.execution.value),
        encodeCanonical({ tag: 'string', value: 'alice' }));
    assert.equal(fixture.ledger.snapshot('owner:v12-budget-host').spent.usdMicros, '7');
    assert.equal(fixture.ledger.snapshot('owner:v12-budget-host').inflight.usdMicros, '0');
    assert.equal(fixture.bridge.records().length, 1);
    assert.equal(fixture.bridge.records()[0].settlement?.operation.kind, 'consume');
    assert.equal(readSinkStateHead(fixture.sinkWitness).revision, '1');
    assert.deepEqual(encodeCanonical(fixture.bridge.records()[0].request), encodeCanonical(fixture.request));

    const effectHead = readWitnessHead(fixture.effectWitness);
    const forged = JSON.parse(effectHead.journal!) as Record<string, unknown>;
    forged.revision = String(BigInt(effectHead.revision) + 1n);
    forged.budgetBridgeProfileDigest = domainDigest('aether.resource-budget-bridge/1', 'forged');
    assert.throws(() => advanceWitnessHead(fixture.effectWitness, effectHead.revision,
      Buffer.from(encodeCanonical(forged)).toString('utf8')), /witness INVALID|bridge/i);
    assert.deepEqual(readWitnessHead(fixture.effectWitness), effectHead,
      'operator witness rejects a bridge-profile swap without changing its head');

    await assert.rejects(host.call(fixture.entry, [{ tag: 'string', value: 'bob' }],
      { operationId: 'call:alice', tokens: tokens('bob') }), /call_identity_conflict/);
    assert.equal(fixture.bridge.records().length, 1);

    const retry = await host.call(fixture.entry, [{ tag: 'string', value: 'alice' }],
      { operationId: 'call:alice', tokens: tokens('alice') });
    assert.deepEqual(retry, complete);
    assert.equal(fixture.ledger.snapshot('owner:v12-budget-host').spent.usdMicros, '7');
    assert.equal(readSinkStateHead(fixture.sinkWitness).revision, '1');

    await host.close(); host = await ProcessHost.open(fixture.options);
    assert.deepEqual(host.operationResult('call:alice'), complete);
    assert.deepEqual(await host.call(fixture.entry, [{ tag: 'string', value: 'alice' }],
      { operationId: 'call:alice', tokens: tokens('alice') }), complete);
    assert.equal(fixture.bridge.records().length, 1);
    assert.equal(fixture.ledger.snapshot('owner:v12-budget-host').spent.usdMicros, '7');
    assert.equal(readSinkStateHead(fixture.sinkWitness).revision, '1');

    const fence = fixture.sinkClient.status(fixture.fencedRequest);
    assert.equal(fence.state, 'not_committed');
    const fenced = await host.call(fixture.entry, [{ tag: 'string', value: 'bob' }],
      { operationId: 'call:bob', tokens: tokens('bob') });
    assert.equal(fenced.state, 'completed');
    if (fenced.state === 'completed') assert.equal(fenced.execution.ok, false);
    assert.equal(fixture.bridge.records().length, 2);
    assert.equal(fixture.bridge.records()[1].settlement?.operation.kind, 'refund');
    assert.equal(fixture.ledger.snapshot('owner:v12-budget-host').spent.usdMicros, '7');
    assert.equal(fixture.ledger.snapshot('owner:v12-budget-host').inflight.usdMicros, '0');
    assert.equal(readSinkStateHead(fixture.sinkWitness).revision, '2');

    await fixture.stopSinkWitness();
    assert.throws(() => host!.operationResult('call:alice'), /witness|settlement|sink/i,
      'cached host result must revalidate live signed sink and budget evidence');
  } finally {
    await host?.close();
    await fixture.cleanup();
  }
});
