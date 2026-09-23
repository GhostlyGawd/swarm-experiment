import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { DEFAULT_EVIDENCE_POLICY, DEFAULT_EVIDENCE_POLICY_V2, createEvidenceManifest, mintLocalEvidence, validateEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';

function fixture(): EvidenceContext {
  const symbols = new SymbolSpace('hard-evidence'), entry = symbols.define('entry');
  const fn = b.fn({ symbol: entry, returns: b.Int, contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(1)), 'exact-one')] }), body: b.ret(b.int(1)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [fn], symbolTable: symbols.table() });
  const digest = (value: string) => domainDigest('aether.evidence-hard-test/1', value);
  return { module, registry: new CapabilityRegistry(), specification: 'Return exactly one.', semanticsVersion: 'reference/1',
    compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('capabilities'),
    target: { abiVersion: 'local/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') }, policy: DEFAULT_EVIDENCE_POLICY_V2 };
}

test('v2 evidence policy binds hard SMT profile to exact manifest and reverified peer evidence', () => {
  const context = fixture(), manifest = createEvidenceManifest(context), evidence = mintLocalEvidence(context);
  assert.equal(manifest.evidencePolicyDigest, domainDigest('aether.evidence-policy/2', DEFAULT_EVIDENCE_POLICY_V2));
  assert.equal(evidence.envelope.checker.version, '2');
  assert.equal(validateEvidence(evidence, context).provenance, 'trusted_local');
  assert.equal(validateEvidence(JSON.parse(JSON.stringify(evidence)), context).provenance, 'reverified_peer');
  assert.throws(() => validateEvidence(evidence, { ...context, policy: DEFAULT_EVIDENCE_POLICY }), /checker|manifest|policy/);
  const forged = JSON.parse(JSON.stringify(evidence)); forged.envelope.checker.version = '1';
  assert.throws(() => validateEvidence(forged, context), /checker/);
  assert.throws(() => mintLocalEvidence({ ...context, policy: { ...DEFAULT_EVIDENCE_POLICY_V2, budgetMs: 1501 } }), /hard evidence policy/);
});
