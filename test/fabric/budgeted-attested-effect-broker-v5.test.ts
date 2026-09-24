import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capability as capabilityName, type CapabilityName, type NodeRef } from '../../src/tier1/ids.ts';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { domainDigest, executionManifestDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { DurableEffectBroker, effectAdapterDigest, effectPayloadDigest, effectRequestDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { createAttestedSinkAdapter, type AttestedSinkClientV1 } from '../../src/fabric/attested-sink-adapter.ts';
import { createNamespacedEffectJournalWitness, type WitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { createBudgetJournalWitness, type BudgetJournalHead } from '../../src/fabric/budget-journal-witness.ts';
import { advanceSinkStateHead, createSinkStateWitness, type SinkStateHeadV1 } from '../../src/fabric/sink-state-witness.ts';
import { signSinkReceipt, sinkValueDigest, type SinkPublicAnchorV1, type SignedSinkReceiptV1 } from '../../src/fabric/sink-receipt.ts';
import { ResourceBudgetLedger, RESOURCE_BUDGET_PROFILE, type ResourceAmounts } from '../../src/tier2/resource-budget.ts';
import { ResourceBudgetBridge, type ResourceBudgetBridgeProfile } from '../../src/tier2/resource-budget-bridge.ts';
import { attestedSinkBudgetEvidencePolicyDigest, createAttestedSinkBudgetEvidence,
  type AttestedSinkBudgetEvidence } from '../../src/tier2/attested-sink-budget-evidence.ts';
import { declarativeSinkTableDigestV2, type DeclarativeSinkTableV2 } from '../../src/tier2/declarative-sink-table.ts';
import { effectResourcePolicyDigestV7, signEffectResourcePolicyV7,
  type EffectResourcePolicyBodyV7 } from '../../src/tier2/effect-resource-policy.ts';
import { BrokerEffectRouter, brokerAssertAttestedSinkAuthority, brokerAttestBudgetAuthority,
  brokerAssertAdmissionTableV2, brokerAttestContext, brokerBind, brokerInspectRecorded,
  brokerInvoke, brokerPinWitness } from '../../src/tier3/effects.ts';

const amount = (n: number): ResourceAmounts => ({ usdMicros: String(n), tokens: String(n), nanoseconds: String(n), memoryBytes: String(n) });
const value: TaggedValueV1 = { tag: 'int', value: '42' };
const payload: TaggedValueV1 = { tag: 'sequence', items: [{ tag: 'string', value: 'sink' }, { tag: 'int', value: '42' }] };
const metadata = domainDigest('aether.fixture/1', 'v5-budget-test');
const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: `ast:b3:${'0'.repeat(64)}`,
  specRoot: metadata, dependencies: [], semanticsVersion: 'test/1', compilerDigest: metadata,
  target: { abiVersion: 'test/1', profileDigest: metadata, artifactDigest: metadata },
  capabilityPolicyDigest: metadata, evidencePolicyDigest: metadata };
function request(): EffectRequestV1 {
  return { format: 'aether.effect/1', executionId: 'execution:v5', effectId: 'operation-0', branchId: null,
    executionManifest: executionManifestDigest(manifest), capabilityGrantRef: 'grant:sink',
    policyEpoch: '1', payloadDigest: effectPayloadDigest(payload), payload,
    budgetReservationId: 'grant-0', deadline: '1000' };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-budgeted-broker-v5-'));
  const keys = generateKeyPairSync('ed25519'), budgetKeys = generateKeyPairSync('ed25519');
  const req = request(), repositoryId = 'repo:v5', deploymentId = 'deployment:v5';
  const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId,
    sinkAuthorityId: 'authority:v5', sinkId: 'sink:v5', keyId: 'key:v5', keyEpoch: '1',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
  const artifact = domainDigest('aether.effect-adapter-artifact/2', 'v5-test');
  let effectHead: WitnessHead = { revision: '0', journal: null };
  const effectWitness = createNamespacedEffectJournalWitness({ authorityId: 'operator:effects',
    repositoryId, catalogDeploymentId: deploymentId, operationId: 'v5-budgeted', clockDomain: 'clock:v5',
    read: () => effectHead, advance(expected, journal) {
      assert.equal(effectHead.revision, expected);
      effectHead = { revision: String(BigInt(expected) + 1n), journal }; return effectHead;
    } });
  let sinkHead: SinkStateHeadV1 = { revision: '0', journal: null }, witnessOutage = false;
  const sinkWitness = createSinkStateWitness({ authorityId: 'operator:sink', anchor,
    adapterArtifactDigest: artifact, read: () => {
      if (witnessOutage) throw new Error('sink witness offline');
      return sinkHead;
    }, advance(expected, journal) {
      assert.equal(sinkHead.revision, expected);
      sinkHead = { revision: String(BigInt(expected) + 1n), journal }; return sinkHead;
    } });
  const receipt = (disposition: 'committed' | 'not_committed'): SignedSinkReceiptV1 =>
    signSinkReceipt({ format: 'aether.sink-receipt-body/1', repositoryId, deploymentId,
      executionId: req.executionId, effectId: req.effectId, requestDigest: effectRequestDigest(req),
      payloadDigest: req.payloadDigest, sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId,
      adapterArtifactDigest: artifact, policyEpoch: req.policyEpoch, capabilityGrantRef: req.capabilityGrantRef,
      keyId: anchor.keyId, keyEpoch: anchor.keyEpoch, disposition,
      valueDigest: disposition === 'committed' ? sinkValueDigest(value) : null,
      decisionId: 'decision:v5', commitId: disposition === 'committed' ? 'commit:v5' : null,
      sinkSequence: '1' }, keys.privateKey, anchor);
  const publish = (disposition: 'committed' | 'not_committed') => {
    if (sinkHead.journal !== null) return;
    const journal = { format: 'aether.attested-sink-state/2', witnessDigest: sinkWitness.digest,
      witnessRevision: '1', anchor, adapterArtifactDigest: artifact,
      decisions: [{ repositoryId, deploymentId, request: req,
        value: disposition === 'committed' ? value : null, receipt: receipt(disposition) }] };
    advanceSinkStateHead(sinkWitness, '0', Buffer.from(encodeCanonical(journal)).toString('utf8'));
  };
  let status: 'unknown' | 'fence' | 'commit' = 'unknown', publishStatus = false, executes = 0;
  const client: AttestedSinkClientV1 = {
    execute: () => { executes++; publish('committed'); return { state: 'committed', receipt: receipt('committed'), value }; },
    status: () => {
      if (status === 'unknown') return { state: 'unknown' };
      const disposition = status === 'fence' ? 'not_committed' : 'committed';
      if (publishStatus) publish(disposition);
      return disposition === 'committed'
        ? { state: 'committed', receipt: receipt(disposition), value }
        : { state: 'not_committed', receipt: receipt(disposition) };
    },
  };
  const adapter = createAttestedSinkAdapter({ id: 'adapter:v5', repositoryId, deploymentId,
    approvedAdapterArtifactDigest: artifact, anchor, client });
  const policy = { witness: sinkWitness, anchor, repositoryId, deploymentId,
    approvedAdapterArtifactDigest: artifact, owner: 'budget-owner', charge: amount(7), expectedRequests: [req] };
  const policyDigest = attestedSinkBudgetEvidencePolicyDigest(policy);
  let ledgerHead: BudgetJournalHead = { revision: '0', journal: null };
  const ledgerWitness = createBudgetJournalWitness({ authorityId: 'operator:budget-ledger', repositoryId,
    deploymentId, journalKind: 'ledger', journalId: 'v5-budget', read: () => ledgerHead,
    advance(expected, journal) { assert.equal(ledgerHead.revision, expected);
      ledgerHead = { revision: String(BigInt(expected) + 1n), journal }; return ledgerHead; } });
  let evidence!: AttestedSinkBudgetEvidence;
  const ledger = new ResourceBudgetLedger({ directory: join(directory, 'ledger'),
    profile: { format: RESOURCE_BUDGET_PROFILE, ledgerId: 'v5-budget', policyEpoch: '1',
      initialOwner: 'budget-owner', initial: amount(10), maxOperations: 20 },
    key: budgetKeys.privateKey, authorize: () => true, revalidateSettlementOnRead: true,
    settlementEvidencePolicyDigest: policyDigest, journalWitness: ledgerWitness,
    verifySettlement: settlement => evidence.verifySettlement(settlement) });
  evidence = createAttestedSinkBudgetEvidence({ ...policy, ledgerDigest: ledger.ledgerDigest });
  const bridgeProfile: ResourceBudgetBridgeProfile = { format: 'aether.resource-budget-bridge/1',
    bridgeId: 'bridge:v5', actor: 'budget-owner', brokerAuthority: 'broker:v5',
    grants: [{ id: 'grant-0', handle: ledger.genesisHandle('budget-owner'),
      executionManifest: req.executionManifest, policyEpoch: req.policyEpoch }] };
  let bridgeHead: BudgetJournalHead = { revision: '0', journal: null };
  const bridgeWitness = createBudgetJournalWitness({ authorityId: 'operator:budget-bridge', repositoryId,
    deploymentId, journalKind: 'bridge', journalId: 'bridge:v5', read: () => bridgeHead,
    advance(expected, journal) { assert.equal(bridgeHead.revision, expected);
      bridgeHead = { revision: String(BigInt(expected) + 1n), journal }; return bridgeHead; } });
  let broker!: DurableEffectBroker, authorizations = 0, denyOn = -1,
    failReserved = false, failReserveAfterLedger = false;
  const bridge = new ResourceBudgetBridge({ directory: join(directory, 'bridge'), profile: bridgeProfile,
    ledger, key: budgetKeys.privateKey, journalWitness: bridgeWitness, mode: () => broker.executionMode,
    authorize: () => true, observe: evidence.observe,
    fault: (phase, operation) => {
      if (failReserveAfterLedger && phase === 'after-ledger' && operation === 'reserve') {
        failReserveAfterLedger = false; throw new Error('simulated reserve receipt crash');
      }
    } });
  const brokerOptions = { directory: join(directory, 'broker'), clockDomain: 'clock:v5', clock: () => 100n,
    authorize: () => ++authorizations !== denyOn, authorizeReconciliation: () => true,
    beforePersist: (event: { state: string }) => {
      if (failReserved && event.state === 'reserved') {
        failReserved = false; throw new Error('simulated prepublication crash');
      }
    },
    witness: effectWitness, attestedSinkV4: { anchor, deploymentId,
      approvedAdapterArtifactDigest: artifact, sinkStateWitness: sinkWitness },
    attestedSinkBudgetV1: { format: 'aether.attested-sink-budget-broker/1' as const,
      bridge, bridgeProfileDigest: bridge.profileDigest } };
  broker = new DurableEffectBroker(brokerOptions);
  broker.assertBudgetAuthority(bridge, bridge.profileDigest);
  const initialLedgerHead = ledgerHead, initialBridgeHead = bridgeHead;
  return { directory, req, adapter, broker, brokerOptions, bridge, ledger, effectWitness, sinkWitness,
    identity: { repositoryId, deploymentId, approvedAdapterArtifactDigest: artifact, anchor },
    rollbackBudgetHead(kind: 'ledger' | 'bridge') {
      if (kind === 'ledger') ledgerHead = initialLedgerHead;
      else bridgeHead = initialBridgeHead;
    },
    setStatus(next: typeof status, publishRow: boolean) { status = next; publishStatus = publishRow; },
    setWitnessOutage(value: boolean) { witnessOutage = value; },
    setDenyOn(value: number) { denyOn = value; },
    failNextReserved() { failReserved = true; },
    failNextReserveReceipt() { failReserveAfterLedger = true; },
    get executes() { return executes; },
    close() { rmSync(directory, { recursive: true, force: true }); } };
}

test('V5 predispatch denial holds funds until an exact signed witnessed noncommit fence', () => {
  const f = fixture();
  try {
    f.setDenyOn(3);
    assert.deepEqual(f.broker.dispatch(f.req, f.adapter),
      { state: 'indeterminate', recoveryId: effectRequestDigest(f.req) });
    assert.equal(f.executes, 0);
    assert.equal(f.ledger.snapshot('budget-owner').inflight.usdMicros, '10');
    f.setStatus('fence', false);
    assert.equal(f.broker.reconcile(f.req, f.adapter).state, 'indeterminate',
      'a signed response absent from the operator witness cannot refund');
    assert.equal(f.ledger.snapshot('budget-owner').inflight.usdMicros, '10');
    f.setStatus('fence', true);
    assert.deepEqual(f.broker.reconcile(f.req, f.adapter),
      { state: 'aborted', code: 'sink_confirmed_not_committed' });
    assert.equal(f.ledger.snapshot('budget-owner').inflight.usdMicros, '0');
    assert.equal(f.ledger.snapshot('budget-owner').spent.usdMicros, '0');
    assert.equal(f.broker.dispatch(f.req, f.adapter).state, 'aborted');
    assert.equal(f.executes, 0);
    assert.equal(f.broker.events()[0].format, 'aether.effect-event/4');
    assert.equal(f.broker.events()[0].signedSinkReceipt?.body.disposition, 'not_committed');
  } finally { f.close(); }
});

test('V5 recovers a reserve that reached the bridge before broker publication', () => {
  const f = fixture();
  try {
    f.failNextReserved();
    assert.equal(f.broker.dispatch(f.req, f.adapter).state, 'indeterminate');
    assert.equal(f.executes, 0);
    assert.equal(f.ledger.snapshot('budget-owner').inflight.usdMicros, '10');
    const event = f.broker.events()[0];
    assert.deepEqual(event.transitions.map(step => step.state), ['requested', 'indeterminate']);
    f.setStatus('fence', true);
    assert.equal(f.broker.reconcile(f.req, f.adapter).state, 'aborted');
    assert.equal(f.ledger.snapshot('budget-owner').inflight.usdMicros, '0');
    assert.equal(f.ledger.snapshot('budget-owner').spent.usdMicros, '0');
  } finally { f.close(); }
});

test('V5 keeps funds encumbered when the bridge loses its reserve receipt', () => {
  const f = fixture();
  try {
    f.failNextReserveReceipt();
    assert.equal(f.broker.dispatch(f.req, f.adapter).state, 'indeterminate');
    assert.equal(f.ledger.snapshot('budget-owner').inflight.usdMicros, '10');
    assert.equal(f.executes, 0);
    f.setStatus('fence', true);
    assert.equal(f.broker.reconcile(f.req, f.adapter).state, 'aborted');
    assert.equal(f.ledger.snapshot('budget-owner').inflight.usdMicros, '0');
  } finally { f.close(); }
});

test('V5 router pins operator bridge, grant and full recorded reservation identity', () => {
  const f = fixture();
  try {
    const capability = 'sink' as CapabilityName;
    const makeRouter = (reservationId: string) => new BrokerEffectRouter({ broker: f.broker,
      manifest, executionId: f.req.executionId, policyEpoch: f.req.policyEpoch, deadline: f.req.deadline,
      adapters: new Map([[capability, f.adapter]]), grant: () => 'forged:callback',
      grantRef: f.req.capabilityGrantRef, budgetReservationId: reservationId });
    const budget = { format: 'aether.attested-sink-budget-router/1' as const,
      reservationId: f.req.budgetReservationId!, bridgeProfileDigest: f.bridge.profileDigest };
    const context = { executionId: f.req.executionId, manifestDigest: f.req.executionManifest,
      mode: 'live' as const, policyEpoch: f.req.policyEpoch, deadline: f.req.deadline,
      clockDomain: 'clock:v5', capability, grantRef: f.req.capabilityGrantRef };
    const omitted = makeRouter('grant-0'); brokerBind(omitted, manifest.astRoot as NodeRef);
    assert.throws(() => brokerAttestContext(omitted, context), /unattested budget reservation/);
    const substituted = makeRouter('grant-other'); brokerBind(substituted, manifest.astRoot as NodeRef);
    assert.throws(() => brokerAttestContext(substituted, { ...context, budget }), /reservation differs/);
    const router = makeRouter('grant-0'); brokerBind(router, manifest.astRoot as NodeRef);
    brokerAttestContext(router, { ...context, budget });
    brokerPinWitness(router, f.effectWitness);
    brokerAssertAttestedSinkAuthority(router, capability, f.identity, f.sinkWitness);
    assert.throws(() => brokerInvoke(router, capability, [42n]), /lacks operator authority/);
    assert.throws(() => brokerAttestBudgetAuthority(router, Object.create(ResourceBudgetBridge.prototype), budget),
      /bridge|instance|trusted/);
    brokerAttestBudgetAuthority(router, f.bridge, budget);
    assert.equal(brokerInvoke(router, capability, [42n]), 42n);
    assert.equal(f.broker.events()[0].request.budgetReservationId, 'grant-0');
    assert.equal(f.broker.events()[0].request.capabilityGrantRef, 'grant:sink');
    assert.throws(() => brokerInspectRecorded(router, capability, { ...f.req, budgetReservationId: 'grant-other' }),
      /recorded Wasm effect differs/);
  } finally { f.close(); }
});

test('signed V7 router checks its private complete adapter map before any live dispatch', () => {
  const f = fixture();
  try {
    const capability = capabilityName('cap:test:sink');
    const entry = { id: 'registration:sink', capability, adapterId: f.adapter.id,
      adapterDigest: effectAdapterDigest(f.adapter),
      adapterArtifactDigest: f.identity.approvedAdapterArtifactDigest,
      deploymentId: f.identity.deploymentId,
      sinkAnchorDigest: domainDigest('aether.sink-anchor/1', f.identity.anchor),
      sinkStateWitnessDigest: f.sinkWitness.digest,
      lifecycle: 'attested-external-no-unload/1' as const };
    const table: DeclarativeSinkTableV2 = { format: 'aether.declarative-adapter-table/2',
      repositoryId: f.identity.repositoryId, registrations: [entry] };
    const tableDigest = declarativeSinkTableDigestV2(table);
    const body: EffectResourcePolicyBodyV7 = { format: 'aether.effect-resource-policy/7',
      repositoryId: f.identity.repositoryId, astRoot: manifest.astRoot,
      policyEpoch: '1', adapterTableDigest: tableDigest,
      rules: [{ capability, prefix: ['sink'], argument: null,
        adapterId: entry.adapterId, adapterDigest: entry.adapterDigest,
        adapterArtifactDigest: entry.adapterArtifactDigest, deadline: '1000',
        clockDomain: 'clock:v5', deploymentId: entry.deploymentId,
        sinkAnchorDigest: entry.sinkAnchorDigest,
        sinkStateWitnessDigest: entry.sinkStateWitnessDigest }] };
    const keys = generateKeyPairSync('ed25519');
    const signed = signEffectResourcePolicyV7(body, 'policy:sink-table', keys.privateKey);
    const selectedManifest = { ...manifest,
      capabilityPolicyDigest: effectResourcePolicyDigestV7(body) };
    const selection = { table, policy: signed, manifest: selectedManifest,
      currentEpoch: '1', signerKey: keys.publicKey };
    const makeRouter = (adapters: Map<CapabilityName, typeof f.adapter>) => {
      const router = new BrokerEffectRouter({ broker: f.broker,
        manifest: selectedManifest, executionId: f.req.executionId,
        policyEpoch: f.req.policyEpoch, deadline: f.req.deadline,
        adapters, grant: () => 'forged:callback',
        grantRef: f.req.capabilityGrantRef, admissionTableDigest: tableDigest });
      brokerBind(router, manifest.astRoot as NodeRef);
      brokerAttestContext(router, { executionId: f.req.executionId,
        manifestDigest: executionManifestDigest(selectedManifest), mode: 'live',
        policyEpoch: f.req.policyEpoch, deadline: f.req.deadline,
        clockDomain: 'clock:v5', capability,
        grantRef: f.req.capabilityGrantRef, admissionTableDigest: tableDigest });
      brokerPinWitness(router, f.effectWitness);
      brokerAssertAttestedSinkAuthority(router, capability, f.identity, f.sinkWitness);
      return router;
    };
    const router = makeRouter(new Map([[capability, f.adapter]]));
    assert.throws(() => brokerInvoke(router, capability, [42n]), /lacks complete broker map attestation/);
    brokerAssertAdmissionTableV2(router, selection, f.identity, f.sinkWitness);
    assert.throws(() => brokerAssertAdmissionTableV2(router, selection, f.identity, f.sinkWitness),
      /differs from operator signed host selection/);
    const extra = makeRouter(new Map([[capability, f.adapter],
      ['cap:test:extra' as CapabilityName, f.adapter]]));
    Object.assign(extra, { assertAdmissionTableV2: () => undefined });
    assert.throws(() => brokerAssertAdmissionTableV2(extra, selection, f.identity, f.sinkWitness),
      /exact native adapter map/);
  } finally { f.close(); }
});

test('V5 witness outage leaves an authorized reservation encumbered', () => {
  const f = fixture();
  try {
    f.setDenyOn(3); f.setStatus('fence', false);
    assert.equal(f.broker.dispatch(f.req, f.adapter).state, 'indeterminate');
    f.setWitnessOutage(true);
    assert.equal(f.broker.reconcile(f.req, f.adapter).state, 'indeterminate');
    f.setWitnessOutage(false);
    assert.equal(f.ledger.snapshot('budget-owner').inflight.usdMicros, '10');
    assert.equal(f.broker.reconcile(f.req, f.adapter).state, 'indeterminate');
  } finally { f.close(); }
});

test('V5 predispatch status can only charge an exact signed witnessed commit once', () => {
  const f = fixture();
  try {
    f.setDenyOn(3); f.setStatus('commit', true);
    assert.equal(f.broker.dispatch(f.req, f.adapter).state, 'committed');
    assert.equal(f.executes, 0, 'the denied dispatch never enters execute');
    assert.equal(f.ledger.snapshot('budget-owner').spent.usdMicros, '7');
    assert.equal(f.ledger.snapshot('budget-owner').inflight.usdMicros, '0');
    assert.equal(f.broker.dispatch(f.req, f.adapter).state, 'committed');
    assert.equal(f.ledger.snapshot('budget-owner').spent.usdMicros, '7');
  } finally { f.close(); }
});

test('V5 rejects forged budget hooks and exact bridge substitution', () => {
  const f = fixture();
  try {
    const localBridge = new ResourceBudgetBridge({ directory: join(f.directory, 'local-bridge'),
      profile: { format: 'aether.resource-budget-bridge/1', bridgeId: 'local:v5',
        actor: 'budget-owner', brokerAuthority: 'broker:v5', grants: [{ id: 'grant-0',
          handle: f.ledger.genesisHandle('budget-owner'), executionManifest: f.req.executionManifest,
          policyEpoch: f.req.policyEpoch }] }, ledger: f.ledger,
      key: generateKeyPairSync('ed25519').privateKey, mode: () => 'live',
      authorize: () => true, observe: () => ({ state: 'unknown' }) });
    assert.throws(() => new DurableEffectBroker({ ...f.brokerOptions,
      directory: join(f.directory, 'local-broker'), attestedSinkBudgetV1: {
        format: 'aether.attested-sink-budget-broker/1', bridge: localBridge,
        bridgeProfileDigest: localBridge.profileDigest } }), /witness/);
    const impostor = Object.create(ResourceBudgetBridge.prototype) as ResourceBudgetBridge;
    assert.throws(() => new DurableEffectBroker({ ...f.brokerOptions,
      directory: join(f.directory, 'forged'), attestedSinkBudgetV1: { ...f.brokerOptions.attestedSinkBudgetV1,
        bridge: impostor } }), /bridge|instance|trusted/);
    assert.throws(() => new DurableEffectBroker({ ...f.brokerOptions,
      directory: join(f.directory, 'hook'), budgets: { reserve: () => true, consume: () => {}, release: () => {} } }),
    /exclusive/);
    assert.throws(() => f.broker.assertBudgetAuthority(impostor, f.bridge.profileDigest), /bridge|instance|trusted/);
    assert.throws(() => f.broker.assertBudgetAuthority(f.bridge, domainDigest('aether.resource-budget-bridge/1', 'other')),
      /budget authority/);
    assert.throws(() => { (f.bridge as unknown as { reserve: () => boolean }).reserve = () => true; },
      /read only|Cannot assign/);
    assert.equal(f.broker.dispatch(f.req, f.adapter).state, 'committed',
      'broker calls the frozen branded prototype method, not the instance override');
    assert.equal(f.ledger.snapshot('budget-owner').spent.usdMicros, '7');
    assert.equal(f.broker.dispatch(f.req, f.adapter).state, 'committed');
    assert.equal(f.ledger.snapshot('budget-owner').spent.usdMicros, '7');
  } finally { f.close(); }
});

test('V5 cached commits fail closed on local or witness rollback of bridge and ledger', () => {
  for (const rollback of ['bridge', 'ledger'] as const) for (const target of ['local', 'witness'] as const) {
    const f = fixture();
    try {
      const file = rollback === 'bridge' ? join(f.directory, 'bridge', 'bridge.json')
        : join(f.directory, 'ledger', 'journal.json');
      const original = readFileSync(file);
      assert.equal(f.broker.dispatch(f.req, f.adapter).state, 'committed');
      assert.equal(f.ledger.snapshot('budget-owner').spent.usdMicros, '7');
      if (target === 'local') writeFileSync(file, original);
      else f.rollbackBudgetHead(rollback);
      assert.throws(() => f.broker.inspectRecorded(f.req, f.adapter),
        /budget|witness|rollback|rolled back|tamper/, `${rollback} ${target} rollback`);
      assert.throws(() => f.broker.dispatch(f.req, f.adapter),
        /budget|witness|rollback|rolled back|tamper/, `${rollback} ${target} cached retry`);
      assert.equal(f.executes, 1);
    } finally { f.close(); }
  }
});
