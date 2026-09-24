import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger, signIntent, signSpecRevision } from '../../src/tier1/causal-lineage.ts';
import { buildVirtualForwardCandidate } from '../../src/tier1/semantic-gc-virtual-forward.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { createEvidenceManifest, DEFAULT_EVIDENCE_POLICY_V2, DEFAULT_EVIDENCE_POLICY_V3, mintLocalEvidence,
  validateEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { virtualForwardResumableProfileDigest } from '../../src/tier3/resumable-program.ts';

type Module = Extract<Term, { kind: 'Module' }>;

function fixture() {
  const symbols = new SymbolSpace('virtual-forward-evidence');
  const target = symbols.define('target'), wrapper = symbols.define('wrapper');
  const entry = symbols.define('entry'), x = symbols.define('x');
  const w = symbols.define('w'), n = symbols.define('n');
  const targetDecl = b.fn({ symbol: target, params: [b.param(x, b.Int)],
    returns: b.Int, contract: b.contract({}), body: b.ret(b.add(b.v(x), b.int(1))) });
  const wrapperDecl = b.fn({ symbol: wrapper, params: [b.param(w, b.Int)],
    returns: b.Int, contract: b.contract({}), body: b.block(b.ret(b.call(target, b.v(w)))) });
  const entryDecl = b.fn({ symbol: entry, params: [b.param(n, b.Int)],
    returns: b.Int, contract: b.contract({}), body: b.ret(b.call(wrapper, b.v(n))) });
  const source = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(),
    members: [targetDecl, wrapperDecl, entryDecl] }) as Module;
  const { candidate, descriptor } = buildVirtualForwardCandidate(source, wrapper, target);
  const d = (value: string) => domainDigest('aether.virtual-forward-evidence-test/1', value);
  const context: EvidenceContext = {
    module: candidate, specification: 'Keep the pure entry result and exact virtual forwarding.',
    semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'),
    target: { abiVersion: 'resumable/1', profileDigest: virtualForwardResumableProfileDigest(descriptor), artifactDigest: d('artifact') },
    capabilityPolicyDigest: d('no-effects'), registry: new CapabilityRegistry(),
    policy: DEFAULT_EVIDENCE_POLICY_V3, virtualForward: { source, descriptor },
  };
  return { context, source, candidate, descriptor, target, wrapper, targetDecl, wrapperDecl };
}

test('versioned evidence derives the archived wrapper as an exact checked dependency', () => {
  const f = fixture();
  const manifest = createEvidenceManifest(f.context);
  assert.deepEqual(manifest.dependencies.map(item => item.symbol).sort(), [f.target, f.wrapper].sort());
  assert.equal(manifest.target.profileDigest, virtualForwardResumableProfileDigest(f.descriptor));
  const evidence = mintLocalEvidence(f.context);
  assert.equal(evidence.envelope.checker.version, '3');
  assert.equal(evidence.manifest.evidencePolicyDigest, domainDigest(DEFAULT_EVIDENCE_POLICY_V3.format, DEFAULT_EVIDENCE_POLICY_V3));
  assert.equal(validateEvidence(structuredClone(evidence), f.context).manifestDigest, executionManifestDigest(manifest));
});

test('virtual evidence refuses policy, descriptor, source, profile and closure substitutions', () => {
  const f = fixture(), manifest = createEvidenceManifest(f.context);
  assert.throws(() => createEvidenceManifest({ ...f.context, virtualForward: undefined }), /versioned context/);
  assert.throws(() => createEvidenceManifest({ ...f.context, virtualForward: null as never }), /versioned context/);
  assert.throws(() => createEvidenceManifest({ ...f.context,
    policy: DEFAULT_EVIDENCE_POLICY_V2 }), /versioned context/);
  let touched = 0;
  const accessor = { ...f.context.virtualForward };
  Object.defineProperty(accessor, 'source', { enumerable: true, get() { touched++; return f.source; } });
  assert.throws(() => createEvidenceManifest({ ...f.context, virtualForward: accessor as never }), /accessor/);
  assert.equal(touched, 0);
  assert.throws(() => createEvidenceManifest({ ...f.context,
    virtualForward: new Proxy(f.context.virtualForward!, {}) }), /proxy/);
  assert.throws(() => createEvidenceManifest({ ...f.context,
    target: { ...f.context.target, profileDigest: domainDigest('aether.virtual-forward-evidence-test/1', 'unbound') } }), /target profile/);
  assert.throws(() => createEvidenceManifest({ ...f.context,
    virtualForward: { source: f.source, descriptor: { ...f.descriptor, sites: [] } } }), /descriptor/);
  assert.throws(() => createEvidenceManifest({ ...f.context,
    virtualForward: { source: { ...f.source, members: f.source.members.slice(1) }, descriptor: f.descriptor } }), /declaration|wrapper|source|descriptor/);
  const evidence = mintLocalEvidence(f.context);
  const changedManifest = { ...manifest, dependencies: manifest.dependencies.filter(item => item.symbol !== f.wrapper) };
  const changed = { ...evidence, manifest: changedManifest,
    envelope: { ...evidence.envelope, executionManifest: executionManifestDigest(changedManifest) } };
  assert.throws(() => validateEvidence(changed, f.context), /stale evidence execution manifest/);
});

test('strict signed lineage admits the archived wrapper dependency and retains it after collection', () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'aether-virtual-evidence-lineage-'));
  try {
    const store = new DurableGraphStore({ directory: join(directory, 'ast') });
    const keys = generateKeyPairSync('ed25519');
    const ledger = new CausalLineageLedger({ directory: join(directory, 'lineage'),
      repositoryId: 'virtual-evidence', store,
      authority: () => ({ policyEpoch: '0', eligibleAuthors: ['author'] }),
      authorKey: () => keys.publicKey });
    store.intern(f.source, { leaseId: 'draft' });
    store.intern(f.candidate, { leaseId: 'draft' });
    const revision = ledger.publishSpec(signSpecRevision({ repositoryId: 'virtual-evidence',
      id: 'behavior', revision: 1, previous: null, parents: [],
      text: 'Preserve the pure entry result.', requirements: [],
      author: 'author', policyEpoch: '0', nonce: 'spec-1' }, keys.privateKey));
    const specs = [{ id: 'behavior', revision }];
    const specification = ledger.specification([], specs);
    const intentFor = (context: EvidenceContext, parents: readonly string[], nonce: string) => {
      const evidence = mintLocalEvidence(context);
      const manifestDigest = executionManifestDigest(evidence.manifest);
      const intent = ledger.recordIntent(signIntent({ repositoryId: 'virtual-evidence',
        subject: evidence.manifest.astRoot as ReturnType<DurableGraphStore['intern']>,
        executionManifest: manifestDigest,
        evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', evidence),
        parents, specifications: specs, purpose: parents.length ? 'rewrite' : 'genesis',
        text: 'Preserve the signed behavior.', author: 'author', policyEpoch: '0', nonce }, keys.privateKey));
      return { evidence, manifestDigest, intent };
    };
    const sourceContext: EvidenceContext = { ...f.context, module: f.source,
      specification, policy: DEFAULT_EVIDENCE_POLICY_V2, virtualForward: undefined,
      target: { ...f.context.target, profileDigest: domainDigest('aether.virtual-forward-evidence-test/1', 'source-profile') } };
    const source = intentFor(sourceContext, [], 'source');
    ledger.admitArtifact(source.intent, source.evidence, sourceContext);
    const candidateContext: EvidenceContext = { ...f.context, specification };
    const candidate = intentFor(candidateContext, [source.intent], 'candidate');
    assert.throws(() => ledger.admitArtifact(candidate.intent, candidate.evidence,
      { ...candidateContext, virtualForward: { source: f.source,
        descriptor: { ...f.descriptor, sites: [] } } }), /descriptor/);
    ledger.admitArtifact(candidate.intent, candidate.evidence, candidateContext);
    ledger.assertCurrent(candidate.manifestDigest);
    ledger.assertNodeCurrent(candidate.manifestDigest, f.descriptor.wrapperDeclaration);
    store.release('draft'); store.collectGarbage();
    assert.equal(store.hydrate(f.descriptor.wrapperDeclaration).kind, 'FunctionDecl');
    const reopened = new CausalLineageLedger({ directory: join(directory, 'lineage'),
      repositoryId: 'virtual-evidence', store,
      authority: () => ({ policyEpoch: '0', eligibleAuthors: ['author'] }),
      authorKey: () => keys.publicKey });
    reopened.assertCurrent(candidate.manifestDigest);
    reopened.assertNodeCurrent(candidate.manifestDigest, f.descriptor.wrapperDeclaration);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
