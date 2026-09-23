import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { generatePortableCertificate } from '../../src/tier2/portable-proof-producer.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { FallbackTreeRuntime } from '../../src/tier3/fallback-tree.ts';
import { checkConservativeFallbackProof } from '../../src/tier3/fallback-proof.ts';

function fixture() {
  const s = new SymbolSpace('fallback-portable-proof'), tier1 = s.define('fast'), tier2 = s.define('conservative'), x = s.define('x');
  const contract = b.contract({ requires: [b.clause(b.ge(b.v(x), b.int(0)), 'nonnegative')],
    ensures: [b.clause(b.eq(b.result(), b.add(b.old(b.v(x)), b.int(1))), 'incremented')] });
  const fast = b.fn({ symbol: tier1, params: [b.param(x, b.Int)], returns: b.Int, contract,
    body: b.block(b.assert_(b.bool(false), 'speculative-fault'), b.ret(b.int(0))) });
  const conservative = b.fn({ symbol: tier2, params: [b.param(x, b.Int)], returns: b.Int, contract,
    body: b.ret(b.add(b.v(x), b.int(1))) });
  const moduleSymbol = s.define('module'), symbols = s.table();
  const module = b.module_({ symbol: moduleSymbol, members: [fast, conservative], symbolTable: symbols });
  const proofModule = b.module_({ symbol: moduleSymbol, members: [conservative], symbolTable: symbols });
  const specification = 'For nonnegative integers, the conservative result is the input plus one.';
  const registry = new CapabilityRegistry(), digest = (text: string) => domainDigest('aether.fallback-proof-test/1', text);
  const context = { registry, specification, semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'),
    capabilityPolicyDigest: digest('policy'), target: { abiVersion: 'scalar/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } };
  const manifest = createEvidenceManifest({ ...context, module });
  const proofManifest = createEvidenceManifest({ ...context, module: proofModule });
  const certificate = generatePortableCertificate(proofModule,
    { manifest: proofManifest, expectedManifest: proofManifest, specification });
  assert.ok(certificate);
  const proof = { module: proofModule, manifest: proofManifest, specification, certificate };
  return { module, manifest, proof, tier1, tier2, x, conservative, proofModule };
}

test('independent scalar Tier 2 proof binds the exact executed declaration and runtime profile', () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'aether-fallback-proof-'));
  try {
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(24), repositoryId: 'fallback-proof', clock: () => 100,
      policyEpoch: () => '0', revocationEpoch: () => '0', isRevoked: () => false,
      authorizeIssue: () => true, authorizeDelegate: () => true });
    const key = generateKeyPairSync('ed25519').privateKey;
    const runtime = new FallbackTreeRuntime({ directory, module: f.module, manifest: f.manifest, tier1: f.tier1, tier2: f.tier2,
      grants, key, conservativeProof: f.proof });
    assert.equal(runtime.conservativeProofDigest, checkConservativeFallbackProof(f.module, f.manifest, f.tier2, f.proof));
    const result = runtime.call([{ tag: 'int', value: '7' }], { operationId: 'proved-fallback', tokens: runtime.issueTokens() });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { state: 'completed', tier: 2, operationId: 'proved-fallback', value: { tag: 'int', value: '8' }, productionAuthorized: false });
    assert.throws(() => new FallbackTreeRuntime({ directory, module: f.module, manifest: f.manifest, tier1: f.tier1, tier2: f.tier2,
      grants, key }), /fallback journal\/profile bound/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('conservative proof rejects edited body, missing coverage and changed full context', () => {
  const f = fixture();
  if (f.module.kind !== 'Module' || f.proofModule.kind !== 'Module' || f.module.members[0]?.kind !== 'FunctionDecl') throw new Error('fixture module');
  const changed = { ...f.conservative, body: b.ret(b.int(0)) };
  const editedModule = { ...f.module, members: [f.module.members[0], changed] };
  assert.throws(() => checkConservativeFallbackProof(editedModule, f.manifest, f.tier2, f.proof), /module\/manifest mismatch|executed Tier 2/);
  const changedTarget = { ...f.manifest, target: { ...f.manifest.target, artifactDigest: domainDigest('aether.changed/1', 'artifact') } };
  assert.throws(() => checkConservativeFallbackProof(f.module, changedTarget, f.tier2, f.proof), /execution context mismatch/);
  assert.throws(() => checkConservativeFallbackProof(f.module, f.manifest, f.tier2,
    { ...f.proof, certificate: { ...f.proof.certificate, certificates: [] } }), /coverage/);
  assert.throws(() => checkConservativeFallbackProof(f.module, f.manifest, f.tier2,
    { ...f.proof, specification: 'false changed specification' }), /specification/);
  const empty = b.contract({});
  const fast = { ...f.module.members[0], contract: empty }, conservative = { ...f.conservative, contract: empty };
  const emptyFull = { ...f.module, members: [fast, conservative] }, emptyProof = { ...f.proofModule, members: [conservative] };
  const store = new GraphStore();
  const emptyManifest = { ...f.manifest, astRoot: store.intern(emptyFull) }, emptyProofManifest = { ...f.proof.manifest, astRoot: store.intern(emptyProof) };
  const certificate = generatePortableCertificate(emptyProof,
    { manifest: emptyProofManifest, expectedManifest: emptyProofManifest, specification: f.proof.specification });
  assert.ok(certificate, 'total return alone can be certified');
  assert.throws(() => checkConservativeFallbackProof(emptyFull, emptyManifest, f.tier2,
    { module: emptyProof, manifest: emptyProofManifest, specification: f.proof.specification, certificate }), /explicit postcondition/);
});
