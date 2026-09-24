import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import type { NodeRef } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { encode as encodeIR } from '../../src/tier1/agent-ir.ts';
import { CausalLineageLedger, signIntent, signSpecRevision } from '../../src/tier1/causal-lineage.ts';
import { buildVirtualForwardCandidate } from '../../src/tier1/semantic-gc-virtual-forward.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { createEvidenceManifest, DEFAULT_EVIDENCE_POLICY_V2, DEFAULT_EVIDENCE_POLICY_V3,
  mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { RESUMABLE_PROFILE_DIGEST, virtualForwardResumableProfileDigest } from '../../src/tier3/resumable-program.ts';
import { decodeProcessVirtualArtifactV3, encodeProcessVirtualArtifactV3,
  makeProcessVirtualArtifactV3, measureExecutableSubjectV1,
  processVirtualArtifactDigestV3, validateProcessVirtualArtifactV3 } from '../../src/tier4/process-virtual-artifact.ts';
import { processMigrationPlan } from '../../src/tier4/process-deployment.ts';

type Module = Extract<Term, { kind: 'Module' }>;

function fixture(options: { unrelatedCandidate?: boolean; effectfulEntry?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-artifact-v3-'));
  const bundlePath = join(directory, 'worker.mjs'), sourcePath = join(directory, 'worker.ts');
  writeFileSync(bundlePath, 'export const worker = 1;\n');
  writeFileSync(sourcePath, 'export const worker: number = 1;\n');
  const subject = measureExecutableSubjectV1(bundlePath, [sourcePath]);
  const symbols = new SymbolSpace('process-virtual-artifact');
  const target = symbols.define('target'), wrapper = symbols.define('wrapper');
  const entry = symbols.define('entry'), x = symbols.define('x');
  const w = symbols.define('w'), n = symbols.define('n');
  const targetDecl = b.fn({ symbol: target, params: [b.param(x, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.ret(b.add(b.v(x), b.int(1))) });
  const wrapperDecl = b.fn({ symbol: wrapper, params: [b.param(w, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.block(b.ret(b.call(target, b.v(w)))) });
  const entryDecl = b.fn({ symbol: entry, params: [b.param(n, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.ret(b.call(wrapper, b.v(n))),
    purity: options.effectfulEntry ? 'effectful' : 'pure' });
  const source = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(),
    members: [targetDecl, wrapperDecl, entryDecl] }) as Module;
  const { candidate, descriptor } = buildVirtualForwardCandidate(source, wrapper, target);
  const keys = generateKeyPairSync('ed25519');
  const store = new DurableGraphStore({ directory: join(directory, 'ast') });
  store.intern(source, { leaseId: 'draft' }); store.intern(candidate, { leaseId: 'draft' });
  const lineage = new CausalLineageLedger({ directory: join(directory, 'lineage'),
    repositoryId: 'process-virtual-artifact', store,
    authority: () => ({ policyEpoch: '0', eligibleAuthors: ['author'] }),
    authorKey: () => keys.publicKey });
  const revision = lineage.publishSpec(signSpecRevision({ repositoryId: 'process-virtual-artifact',
    id: 'behavior', revision: 1, previous: null, parents: [],
    text: 'Preserve the pure entry result.', requirements: [],
    author: 'author', policyEpoch: '0', nonce: 'spec' }, keys.privateKey));
  const specs = [{ id: 'behavior', revision }];
  const specification = lineage.specification([], specs);
  const d = (value: string) => domainDigest('aether.process-virtual-artifact-test/1', value);
  const base = { specification, semanticsVersion: 'aether-reference/1',
    compilerDigest: d('compiler'), capabilityPolicyDigest: d('pure-policy'),
    registry: new CapabilityRegistry() };
  const sourceContext: EvidenceContext = { ...base, module: source,
    target: { abiVersion: 'resumable/1', profileDigest: RESUMABLE_PROFILE_DIGEST,
      artifactDigest: d('source-executable') }, policy: DEFAULT_EVIDENCE_POLICY_V2 };
  const candidateContext: EvidenceContext = { ...base, module: candidate,
    target: { abiVersion: 'resumable/1', profileDigest: virtualForwardResumableProfileDigest(descriptor),
      artifactDigest: subject.digest }, policy: DEFAULT_EVIDENCE_POLICY_V3,
    virtualForward: { source, descriptor } };
  const sourceEvidence = mintLocalEvidence(sourceContext), candidateEvidence = mintLocalEvidence(candidateContext);
  const admit = (context: EvidenceContext, evidence: typeof sourceEvidence,
    parents: readonly string[], nonce: string) => {
    const manifest = createEvidenceManifest(context);
    const intent = lineage.recordIntent(signIntent({ repositoryId: 'process-virtual-artifact',
      subject: manifest.astRoot as NodeRef, executionManifest: executionManifestDigest(manifest),
      evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', evidence),
      parents, specifications: specs, purpose: parents.length ? 'rewrite' : 'genesis',
      text: 'Preserve the signed behavior.', author: 'author', policyEpoch: '0', nonce }, keys.privateKey));
    lineage.admitArtifact(intent, evidence, context);
    return intent;
  };
  const sourceIntent = admit(sourceContext, sourceEvidence, [], 'source');
  const candidateIntent = admit(candidateContext, candidateEvidence,
    options.unrelatedCandidate ? [] : [sourceIntent], 'candidate');
  const input = { sourceContext, candidateContext, sourceEvidence, candidateEvidence,
    bundlePath, sourcePaths: [sourcePath], sourceIntent, candidateIntent, lineage };
  const artifact = options.unrelatedCandidate || options.effectfulEntry ? null
    : makeProcessVirtualArtifactV3(input);
  return { directory, bundlePath, sourcePath, source, candidate, descriptor, wrapper,
    lineage, artifact, input };
}

test('Artifact/3 reloads exact source, candidate, wrapper, V3 evidence and measured bytes', () => {
  const f = fixture();
  try {
    const artifact = f.artifact!;
    const bytes = encodeProcessVirtualArtifactV3(artifact);
    assert.deepEqual(decodeProcessVirtualArtifactV3(bytes, f.lineage), artifact);
    assert.equal(artifact.candidateEvidence.envelope.checker.version, '3');
    assert.equal(artifact.candidateEvidence.manifest.target.artifactDigest,
      artifact.executableSubject.digest);
    assert.deepEqual(artifact.candidateEvidence.manifest.dependencies
      .filter(item => item.symbol === f.wrapper).map(item => item.declaration),
      [f.descriptor.wrapperDeclaration]);
    assert.throws(() => processMigrationPlan({} as never,
      processVirtualArtifactDigestV3(artifact)), /versioned process artifact/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/3 rejects altered source, candidate, descriptor, wrapper, profile and executable bytes', () => {
  const f = fixture();
  try {
    const artifact = f.artifact!;
    const mutate = (patch: object) => validateProcessVirtualArtifactV3({ ...artifact, ...patch }, f.lineage);
    assert.throws(() => mutate({ sourceIr: artifact.candidateIr }), /root|descriptor|wrapper/);
    assert.throws(() => mutate({ candidateIr: artifact.sourceIr }), /root|descriptor/);
    assert.throws(() => mutate({ descriptor: { ...artifact.descriptor, sites: [] } }), /descriptor/);
    assert.throws(() => mutate({ archivedWrapper: { ...artifact.archivedWrapper,
      symbol: f.descriptor.target } }), /wrapper symbol/);
    assert.throws(() => mutate({ candidateEvidence: { ...artifact.candidateEvidence,
      manifest: { ...artifact.candidateEvidence.manifest,
        target: { ...artifact.candidateEvidence.manifest.target, profileDigest: RESUMABLE_PROFILE_DIGEST } } } }), /profile|evidence/);
    assert.throws(() => mutate({ executableSubject: { ...artifact.executableSubject,
      bundle: { ...artifact.executableSubject.bundle, sha256: '0'.repeat(64) } } }), /measured executable/);
    assert.throws(() => mutate({ executableSubject: { ...artifact.executableSubject,
      node: { ...artifact.executableSubject.node, sha256: '0'.repeat(64) } } }), /measured executable/);
    assert.throws(() => mutate({ lineageBinding: { ...artifact.lineageBinding,
      sourceIntent: artifact.lineageBinding.candidateIntent } }), /signed source parent/);
    writeFileSync(f.sourcePath, 'export const worker: number = 2;\n');
    assert.throws(() => validateProcessVirtualArtifactV3(artifact, f.lineage), /measured executable/);
    writeFileSync(f.sourcePath, 'export const worker: number = 1;\n');
    writeFileSync(f.bundlePath, 'export const worker = 2;\n');
    assert.throws(() => validateProcessVirtualArtifactV3(artifact, f.lineage), /measured executable/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/3 rejects unrelated signed lineage and forged admission authority', () => {
  const unrelated = fixture({ unrelatedCandidate: true });
  try {
    assert.throws(() => makeProcessVirtualArtifactV3(unrelated.input), /signed source parent/);
  } finally { rmSync(unrelated.directory, { recursive: true, force: true }); }
  const f = fixture();
  try {
    const forged = { assertCurrent() {}, assertNodeCurrent() {}, lineage() { return []; } };
    assert.throws(() => validateProcessVirtualArtifactV3(f.artifact, forged as never), /real signed lineage/);
    Object.assign(f.lineage, { assertCurrent() {}, assertNodeCurrent() {}, lineage() { return []; } });
    assert.deepEqual(validateProcessVirtualArtifactV3(f.artifact, f.lineage), f.artifact);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/3 rejects effectful subjects, malformed IR and legacy version substitution', () => {
  const effectful = fixture({ effectfulEntry: true });
  try {
    assert.throws(() => makeProcessVirtualArtifactV3(effectful.input), /pure declarations/);
  } finally { rmSync(effectful.directory, { recursive: true, force: true }); }
  const f = fixture();
  try {
    const changed = structuredClone(f.artifact!);
    const dynamic = { ...f.candidate,
      members: [...f.candidate.members, b.import_(f.descriptor.sourceRoot)] } as Module;
    assert.throws(() => validateProcessVirtualArtifactV3({ ...changed,
      candidateIr: encodeIR(dynamic).text }, f.lineage), /AST root/);
    assert.throws(() => validateProcessVirtualArtifactV3({ ...changed,
      candidateIr: changed.candidateIr.replace('AE1', 'AE0') }, f.lineage), /AE1/);
    assert.throws(() => validateProcessVirtualArtifactV3({ ...changed,
      format: 'aether.process-artifact/2' }, f.lineage), /version/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
