import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { ProcessAuthenticator } from '../../src/tier4/process-values.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { createHostJournalWitness, readHostJournalHead, selectHostJournalWitness } from '../../src/fabric/host-journal-witness.ts';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import type { NodeRef } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { encode as encodeIR } from '../../src/tier1/agent-ir.ts';
import { CausalLineageLedger, signIntent, signSpecRevision } from '../../src/tier1/causal-lineage.ts';
import { buildVirtualForwardCandidate } from '../../src/tier1/semantic-gc-virtual-forward.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { createEvidenceManifest, DEFAULT_EVIDENCE_POLICY_V2, DEFAULT_EVIDENCE_POLICY_V3,
  mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { RESUMABLE_PROFILE_DIGEST, virtualForwardResumableProfileDigest } from '../../src/tier3/resumable-program.ts';
import { decodeProcessVirtualArtifactV4, encodeProcessVirtualArtifactV4,
  makeProcessVirtualArtifactV4, measureWorkerBundleSubjectV2,
  processVirtualArtifactDigestV4, validateProcessVirtualArtifactV4,
  assertProcessVirtualArtifactV4Launch,
  type ProcessWorkerBundleManifestV2 } from '../../src/tier4/process-virtual-artifact-v4.ts';
import { verifyWorkerBundle } from '../../scripts/process-worker-bundle.ts';
import { ProcessChannel, type ProcessChannelOptions } from '../../src/tier4/process-channel.ts';
import { prepareProcessWorkerLaunchV1 } from '../../src/tier4/process-worker-launch-custody.ts';
import { ProcessHost, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
import { type ProcessVirtualWorkerTrustV1 } from '../../src/tier4/process-virtual-worker-contract.ts';

type Module = Extract<Term, { kind: 'Module' }>;

function fixture(manifest: Awaited<ReturnType<typeof verifyWorkerBundle>>,
  options: { unrelatedCandidate?: boolean; effectfulEntry?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-artifact-v4-'));
  const subject = measureWorkerBundleSubjectV2(manifest);
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
    bundleManifest: manifest as ProcessWorkerBundleManifestV2,
    sourceIntent, candidateIntent, lineage };
  const artifact = options.unrelatedCandidate || options.effectfulEntry ? null
    : makeProcessVirtualArtifactV4(input);
  const trust: ProcessVirtualWorkerTrustV1 = {
    format: 'aether.process-virtual-worker-trust/1', repositoryId: 'process-virtual-artifact',
    lineageDirectory: join(directory, 'lineage'), storeDirectory: join(directory, 'ast'),
    policyEpoch: '0', eligibleAuthors: ['author'],
    authorKeys: [{ author: 'author', policyEpoch: '0',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  };
  return { directory, source, candidate, descriptor, wrapper,
    entry, target, lineage, artifact, trust, input, keys, revision };
}


function frame(bytes: Uint8Array): Buffer {
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}
function responseFrame(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('Artifact/4 launch probe timed out')), 5000);
    const onData = (bytes: Buffer) => {
      pending = Buffer.concat([pending, bytes]);
      if (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0))
        finish(null, pending.subarray(4, 4 + pending.readUInt32BE(0)));
    };
    const onEnd = () => finish(new Error('worker exited before probe response'));
    function finish(error: Error | null, value?: Buffer) {
      clearTimeout(timer); stream.off('data', onData); stream.off('end', onEnd);
      if (error) reject(error); else resolve(value!);
    }
    stream.on('data', onData); stream.on('end', onEnd);
  });
}

const manifest = await verifyWorkerBundle();
function hostOptions(f: ReturnType<typeof fixture>): ProcessHostOptions {
  const candidate = f.artifact!;
  const plan: TopologyPlan = { shape: 'containers', units: [
    { id: 'pure', members: [f.entry, f.target], capabilities: [],
      placement: 'container', memoryMb: 16 }], crossEdges: [],
    transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  return { directory: join(f.directory, 'host'), module: f.candidate,
    manifest: candidate.candidateEvidence.manifest, plan,
    registry: new CapabilityRegistry(), sealer: new CapabilitySealer(new Uint8Array(32).fill(7), () => 100),
    virtualArtifactV4: { format: 'aether.process-host-virtual/1',
      artifact: candidate, trust: f.trust }, authorizeRecovery: () => true };
}

async function launchHostWitness(configFile: string): Promise<ChildProcess> {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const child = spawn(process.execPath, ['--experimental-strip-types',
    join(root, 'src/fabric/witness-service-cli.ts'), '--config', configFile],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
  await new Promise<void>((resolveReady, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error(`host witness startup timeout: ${errors}`)), 10_000);
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      if (output.includes('witness service ready')) { clearTimeout(timer); resolveReady(); }
    });
    child.stderr!.on('data', chunk => { errors += String(chunk).slice(0, 2048); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`host witness exited ${code}: ${errors}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return child;
}
async function killHostWitness(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL'); await exited;
}

test('Artifact/4 signed target binds independently rebuilt V2 bundle and exact virtual proof', () => {
  const f = fixture(manifest);
  try {
    const artifact = f.artifact!;
    assert.equal(artifact.executableSubject.manifest.format, 'aether.process-worker-bundle/2');
    assert.equal(manifest.nativeRuntime.format,
      'aether.macos-node-static-link-closure/1');
    assert.ok(artifact.executableSubject.manifest.inputs.length > 0);
    assert.equal(artifact.candidateEvidence.manifest.target.artifactDigest,
      artifact.executableSubject.digest);
    assert.ok(!artifact.executableSubject.manifest.inputs.some(item =>
      item.path.endsWith('process-virtual-artifact-v4.ts')));
    assert.ok(artifact.executableSubject.manifest.inputs.some(item =>
      item.path.endsWith('process-virtual-artifact-v4-core.ts')));
    assert.deepEqual(decodeProcessVirtualArtifactV4(encodeProcessVirtualArtifactV4(artifact),
      f.lineage), artifact);
    assert.equal(artifact.candidateEvidence.envelope.checker.version, '3');
    assert.notEqual(processVirtualArtifactDigestV4(artifact), artifact.executableSubject.digest);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 rejects omitted input, changed tool, native library, Node and bundle identity', () => {
  const f = fixture(manifest);
  try {
    const artifact = f.artifact!;
    const subject = artifact.executableSubject;
    const alter = (value: unknown) => validateProcessVirtualArtifactV4({ ...artifact,
      executableSubject: { ...subject, manifest: value } }, f.lineage);
    assert.throws(() => alter({ ...manifest, inputs: manifest.inputs.slice(1) }),
      /bundle rebuild|manifest|closure/);
    assert.throws(() => alter({ ...manifest, tool: { ...manifest.tool,
      binary: { ...manifest.tool.binary, sha256: '0'.repeat(64) } } }),
      /bytes changed|bundle rebuild|closure/);
    const native = manifest.nativeRuntime;
    if (native.format !== 'aether.macos-node-static-link-closure/1')
      throw new Error('Darwin native closure expected');
    assert.throws(() => alter({ ...manifest, nativeRuntime: { ...native,
      libraries: [{ ...native.libraries[0], sha256: '0'.repeat(64) }, ...native.libraries.slice(1)] } }),
      /native bytes changed|bundle rebuild/);
    assert.throws(() => alter({ ...manifest, node: { ...manifest.node,
      sha256: '0'.repeat(64) } }), /bytes changed|bundle rebuild/);
    assert.throws(() => alter({ ...manifest, bundle: { ...manifest.bundle,
      sha256: '0'.repeat(64) } }), /bytes changed|bundle rebuild/);
    assert.throws(() => validateProcessVirtualArtifactV4({ ...artifact,
      executableSubject: { ...subject, digest: artifact.candidateEvidence.manifest.target.profileDigest } },
      f.lineage), /subject changed|evidence/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 remeasures actual current input and build-recipe bytes on decode', () => {
  const f = fixture(manifest);
  try {
    const bytes = encodeProcessVirtualArtifactV4(f.artifact!);
    const input = manifest.inputs[0].path;
    const originalInput = readFileSync(input);
    try {
      writeFileSync(input, Buffer.concat([originalInput, Buffer.from('\n')]));
      assert.throws(() => decodeProcessVirtualArtifactV4(bytes, f.lineage),
        /measured bundle\/input\/native bytes changed/);
    } finally { writeFileSync(input, originalInput); }
    const recipe = manifest.tool.recipe.path;
    const originalRecipe = readFileSync(recipe);
    try {
      writeFileSync(recipe, Buffer.concat([originalRecipe, Buffer.from('\n')]));
      assert.throws(() => decodeProcessVirtualArtifactV4(bytes, f.lineage),
        /bytes changed|bundle rebuild failed/);
    } finally { writeFileSync(recipe, originalRecipe); }
    assert.deepEqual(decodeProcessVirtualArtifactV4(bytes, f.lineage), f.artifact);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 rejects swapped descriptor, evidence and forged direct ancestry', () => {
  const f = fixture(manifest);
  try {
    const artifact = f.artifact!;
    assert.throws(() => validateProcessVirtualArtifactV4({ ...artifact,
      descriptor: { ...artifact.descriptor, sites: [] } }, f.lineage), /descriptor/);
    assert.throws(() => validateProcessVirtualArtifactV4({ ...artifact,
      archivedWrapper: { ...artifact.archivedWrapper, symbol: f.target } }, f.lineage), /wrapper symbol/);
    assert.throws(() => validateProcessVirtualArtifactV4({ ...artifact,
      candidateEvidence: artifact.sourceEvidence }, f.lineage), /root|evidence/);
    assert.throws(() => validateProcessVirtualArtifactV4({ ...artifact,
      lineageBinding: { ...artifact.lineageBinding,
        sourceIntent: artifact.lineageBinding.candidateIntent } }, f.lineage), /signed source parent/);
    assert.throws(() => validateProcessVirtualArtifactV4({ ...artifact,
      candidateIr: encodeIR(f.source).text }, f.lineage), /AST root/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
  const unrelated = fixture(manifest, { unrelatedCandidate: true });
  try { assert.throws(() => makeProcessVirtualArtifactV4(unrelated.input), /signed source parent/); }
  finally { rmSync(unrelated.directory, { recursive: true, force: true }); }
  const effectful = fixture(manifest, { effectfulEntry: true });
  try { assert.throws(() => makeProcessVirtualArtifactV4(effectful.input), /pure declarations/); }
  finally { rmSync(effectful.directory, { recursive: true, force: true }); }
});

test('Artifact/4 bounded launch check starts only its measured worker bundle', async () => {
  const f = fixture(manifest);
  const artifact = f.artifact!;
  try {
    assert.throws(() => assertProcessVirtualArtifactV4Launch(artifact, f.lineage,
      process.execPath), /selected worker entry/);
    assertProcessVirtualArtifactV4Launch(artifact, f.lineage, manifest.bundle.path);
    const key = Buffer.alloc(32, 13);
    const session = { sessionId: 'artifact4-probe',
      executionManifest: domainDigest('aether.execution/1', 'artifact4-probe'),
      ownershipEpoch: '1', maxFrameBytes: 65536 };
    const parent = new ProcessAuthenticator(key, session, 'parent');
    const child = spawn(process.execPath, [artifact.executableSubject.manifest.bundle.path],
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
    try {
      assert.ok(child.pid && child.pid !== process.pid);
      const bootstrap = encodeCanonical({ key: key.toString('base64'), session });
      (child.stdio[3] as Writable).write(frame(bootstrap));
      const reply = responseFrame(child.stdout!);
      child.stdin!.write(parent.encode({ kind: 'request', id: 'probe',
        method: 'snapshot', payload: null }));
      const body = parent.decode(await reply) as { kind: string; id: string;
        ok: boolean; value: string };
      assert.deepEqual({ ...body }, { kind: 'response', id: 'probe', ok: false,
        value: 'worker is not initialized' });
      child.stdin!.end();
    } finally { child.kill(); }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 init/3 executes the signed pure candidate and restores its real-worker snapshot', async () => {
  const f = fixture(manifest);
  let worker: ProcessChannel | undefined;
  try {
    const init = { artifact: f.artifact!, trust: f.trust,
      unit: 'pure', heapId: 'artifact4-heap', ownershipEpoch: '1' };
    worker = await ProcessChannel.startVirtualV4(init);
    assert.ok(worker.pid !== process.pid);
    const first = await worker.call(f.entry, [3n], await worker.snapshot());
    assert.deepEqual(first.execution, { ok: true, value: 4n, steps: 0 });
    const oldPid = worker.pid;
    await worker.kill();
    worker = await ProcessChannel.startVirtualV4({ ...init, snapshot: first.snapshot });
    assert.notEqual(worker.pid, oldPid);
    assert.deepEqual((await worker.call(f.entry, [3n], await worker.snapshot())).execution,
      first.execution);
  } finally { await worker?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 pure worker cannot gain callbacks through later caller option mutation', async () => {
  const f = fixture(manifest);
  const options: ProcessChannelOptions = {};
  let dispatched = 0;
  let worker: ProcessChannel | undefined;
  try {
    worker = await ProcessChannel.startVirtualV4({ artifact: f.artifact!, trust: f.trust,
      unit: 'pure', heapId: 'artifact4-options-heap', ownershipEpoch: '1' }, options);
    Object.assign(options, {
      onCall: () => { dispatched++; throw new Error('late call handler ran'); },
      onEffect: () => { dispatched++; throw new Error('late effect handler ran'); },
    });
    const internal = worker as unknown as { options: ProcessChannelOptions;
      callback(id: string, method: 'call' | 'effect', value: unknown): Promise<void>;
      send(value: unknown): void };
    assert.notEqual(internal.options, options);
    assert.equal(internal.options.onCall, undefined);
    assert.equal(internal.options.onEffect, undefined);
    const snapshot = await worker.snapshot();
    const replies: unknown[] = [];
    const originalSend = internal.send;
    internal.send = value => { replies.push(value); };
    try {
      await internal.callback('late-call', 'call', { symbol: f.target, from: f.entry,
        args: [], snapshot, operationId: 'late-call' });
      await internal.callback('late-effect', 'effect', { capability: 'cap:probe:effect',
        from: f.entry, args: [], snapshot, operationId: 'late-effect', effectIndex: 0 });
    } finally { internal.send = originalSend; }
    assert.equal(dispatched, 0);
    assert.deepEqual(replies.map(reply => (reply as { ok: boolean }).ok), [false, false]);
    assert.deepEqual((await worker.call(f.entry, [3n], snapshot)).execution,
      { ok: true, value: 4n, steps: 0 });
  } finally { await worker?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 init/3 refuses tampered proof, authority, and packaged bytes before execution', async () => {
  const f = fixture(manifest);
  let worker: ProcessChannel | undefined;
  const init = { artifact: f.artifact!, trust: f.trust,
    unit: 'pure', heapId: 'artifact4-tamper', ownershipEpoch: '1' };
  try {
    await assert.rejects(ProcessChannel.startVirtualV4({ ...init,
      artifact: { ...init.artifact, candidateIr: init.artifact.sourceIr } }), /root|descriptor/);
    await assert.rejects(ProcessChannel.startVirtualV4({ ...init,
      artifact: { ...init.artifact, descriptor: { ...init.artifact.descriptor, sites: [] } } }),
    /descriptor/);
    await assert.rejects(ProcessChannel.startVirtualV4({ ...init,
      artifact: { ...init.artifact, executableSubject: { ...init.artifact.executableSubject,
        digest: init.artifact.sourceEvidence.manifest.target.artifactDigest } } }),
    /subject changed|evidence/);
    const otherKeys = generateKeyPairSync('ed25519');
    await assert.rejects(ProcessChannel.startVirtualV4({ ...init,
      trust: { ...init.trust, authorKeys: [{ author: 'author', policyEpoch: '0',
        publicKeyPem: otherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } }),
    /signature|author|lineage|invalid/i);
    await assert.rejects(ProcessChannel.startVirtualV4(init, { onEffect: () => {
      throw new Error('effect must never be dispatched');
    } }), /does not admit remote calls or effects/);
    worker = await ProcessChannel.startVirtualV4(init);
    const before = await worker.snapshot();
    const bundlePath = manifest.bundle.path;
    const original = readFileSync(bundlePath);
    try {
      writeFileSync(bundlePath, Buffer.concat([original, Buffer.from('\n')]));
      await assert.rejects(worker.call(f.entry, [3n], before), /measured|bundle|bytes/);
      const raw = worker as unknown as { request(method: string, payload: unknown): Promise<unknown> };
      await assert.rejects(raw.request('call', { symbol: f.entry,
        args: [{ tag: 'int', value: '3' }], snapshot: before,
        operationId: 'artifact4-child-tamper' }), /measured|bundle|bytes/);
    } finally { writeFileSync(bundlePath, original); }
    assert.deepEqual((await worker.call(f.entry, [3n], before)).execution,
      { ok: true, value: 4n, steps: 0 });
  } finally { await worker?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 packaged child independently rejects altered init/3 proof', async () => {
  const f = fixture(manifest);
  const key = Buffer.alloc(32, 17);
  const session = { sessionId: 'artifact4-child-proof',
    executionManifest: executionManifestDigest(f.artifact!.candidateEvidence.manifest),
    ownershipEpoch: '1', maxFrameBytes: 8 * 1024 * 1024 };
  const parent = new ProcessAuthenticator(key, session, 'parent');
  const child = prepareProcessWorkerLaunchV1(manifest.bundle).spawn({
    env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
  });
  try {
    const bootstrap = encodeCanonical({ key: key.toString('base64'), session });
    (child.stdio[3] as Writable).write(frame(bootstrap));
    const reply = responseFrame(child.stdout!);
    (child.stdio.at(5) as Writable).write(parent.encode({ kind: 'request', id: 'tampered-init',
      method: 'init-virtual', payload: {
        format: 'aether.process-worker-init/3',
        artifact: { ...f.artifact!, descriptor: { ...f.artifact!.descriptor, sites: [] } },
        trust: f.trust, unit: 'pure', heapId: 'raw-proof', ownershipEpoch: '1',
        snapshot: null, maxGuardChecks: null,
      } }));
    const body = parent.decode(await reply) as { kind: string; id: string;
      ok: boolean; value: string };
    assert.equal(body.kind, 'response');
    assert.equal(body.id, 'tampered-init');
    assert.equal(body.ok, false);
    assert.match(body.value, /descriptor/);
  } finally { child.kill(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 ProcessHost config/16 dispatches and reopens exact durable pure state', async () => {
  const f = fixture(manifest);
  const options = hostOptions(f);
  let host: ProcessHost | undefined;
  try {
    await assert.rejects(ProcessHost.open({ ...options,
      directory: join(f.directory, 'legacy-host'), virtualArtifactV4: undefined }),
    /requires explicit Artifact\/4 host profile/);
    host = await ProcessHost.open(options);
    assert.ok(host.workerPids.pure !== process.pid);
    const result = await host.call(f.entry, [{ tag: 'int', value: '3' }],
      { operationId: 'artifact4-host-call', tokens: host.issueTokens(f.entry) });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { state: 'completed', operationId: 'artifact4-host-call',
      generation: '1', unit: 'pure', execution: { ok: true,
        value: { tag: 'int', value: '4' }, steps: 0 } });
    const before = await host.snapshot(), pid = host.workerPids.pure;
    await host.close(); host = undefined;
    await assert.rejects(ProcessHost.open({ ...options, virtualArtifactV4: undefined }),
      /configuration|profile/i);
    host = await ProcessHost.open(options);
    assert.notEqual(host.workerPids.pure, pid);
    assert.deepEqual(JSON.parse(JSON.stringify(await host.snapshot())), JSON.parse(JSON.stringify(before)));
    assert.deepEqual(JSON.parse(JSON.stringify(await host.call(f.entry, [{ tag: 'int', value: '3' }],
      { operationId: 'artifact4-host-call', tokens: host.issueTokens(f.entry) }))),
    JSON.parse(JSON.stringify(result)));
    await assert.rejects(ProcessHost.open({ ...options,
      virtualArtifactV4: { ...options.virtualArtifactV4!, artifact: { ...f.artifact!,
        descriptor: { ...f.artifact!.descriptor, sites: [] } } } }), /descriptor/);
  } finally { await host?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 ProcessHost reconciles a real controller SIGKILL before commit', async () => {
  const f = fixture(manifest);
  const options = hostOptions(f);
  const configPath = join(f.directory, 'controller.json');
  writeFileSync(configPath, JSON.stringify({ directory: options.directory,
    artifact: f.artifact, trust: f.trust, plan: options.plan, entry: f.entry }));
  let host: ProcessHost | undefined;
  try {
    const controller = fileURLToPath(new URL('./process-virtual-host-crash-controller.ts', import.meta.url));
    const result = spawnSync(process.execPath,
      ['--experimental-strip-types', controller, configPath],
      { cwd: process.cwd(), timeout: 30_000, encoding: 'utf8' });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    host = await ProcessHost.open(options);
    assert.ok(host.workerPids.pure !== process.pid);
    assert.equal(host.operationResult('artifact4-controller-crash')?.state, 'indeterminate');
    const recovered = await host.recoverOperation('artifact4-controller-crash',
      { strategy: 'isolated-replay' });
    assert.deepEqual(JSON.parse(JSON.stringify(recovered)), {
      state: 'completed', operationId: 'artifact4-controller-crash', generation: '1',
      unit: 'pure', execution: { ok: true, value: { tag: 'int', value: '4' }, steps: 0 },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await host.call(f.entry, [{ tag: 'int', value: '3' }],
      { operationId: 'artifact4-controller-crash', tokens: host.issueTokens(f.entry) }))),
    JSON.parse(JSON.stringify(recovered)));
  } finally { await host?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('Artifact/4 ProcessHost config/17 witnesses pure calls and recovers controller crashes', async () => {
  const f = fixture(manifest);
  const local = hostOptions(f);
  const namespace = { authorityId: 'artifact4-host-operator',
    repositoryId: f.trust.repositoryId, deploymentId: 'artifact4-pure-deployment' };
  const witnessConfig = { ...namespace, hostId: 'artifact4-pure-host',
    socketPath: join(f.directory, 'witness.sock'), keyPath: join(f.directory, 'witness.key') };
  const configFile = join(f.directory, 'witness.json');
  const key = randomBytes(32);
  writeFileSync(witnessConfig.keyPath, key, { mode: 0o600 });
  writeFileSync(configFile, encodeCanonical({ socketPath: witnessConfig.socketPath,
    storageDir: join(f.directory, 'operator-store'), keyFile: witnessConfig.keyPath,
    namespaces: [{ kind: 'host-scope', ...namespace }] }), { mode: 0o600 });
  const selected = () => selectHostJournalWitness(createProcessWitnessClient({
    socketPath: witnessConfig.socketPath, key }).hostCatalog(namespace), witnessConfig.hostId);
  const options = (): ProcessHostOptions => ({ ...local,
    virtualArtifactV4: { ...local.virtualArtifactV4!, format: 'aether.process-host-virtual/2' },
    hostJournalWitness: selected() });
  let service: ChildProcess | undefined, host: ProcessHost | undefined;
  try {
    service = await launchHostWitness(configFile);
    await assert.rejects(ProcessHost.open({ ...local,
      virtualArtifactV4: { ...local.virtualArtifactV4!, format: 'aether.process-host-virtual/2' } }),
    /witness/);
    await assert.rejects(ProcessHost.open({ ...options(), hostJournalWitness: createHostJournalWitness({
      ...namespace, repositoryId: 'different-signed-repository', hostId: witnessConfig.hostId,
      read: () => ({ revision: '0', journal: null }),
      advance: () => { throw new Error('wrong repository witness must not be written'); },
    }) }), /differs from signed lineage repository/);
    await assert.rejects(ProcessHost.open({ ...options(),
      effectRouterFactory: () => { throw new Error('must not dispatch'); } }),
    /one pure unit without effect/);
    host = await ProcessHost.open(options());
    const call = (id: string) => host!.call(f.entry, [{ tag: 'int', value: '3' }],
      { operationId: id, tokens: host!.issueTokens(f.entry) });
    const first = await call('artifact4-witness-first');
    const oldLocal = readFileSync(join(local.directory, 'host.json'), 'utf8');
    const second = await call('artifact4-witness-second');
    const exactSnapshot = await host.snapshot();
    const head = readHostJournalHead(selected());
    assert.equal(JSON.parse(head.journal!).configuration,
      JSON.parse(readFileSync(join(local.directory, 'host.json'), 'utf8')).configuration);
    assert.deepEqual(JSON.parse(head.journal!).snapshot, JSON.parse(JSON.stringify(exactSnapshot)));
    assert.deepEqual(JSON.parse(head.journal!).calls.map((row: { operationId: string }) => row.operationId),
      ['artifact4-witness-first', 'artifact4-witness-second']);
    const currentLocal = readFileSync(join(local.directory, 'host.json'), 'utf8');
    writeFileSync(join(local.directory, 'host.json'), oldLocal);
    assert.throws(() => host!.operationResult('artifact4-witness-first'), /local host journal diverges/);
    const forged = JSON.parse(currentLocal);
    forged.snapshot.eventCursor = String(BigInt(forged.snapshot.eventCursor) + 1n);
    writeFileSync(join(local.directory, 'host.json'), encodeCanonical(forged));
    assert.throws(() => host!.operationResult('artifact4-witness-first'), /local host journal diverges/);
    writeFileSync(join(local.directory, 'host.json'), currentLocal);
    await killHostWitness(service); service = undefined;
    assert.throws(() => host!.operationResult('artifact4-witness-first'), /witness|uncertain/);
    await assert.rejects(async () => call('artifact4-witness-during-outage'), /witness|uncertain/);
    await host.close(); host = undefined;
    service = await launchHostWitness(configFile);
    rmSync(join(local.directory, 'host.json'));
    host = await ProcessHost.open(options());
    assert.deepEqual(JSON.parse(JSON.stringify(await host.snapshot())), JSON.parse(JSON.stringify(exactSnapshot)));
    assert.deepEqual(await call('artifact4-witness-first'), first);
    assert.deepEqual(await call('artifact4-witness-second'), second);
    await host.close(); host = undefined;

    const controller = fileURLToPath(new URL('./process-virtual-host-crash-controller.ts', import.meta.url));
    const crash = (operationId: string, crashPhase: 'call-before-commit' | 'call-committed') => {
      const controllerConfig = join(f.directory, `${operationId}.json`);
      writeFileSync(controllerConfig, JSON.stringify({ directory: local.directory,
        artifact: f.artifact, trust: f.trust, plan: local.plan, entry: f.entry,
        witness: witnessConfig, operationId, crashPhase }));
      const result = spawnSync(process.execPath,
        ['--experimental-strip-types', controller, controllerConfig],
        { cwd: process.cwd(), timeout: 30_000, encoding: 'utf8' });
      assert.equal(result.signal, 'SIGKILL', result.stderr);
    };
    crash('artifact4-witness-before', 'call-before-commit');
    host = await ProcessHost.open(options());
    assert.equal(host.operationResult('artifact4-witness-before')?.state, 'indeterminate');
    const recovered = await host.recoverOperation('artifact4-witness-before',
      { strategy: 'isolated-replay' });
    assert.equal(recovered.state, 'completed');
    assert.deepEqual(await call('artifact4-witness-before'), recovered);
    await host.close(); host = undefined;
    crash('artifact4-witness-after', 'call-committed');
    host = await ProcessHost.open(options());
    const committed = host.operationResult('artifact4-witness-after');
    assert.equal(committed?.state, 'completed');
    assert.deepEqual(await call('artifact4-witness-after'), committed);
    assert.ok(readHostJournalHead(selected()).journal?.includes('artifact4-witness-after'));
    await host.close(); host = undefined;
    await assert.rejects(ProcessHost.open({ ...local }), /configuration|profile/i);
  } finally {
    await host?.close(); if (service) await killHostWitness(service);
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Artifact/4 ProcessHost refuses effect services and stale signed lineage before call intent', async () => {
  const f = fixture(manifest);
  const options = hostOptions(f);
  let host: ProcessHost | undefined;
  try {
    await assert.rejects(ProcessHost.open({ ...options,
      effectRouterFactory: () => { throw new Error('broker must not be reached'); } }),
    /one pure unit without effect/);
    host = await ProcessHost.open(options);
    const tokens = host.issueTokens(f.entry);
    f.lineage.publishSpec(signSpecRevision({ repositoryId: 'process-virtual-artifact',
      id: 'behavior', revision: 2, previous: f.revision, parents: [],
      text: 'Updated behavior.', requirements: [], author: 'author', policyEpoch: '0',
      nonce: 'revoke-artifact4' }, f.keys.privateKey));
    await assert.rejects(host.call(f.entry, [{ tag: 'int', value: '3' }],
      { operationId: 'revoked-before-intent', tokens }),
    /InvalidatedSpec|stale|current/i);
    const journal = JSON.parse(readFileSync(join(options.directory, 'host.json'), 'utf8'));
    assert.equal(journal.calls.length, 0);
    await host.close(); host = undefined;
    await assert.rejects(ProcessHost.open(options), /InvalidatedSpec|stale|current/i);
  } finally { await host?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
