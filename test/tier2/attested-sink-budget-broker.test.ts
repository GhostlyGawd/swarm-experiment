import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { DurableEffectBroker, effectPayloadDigest,
  type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { createAttestedSinkAdapter } from '../../src/fabric/attested-sink-adapter.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { createNamespacedEffectJournalWitness, type WitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { readSinkStateHead } from '../../src/fabric/sink-state-witness.ts';
import type { SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';
import { ResourceBudgetLedger, RESOURCE_BUDGET_PROFILE,
  type ResourceAmounts } from '../../src/tier2/resource-budget.ts';
import { ResourceBudgetBridge, type ResourceBudgetBridgeProfile } from '../../src/tier2/resource-budget-bridge.ts';
import { attestedSinkBudgetEvidencePolicyDigest, createAttestedSinkBudgetEvidence,
  type AttestedSinkBudgetEvidence } from '../../src/tier2/attested-sink-budget-evidence.ts';

const sourceRoot = resolve(import.meta.dirname, '../..');
const amounts = (value: number): ResourceAmounts => ({ usdMicros: String(value),
  tokens: String(value), nanoseconds: String(value), memoryBytes: String(value) });
async function launch(script: string, config: string, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types',
    join(sourceRoot, 'src/fabric', script), '--config', config],
  { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveReady, reject) => {
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`startup timeout: ${stderr}`)); }, 8000);
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.stdout!.on('data', chunk => {
      if (String(chunk).includes(ready)) { clearTimeout(timer); resolveReady(child); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`service exit ${code}: ${stderr}`)); });
  });
}
async function kill(child: ChildProcess | null): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL'); await once(child, 'exit');
  }
}
function request(effectId: string, grantId: string): EffectRequestV1 {
  const payload: TaggedValueV1 = { tag: 'string', value: `entry:${effectId}` };
  return { format: 'aether.effect/1', executionId: 'execution:budgeted-sink', effectId,
    branchId: null, executionManifest: domainDigest('aether.execution/1', 'budgeted-sink'),
    capabilityGrantRef: 'grant:external-sink', policyEpoch: '1', payload,
    payloadDigest: effectPayloadDigest(payload), budgetReservationId: grantId,
    deadline: '1000' };
}

test('real witnessed sink settles one fixed charge, signed fence refund, and unknown reservation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-attested-budget-'));
  let witnessProcess: ChildProcess | null = null, sinkProcess: ChildProcess | null = null;
  try {
    const repositoryId = 'repo:budgeted-sink', deploymentId = 'deployment:budgeted-sink',
      clockDomain = 'clock:budgeted-sink';
    const sinkKeys = generateKeyPairSync('ed25519'), budgetKeys = generateKeyPairSync('ed25519');
    const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId,
      sinkAuthorityId: 'authority:budgeted-sink', sinkId: 'sink:budgeted-ledger',
      keyId: 'key:budgeted-sink', keyEpoch: '1',
      publicKey: sinkKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const artifact = domainDigest('aether.effect-adapter-artifact/2', 'budgeted-sink-fixture');
    const first = request('effect:one', 'grant-0'),
      second = request('effect:two', 'grant-1'), third = request('effect:three', 'grant-2');
    const witnessSocket = join(directory, 'witness.sock'), sinkSocket = join(directory, 'sink.sock');
    const witnessKeyFile = join(directory, 'witness.key'), sinkKeyFile = join(directory, 'sink.key');
    const signerFile = join(directory, 'signer.pem'), witnessConfig = join(directory, 'witness.json');
    const sinkConfig = join(directory, 'sink.json');
    const witnessKey = randomBytes(32), sinkKey = randomBytes(32);
    writeFileSync(witnessKeyFile, witnessKey, { mode: 0o600 });
    writeFileSync(sinkKeyFile, sinkKey, { mode: 0o600 });
    writeFileSync(signerFile, sinkKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    writeFileSync(witnessConfig, encodeCanonical({ socketPath: witnessSocket,
      storageDir: join(directory, 'witness-store'), keyFile: witnessKeyFile,
      namespaces: [{ kind: 'sink-scope', authorityId: 'operator:budgeted-sink',
        anchor, adapterArtifactDigest: artifact }] }), { mode: 0o600 });
    writeFileSync(sinkConfig, encodeCanonical({ format: 'aether.attested-sink-config/2',
      socketPath: sinkSocket, storageDir: join(directory, 'sink-store'), authKeyFile: sinkKeyFile,
      signingKeyFile: signerFile, anchor, adapterArtifactDigest: artifact,
      witnessSocketPath: witnessSocket, witnessKeyFile,
      witnessAuthorityId: 'operator:budgeted-sink' }), { mode: 0o600 });
    witnessProcess = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready');
    sinkProcess = await launch('attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    const sinkWitness = createProcessWitnessClient({ socketPath: witnessSocket, key: witnessKey })
      .sinkStateWitness({ authorityId: 'operator:budgeted-sink', anchor,
        adapterArtifactDigest: artifact });
    const client = createAttestedSinkClient({ socketPath: sinkSocket, authKey: sinkKey,
      anchor, adapterArtifactDigest: artifact, repositoryId, deploymentId, timeoutMs: 5000 });
    const adapter = createAttestedSinkAdapter({ id: 'adapter:budgeted-sink', client,
      repositoryId, deploymentId, approvedAdapterArtifactDigest: artifact, anchor });
    const evidencePolicyDigest = attestedSinkBudgetEvidencePolicyDigest({ witness: sinkWitness,
      anchor, repositoryId, deploymentId, approvedAdapterArtifactDigest: artifact,
      owner: 'budget-service', charge: amounts(7), expectedRequests: [first, second, third] });
    let evidence!: AttestedSinkBudgetEvidence;
    const budgetProfile = { format: RESOURCE_BUDGET_PROFILE, ledgerId: 'budgeted-sink',
      policyEpoch: '1', initialOwner: 'budget-service', initial: amounts(30), maxOperations: 100 };
    const budgetOptions = { directory: join(directory, 'ledger'), profile: budgetProfile,
      key: budgetKeys.privateKey, authorize: () => true,
      revalidateSettlementOnRead: true, settlementEvidencePolicyDigest: evidencePolicyDigest,
      verifySettlement: (settlement: Parameters<AttestedSinkBudgetEvidence['verifySettlement']>[0]) =>
        evidence.verifySettlement(settlement) };
    const ledger = new ResourceBudgetLedger(budgetOptions);
    evidence = createAttestedSinkBudgetEvidence({ witness: sinkWitness, anchor,
      repositoryId, deploymentId, approvedAdapterArtifactDigest: artifact,
      ledgerDigest: ledger.ledgerDigest, owner: 'budget-service', charge: amounts(7),
      expectedRequests: [first, second, third] });
    assert.equal(evidence.policyDigest, evidencePolicyDigest);
    const original = ledger.genesisHandle('budget-service');
    const split = ledger.apply({ format: 'aether.resource-operation/1', operationId: 'split:budgeted',
      actor: 'budget-service', operation: { kind: 'split', handle: original,
        parts: [amounts(10), amounts(10), amounts(10)] } });
    assert.equal(split.status, 'applied');
    const bridgeProfile: ResourceBudgetBridgeProfile = { format: 'aether.resource-budget-bridge/1',
      bridgeId: 'attested-sink-budget', actor: 'budget-service',
      brokerAuthority: 'operator:broker', grants: split.handles.map((handle, index) => ({
        id: `grant-${index}`, handle, executionManifest: first.executionManifest,
        policyEpoch: '1' })) };
    let effectHead: WitnessHead = { revision: '0', journal: null };
    const effectWitness = createNamespacedEffectJournalWitness({ authorityId: 'operator:effects',
      repositoryId, catalogDeploymentId: deploymentId, operationId: 'budgeted-broker',
      clockDomain, read: () => effectHead,
      advance(expected, journal) {
        assert.equal(effectHead.revision, expected);
        effectHead = { revision: String(BigInt(expected) + 1n), journal };
        return effectHead;
      } });
    let broker!: DurableEffectBroker;
    const bridgeOptions = { directory: join(directory, 'bridge'), profile: bridgeProfile,
      ledger, key: budgetKeys.privateKey, mode: () => broker.executionMode,
      authorize: () => true, observe: evidence.observe };
    const bridge = new ResourceBudgetBridge(bridgeOptions);
    let killWitnessAtDispatch = false;
    const brokerOptions = { directory: join(directory, 'broker'), clockDomain,
      clock: () => 100n, authorize: () => true, authorizeReconciliation: () => true,
      witness: effectWitness, attestedSinkV4: { anchor, deploymentId,
        approvedAdapterArtifactDigest: artifact, sinkStateWitness: sinkWitness }, budgets: bridge,
      beforePersist: (event: { state: string; dispatchStarted: boolean }) => {
        if (killWitnessAtDispatch && event.state === 'prepared' && event.dispatchStarted) {
          killWitnessAtDispatch = false;
          process.kill(witnessProcess!.pid!, 'SIGKILL');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      } };
    broker = new DurableEffectBroker(brokerOptions);
    const committed = broker.dispatch(first, adapter);
    assert.equal(committed.state, 'committed');
    assert.equal(ledger.snapshot('budget-service').spent.usdMicros, '7');
    assert.equal(ledger.snapshot('budget-service').inflight.usdMicros, '0');
    assert.deepEqual(encodeCanonical(broker.dispatch(first, adapter)), encodeCanonical(committed));
    assert.equal(readSinkStateHead(sinkWitness).revision, '1');
    assert.throws(() => new ResourceBudgetLedger({ ...budgetOptions,
      revalidateSettlementOnRead: false, settlementEvidencePolicyDigest: undefined }),
    /profile\/key mismatch/,
    'an established evidence-revalidating ledger cannot reopen under weaker options');
    const differentChargePolicy = attestedSinkBudgetEvidencePolicyDigest({ witness: sinkWitness,
      anchor, repositoryId, deploymentId, approvedAdapterArtifactDigest: artifact,
      owner: 'budget-service', charge: amounts(8), expectedRequests: [first, second, third] });
    assert.throws(() => new ResourceBudgetLedger({ ...budgetOptions,
      settlementEvidencePolicyDigest: differentChargePolicy }), /profile\/key mismatch/,
    'a different charge schedule cannot reuse the established ledger identity');
    const differentInventoryPolicy = attestedSinkBudgetEvidencePolicyDigest({ witness: sinkWitness,
      anchor, repositoryId, deploymentId, approvedAdapterArtifactDigest: artifact,
      owner: 'budget-service', charge: amounts(7), expectedRequests: [first, second] });
    assert.throws(() => new ResourceBudgetLedger({ ...budgetOptions,
      settlementEvidencePolicyDigest: differentInventoryPolicy }), /profile\/key mismatch/,
    'a missing pinned request cannot reuse the established ledger identity');
    const reopenedEvidence = createAttestedSinkBudgetEvidence({ witness: sinkWitness, anchor,
      repositoryId, deploymentId, approvedAdapterArtifactDigest: artifact,
      ledgerDigest: ledger.ledgerDigest, owner: 'budget-service', charge: amounts(7),
      expectedRequests: [first, second, third] });
    assert.equal(reopenedEvidence.policyDigest, evidencePolicyDigest);
    assert.throws(() => reopenedEvidence.observe({ ...first,
      capabilityGrantRef: 'grant:forged', budgetReservationId: 'grant-2' }),
    /identity conflict|expected request/);
    const reopenedLedger = new ResourceBudgetLedger({ ...budgetOptions,
      verifySettlement: reopenedEvidence.verifySettlement });
    assert.equal(reopenedLedger.ledgerDigest, ledger.ledgerDigest);
    assert.equal(reopenedLedger.snapshot('budget-service').spent.usdMicros, '7');
    const reopenedBridge = new ResourceBudgetBridge({ ...bridgeOptions,
      ledger: reopenedLedger, observe: reopenedEvidence.observe });
    broker = new DurableEffectBroker({ ...brokerOptions, budgets: reopenedBridge });
    assert.deepEqual(encodeCanonical(broker.dispatch(first, adapter)), encodeCanonical(committed));
    assert.equal(ledger.snapshot('budget-service').spent.usdMicros, '7');

    const fenced = client.status(second);
    assert.equal(fenced.state, 'not_committed');
    assert.equal(broker.dispatch(second, adapter).state, 'indeterminate');
    assert.equal(broker.reconcile(second, adapter).state, 'aborted');
    assert.equal(ledger.snapshot('budget-service').spent.usdMicros, '7');
    assert.equal(ledger.snapshot('budget-service').inflight.usdMicros, '0');
    assert.equal(reopenedBridge.records()[1].settlement?.operation.kind, 'refund');
    assert.equal(readSinkStateHead(sinkWitness).revision, '2');

    await kill(witnessProcess); witnessProcess = null;
    assert.throws(() => broker.dispatch(third, adapter), /uncertain witness response/);
    assert.throws(() => reopenedLedger.snapshot('budget-service'),
      /historical resource settlement evidence rejected/);
    witnessProcess = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready');
    assert.equal(reopenedLedger.snapshot('budget-service').inflight.usdMicros, '0');
    killWitnessAtDispatch = true;
    assert.equal(broker.dispatch(third, adapter).state, 'indeterminate');
    await kill(witnessProcess); witnessProcess = null;
    assert.throws(() => reopenedLedger.snapshot('budget-service'),
      /historical resource settlement evidence rejected/);
    assert.throws(() => reopenedBridge.release(third),
      /historical resource settlement evidence rejected|indeterminate/);
    witnessProcess = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready');
    assert.equal(reopenedLedger.snapshot('budget-service').inflight.usdMicros, '10');
    assert.equal(broker.reconcile(third, adapter).state, 'aborted');
    assert.equal(ledger.snapshot('budget-service').inflight.usdMicros, '0');
    assert.equal(ledger.snapshot('budget-service').spent.usdMicros, '7');
    assert.equal(readSinkStateHead(sinkWitness).revision, '3');
  } finally {
    await kill(sinkProcess); await kill(witnessProcess);
    rmSync(directory, { recursive: true, force: true });
  }
});
