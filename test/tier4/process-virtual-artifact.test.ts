import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessChannel } from '../../src/tier4/process-channel.ts';
import { type ProcessVirtualWorkerTrustV1 } from '../../src/tier4/process-virtual-worker-contract.ts';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import type { NodeRef } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { encode as encodeIR } from '../../src/tier1/agent-ir.ts';
import { CausalLineageLedger, signIntent, signSpecRevision } from '../../src/tier1/causal-lineage.ts';
import { buildVirtualForwardCandidate } from '../../src/tier1/semantic-gc-virtual-forward.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';
import { createEvidenceManifest, DEFAULT_EVIDENCE_POLICY_V2, DEFAULT_EVIDENCE_POLICY_V3,
  mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { RESUMABLE_PROFILE_DIGEST, virtualForwardResumableProfileDigest } from '../../src/tier3/resumable-program.ts';
import { decodeProcessVirtualArtifactV3, encodeProcessVirtualArtifactV3,
  makeProcessVirtualArtifactV3, measureExecutableSubjectV1,
  processVirtualArtifactDigestV3, validateProcessVirtualArtifactV3 } from '../../src/tier4/process-virtual-artifact.ts';
import { processMigrationPlan } from '../../src/tier4/process-deployment.ts';
import { verifyWorkerBundle } from '../../scripts/process-worker-bundle.ts';

type Module = Extract<Term, { kind: 'Module' }>;

function fixture(options: { unrelatedCandidate?: boolean; effectfulEntry?: boolean; realWorker?: boolean;
  bundledWorker?: { bundlePath: string; sourcePaths: readonly string[] } } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-artifact-v3-'));
  const bundlePath = join(directory, 'worker.mjs'), sourcePath = join(directory, 'worker.ts');
  writeFileSync(bundlePath, 'export const worker = 1;\n');
  writeFileSync(sourcePath, 'export const worker: number = 1;\n');
  const workerPaths = options.bundledWorker ?? (options.realWorker
    ? { bundlePath: fileURLToPath(new URL('../../src/tier4/process-worker.ts', import.meta.url)),
      sourcePaths: [join(process.cwd(), 'package.json')] }
    : { bundlePath, sourcePaths: [sourcePath] });
  const subject = measureExecutableSubjectV1(workerPaths.bundlePath, workerPaths.sourcePaths);
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
    bundlePath: workerPaths.bundlePath, sourcePaths: workerPaths.sourcePaths,
    sourceIntent, candidateIntent, lineage };
  const artifact = options.unrelatedCandidate || options.effectfulEntry ? null
    : makeProcessVirtualArtifactV3(input);
  const trust: ProcessVirtualWorkerTrustV1 = {
    format: 'aether.process-virtual-worker-trust/1', repositoryId: 'process-virtual-artifact',
    lineageDirectory: join(directory, 'lineage'), storeDirectory: join(directory, 'ast'),
    policyEpoch: '0', eligibleAuthors: ['author'],
    authorKeys: [{ author: 'author', policyEpoch: '0',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  };
  return { directory, bundlePath, sourcePath, source, candidate, descriptor, wrapper,
    entry, target, lineage, trust, artifact, input };
}

test('Artifact/3 init/2 executes source and candidate in separate real workers', async () => {
  const f = fixture({ realWorker: true });
  let source: ProcessChannel | undefined, candidate: ProcessChannel | undefined;
  try {
    const manifest = f.artifact!.sourceEvidence.manifest;
    source = await ProcessChannel.start({ module: f.source, manifest,
      unit: 'pure', includeSymbols: [f.entry, f.wrapper, f.target], capabilities: [],
      heapId: 'pure-heap', ownershipEpoch: '1' });
    candidate = await ProcessChannel.startVirtual({ artifact: f.artifact!, trust: f.trust,
      unit: 'pure', heapId: 'pure-heap', ownershipEpoch: '1' });
    assert.notEqual(candidate.pid, source.pid);
    assert.notEqual(candidate.pid, process.pid);
    const beforeSource = await source.snapshot(), beforeCandidate = await candidate.snapshot();
    const original = await source.call(f.entry, [3n], beforeSource);
    const rewritten = await candidate.call(f.entry, [3n], beforeCandidate);
    assert.deepEqual(original.execution, rewritten.execution);
    assert.deepEqual(rewritten.execution, { ok: true, value: 4n, steps: 0 });
    await candidate.kill();
    candidate = await ProcessChannel.startVirtual({ artifact: f.artifact!, trust: f.trust,
      unit: 'pure', heapId: 'pure-heap', ownershipEpoch: '1' });
    const reopened = await candidate.call(f.entry, [3n], await candidate.snapshot());
    assert.deepEqual(reopened.execution, original.execution);
  } finally {
    await candidate?.close(); await source?.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Artifact/3 launches the rebuilt closed worker bundle with its measured input set', async () => {
  const manifest = await verifyWorkerBundle();
  const f = fixture({ bundledWorker: { bundlePath: manifest.bundle.path,
    sourcePaths: manifest.inputs.map(item => item.path) } });
  let worker: ProcessChannel | undefined;
  try {
    assert.equal(f.artifact!.executableSubject.bundle.sha256, manifest.bundle.sha256);
    assert.deepEqual(f.artifact!.executableSubject.sources.map(item => item.path),
      manifest.inputs.map(item => item.path));
    worker = await ProcessChannel.startVirtual({ artifact: f.artifact!, trust: f.trust,
      unit: 'pure', heapId: 'bundled-heap', ownershipEpoch: '1' });
    assert.notEqual(worker.pid, process.pid);
    const result = await worker.call(f.entry, [3n], await worker.snapshot());
    assert.deepEqual(result.execution, { ok: true, value: 4n, steps: 0 });
    await worker.kill();
    worker = await ProcessChannel.startVirtual({ artifact: f.artifact!, trust: f.trust,
      unit: 'pure', heapId: 'bundled-heap', ownershipEpoch: '1' });
    assert.deepEqual((await worker.call(f.entry, [3n], await worker.snapshot())).execution,
      result.execution);
  } finally { await worker?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/3 virtual worker preserves source production guard denial order', async () => {
  const f = fixture({ realWorker: true });
  try {
    for (const budget of [0, 1, 2, 3]) {
      let checked = 0;
      const source = ProductionRuntime.compile(f.source, { registry: new CapabilityRegistry(),
        policy: 'enforce', executionGuard: () => checked++ < budget });
      const expected = source.call(f.entry, [3n]);
      const worker = await ProcessChannel.startVirtual({ artifact: f.artifact!, trust: f.trust,
        unit: 'pure', heapId: `guard-heap-${budget}`, ownershipEpoch: '1', maxGuardChecks: budget });
      try {
        const observed = await worker.call(f.entry, [3n], await worker.snapshot());
        if (budget === 3) assert.deepEqual(observed.execution, expected);
        else assert.deepEqual(JSON.parse(JSON.stringify(observed.execution)), expected);
        assert.equal(checked, budget < 3 ? budget + 1 : 3);
        assert.equal(observed.execution.ok, budget === 3);
        if (!observed.execution.ok) assert.equal(observed.execution.fault.kind, 'step_budget');
      } finally { await worker.close(); }
    }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/3 worker denies altered roots, descriptor and executable bytes before dispatch', async () => {
  const f = fixture({ realWorker: true });
  let worker: ProcessChannel | undefined;
  const init = { artifact: f.artifact!, trust: f.trust,
    unit: 'pure', heapId: 'pure-heap', ownershipEpoch: '1' };
  try {
    await assert.rejects(ProcessChannel.startVirtual({ ...init,
      artifact: { ...init.artifact, sourceIr: init.artifact.candidateIr } }), /root|descriptor|wrapper/);
    await assert.rejects(ProcessChannel.startVirtual({ ...init,
      artifact: { ...init.artifact, candidateIr: init.artifact.sourceIr } }), /root|descriptor/);
    await assert.rejects(ProcessChannel.startVirtual({ ...init,
      artifact: { ...init.artifact, descriptor: { ...init.artifact.descriptor, sites: [] } } }), /descriptor/);
    await assert.rejects(ProcessChannel.startVirtual({ ...init,
      artifact: { ...init.artifact, executableSubject: { ...init.artifact.executableSubject,
        bundle: { ...init.artifact.executableSubject.bundle, sha256: '0'.repeat(64) } } } }), /measured executable/);
    worker = await ProcessChannel.startVirtual(init);
    const snapshot = await worker.snapshot();
    const packagePath = join(process.cwd(), 'package.json');
    const original = readFileSync(packagePath);
    try {
      writeFileSync(packagePath, Buffer.concat([original, Buffer.from('\n')]));
      await assert.rejects(worker.call(f.entry, [3n], snapshot), /measured executable/);
      const raw = worker as unknown as { request(method: string, payload: unknown): Promise<unknown> };
      await assert.rejects(raw.request('call', { symbol: f.entry,
        args: [{ tag: 'int', value: '3' }], snapshot, operationId: 'tamper-child' }),
      /measured executable/);
    } finally { writeFileSync(packagePath, original); }
    const recovered = await worker.call(f.entry, [3n], snapshot);
    assert.deepEqual(recovered.execution, { ok: true, value: 4n, steps: 0 });
  } finally {
    await worker?.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Artifact/3 worker refuses trust accessors and proxies before reading them', async () => {
  const f = fixture();
  try {
    let touched = 0;
    const trust = { ...f.trust };
    Object.defineProperty(trust, 'repositoryId', { enumerable: true,
      get() { touched++; return f.trust.repositoryId; } });
    const init = { artifact: f.artifact!, unit: 'pure', heapId: 'trust-heap', ownershipEpoch: '1' };
    await assert.rejects(ProcessChannel.startVirtual({ ...init, trust }), /accessor/);
    assert.equal(touched, 0);
    await assert.rejects(ProcessChannel.startVirtual({ ...init,
      trust: new Proxy(f.trust, {}) }), /proxy/);
    const changing = { ...init, trust: f.trust };
    Object.defineProperty(changing, 'heapId', { enumerable: true,
      get() { touched++; return 'changed-heap'; } });
    await assert.rejects(ProcessChannel.startVirtual(changing), /accessor/);
    assert.equal(touched, 0);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/3 init/2 independently rejects tampered child payload before a worker call', async () => {
  const f = fixture({ realWorker: true });
  const WorkerConstructor = ProcessChannel as unknown as {
    new (init: unknown, options: unknown, workerPath: string): ProcessChannel;
  };
  const variants = [
    { ...f.artifact!, sourceIr: f.artifact!.candidateIr },
    { ...f.artifact!, descriptor: { ...f.artifact!.descriptor, sites: [] } },
    { ...f.artifact!, executableSubject: { ...f.artifact!.executableSubject,
      bundle: { ...f.artifact!.executableSubject.bundle, sha256: '0'.repeat(64) } } },
  ];
  try {
    for (const artifact of variants) {
      const channel = new WorkerConstructor({ module: f.candidate,
        manifest: f.artifact!.candidateEvidence.manifest, unit: 'pure', includeSymbols: [f.entry, f.target],
        capabilities: [], heapId: 'raw-heap', ownershipEpoch: '1' }, {},
      f.artifact!.executableSubject.bundle.path);
      const raw = channel as unknown as { request(method: string, payload: unknown): Promise<unknown> };
      try {
        await assert.rejects(raw.request('init-virtual', {
          format: 'aether.process-worker-init/2', artifact, trust: f.trust,
          unit: 'pure', heapId: 'raw-heap', ownershipEpoch: '1',
          snapshot: null, maxGuardChecks: null,
        }), /root|descriptor|measured executable/);
        await assert.rejects(raw.request('call', null), /not initialized/);
      } finally { await channel.kill(); }
    }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

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
