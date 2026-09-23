import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildLedgerExample, CAP_LEDGER_APPEND } from '../../../../src/examples/ledger.ts';
import { CapabilitySealer } from '../../../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../../../src/tier2/scoped-grants.ts';
import { effectResourcePolicyDigestV2, signEffectResourcePolicyV2 } from '../../../../src/tier2/effect-resource-policy.ts';
import { createEvidenceManifest } from '../../../../src/fabric/evidence.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { ProcessHost } from '../../../../src/tier4/process-host.ts';
import { createEffectSignerAnchor, assertPinnedEffectService } from './anchor.mjs';

test('explicit legacy ProcessHost history reopens with replacement signer key, documenting compatibility risk', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-signer-reopen-'));
  let host;
  try {
    const ex = buildLedgerExample('signer-reopen');
    const digest = value => domainDigest('aether.signer-reopen-test/1', value);
    const original = createEvidenceManifest({ module: ex.module, registry: ex.capabilities,
      specification: 'Signer trust boundary test.', semanticsVersion: 'reference/1', compilerDigest: digest('compiler'),
      capabilityPolicyDigest: digest('placeholder'), target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
    const body = { format: 'aether.effect-resource-policy/2', repositoryId: 'signer-reopen', astRoot: original.astRoot, policyEpoch: '0',
      rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: 'ledger-sink',
        adapterDigest: domainDigest('aether.effect-adapter/1', 'sink'), adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/1', 'sink bytes') }] };
    const manifest = { ...original, capabilityPolicyDigest: effectResourcePolicyDigestV2(body) };
    const plan = { shape: 'containers', units: [
      { id: 'a', members: [ex.symbols.transfer], capabilities: [CAP_LEDGER_APPEND], placement: 'container', memoryMb: 16 },
      { id: 'b', members: [ex.symbols.feeFor, ex.symbols.settle, ex.symbols.accrue], capabilities: [CAP_LEDGER_APPEND], placement: 'container', memoryMb: 48 },
    ], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(41), repositoryId: body.repositoryId,
      clock: () => 100, policyEpoch: () => '0', revocationEpoch: () => '0', isRevoked: () => false,
      authorizeIssue: () => true, authorizeDelegate: () => true });
    const keyA = generateKeyPairSync('ed25519'), keyB = generateKeyPairSync('ed25519');
    const base = { directory, module: ex.module, manifest, plan, registry: ex.capabilities,
      sealer: new CapabilitySealer(new Uint8Array(32).fill(7), () => 100), scopedGrants: grants,
      currentEffectPolicyEpoch: () => '0' };
    const signedA = signEffectResourcePolicyV2(body, 'same-signer-name', keyA.privateKey);
    const signedB = signEffectResourcePolicyV2(body, 'same-signer-name', keyB.privateKey);
    const anchor = createEffectSignerAnchor({ repositoryId: body.repositoryId, signer: 'same-signer-name',
      publicKey: keyA.publicKey, currentEpoch: () => '0' });
    await assert.rejects(ProcessHost.open({ ...base, signedEffectResourcePolicy: signedA, effectResourceSignerKey: keyA.publicKey }), /explicit legacy signer trust profile/);
    host = await ProcessHost.open({ ...base, signedEffectResourcePolicy: signedA, effectResourceSignerKey: keyA.publicKey, legacyEffectSignerTrust: 'factory-v1' });
    const firstGeneration = host.generation;
    await host.close(); host = undefined;
    // The explicit compatibility mode preserves old configuration identity.
    // Its journal commits signer ID and policy body digest but omits key bytes.
    host = await ProcessHost.open({ ...base, signedEffectResourcePolicy: signedB, effectResourceSignerKey: keyB.publicKey, legacyEffectSignerTrust: 'factory-v1' });
    assert.equal(host.generation, firstGeneration);
    assert.ok((await host.snapshot()).heapId);
    await host.close(); host = undefined;
    // An independently supplied pin rejects the same replay before host open.
    assert.throws(() => assertPinnedEffectService(anchor, manifest, { scopedGrants: grants, signedEffectResourcePolicy: signedB }, anchor.digest), /untrusted effect resource policy v2 signer/);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
