import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { capability } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { createTrustedClockAnchor } from '../../src/tier2/trusted-clock-anchor.ts';
import { effectResourcePolicyDigestV5, signEffectResourcePolicyV5, type EffectResourcePolicyBodyV5 } from '../../src/tier2/effect-resource-policy.ts';
import { generatePortableCertificate } from '../../src/tier2/portable-proof-producer.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { DurableEffectBroker, effectAdapterDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { createAttestedSinkAdapter, type AttestedSinkClientV1 } from '../../src/fabric/attested-sink-adapter.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { selectEffectJournalWitness } from '../../src/fabric/effect-journal-witness.ts';
import { selectHostJournalWitness } from '../../src/fabric/host-journal-witness.ts';
import { readSinkStateHead, type SinkStateJournalV2 } from '../../src/fabric/sink-state-witness.ts';
import type { SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import type { ConservativeFallbackProofInput } from '../../src/tier3/fallback-proof.ts';
import { ProcessHost, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { ProcessFallbackSupervisor } from '../../src/tier4/process-fallback.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const sourceRoot = resolve(import.meta.dirname, '../..');
async function launch(script: string, config: string, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(sourceRoot, 'src/fabric', script), '--config', config],
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
function signer(path: string, connect: boolean): { privateKey: KeyObject; publicKey: KeyObject } {
  if (connect) {
    const privateKey = createPrivateKey(readFileSync(path));
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  const pair = generateKeyPairSync('ed25519');
  writeFileSync(path, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  return pair;
}

export async function attestedFallbackFixture(directory: string, scenario: 'commit' | 'fence' | 'outage', connect = false) {
  const repositoryId = 'repo:fallback-sink', deploymentId = 'deployment:fallback-sink';
  const clockDomain = 'clock:fallback-sink';
  const symbols = new SymbolSpace('attested-fallback'), tier1 = symbols.define('tier1'),
    tier2 = symbols.define('tier2'), arg = symbols.define('arg');
  const CAP = capability('cap:fallback:signed_sink'), registry = new CapabilityRegistry();
  registry.define({ name: CAP, domain: 'fallback', operation: 'signed_sink', arity: 1,
    description: 'signed fallback test sink', effectful: true });
  const contract = b.contract({ requires: [b.clause(b.ge(b.v(arg), b.int(0)), 'nonnegative')],
    ensures: [b.clause(b.eq(b.result(), b.add(b.old(b.v(arg)), b.int(1))), 'incremented')] });
  const first = b.fn({ symbol: tier1, params: [b.param(arg, b.Int)], returns: b.Int,
    capabilities: [CAP], purity: 'effectful', contract,
    body: scenario === 'commit'
      ? b.block(b.exprStmt(b.invoke(CAP, b.v(arg))), b.ret(b.add(b.v(arg), b.int(1))))
      : b.block(b.exprStmt(b.invoke(CAP, b.v(arg))), b.assert_(b.bool(false), 'tier1-fault'), b.ret(b.int(1))) });
  const second = b.fn({ symbol: tier2, params: [b.param(arg, b.Int)], returns: b.Int,
    capabilities: [], purity: 'pure', contract, body: b.ret(b.add(b.v(arg), b.int(1))) });
  const moduleSymbol = symbols.define('module');
  const module = b.module_({ symbol: moduleSymbol, symbolTable: symbols.table(), members: [first, second] });
  const proofModule = b.module_({ symbol: moduleSymbol, symbolTable: symbols.table(), members: [second] });
  const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [tier1, tier2],
    capabilities: [CAP], placement: 'container', memoryMb: 16 }], crossEdges: [],
    transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sinkSignerFile = join(directory, 'sink.pem'), policySignerFile = join(directory, 'policy.pem');
  const fallbackSignerFile = join(directory, 'fallback.pem');
  const sinkKeys = signer(sinkSignerFile, connect), policyKeys = signer(policySignerFile, connect);
  const fallbackKeys = signer(fallbackSignerFile, connect);
  const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId,
    sinkAuthorityId: 'authority:fallback-sink', sinkId: 'sink:fallback-ledger', keyId: 'key:fallback-sink',
    keyEpoch: '0', publicKey: sinkKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const adapterArtifactDigest = domainDigest('aether.effect-adapter-artifact/2', 'fallback-signed-sink');
  const sinkSocket = join(directory, 'sink.sock'), witnessSocket = join(directory, 'witness.sock');
  const sinkKeyFile = join(directory, 'sink.key'), witnessKeyFile = join(directory, 'witness.key');
  const sinkConfig = join(directory, 'sink.json');
  const witnessConfig = join(directory, 'witness.json');
  const sinkKey = connect ? readFileSync(sinkKeyFile) : randomBytes(32);
  const witnessKey = connect ? readFileSync(witnessKeyFile) : randomBytes(32);
  if (!connect) {
    writeFileSync(sinkKeyFile, sinkKey, { mode: 0o600 });
    writeFileSync(witnessKeyFile, witnessKey, { mode: 0o600 });
    writeFileSync(witnessConfig, encodeCanonical({ socketPath: witnessSocket,
    storageDir: join(directory, 'witness-store'), keyFile: witnessKeyFile, namespaces: [
      { kind: 'sink-scope', authorityId: 'operator:fallback-sink', anchor, adapterArtifactDigest },
      { kind: 'effect-scope', authorityId: 'operator:fallback-effects', repositoryId,
        catalogDeploymentId: deploymentId, clockDomain },
      { kind: 'host-scope', authorityId: 'operator:fallback-host', repositoryId, deploymentId },
    ] }), { mode: 0o600 });
    writeFileSync(sinkConfig, encodeCanonical({ format: 'aether.attested-sink-config/2',
    socketPath: sinkSocket, storageDir: join(directory, 'sink-store'), authKeyFile: sinkKeyFile,
    signingKeyFile: sinkSignerFile, anchor, adapterArtifactDigest,
      witnessSocketPath: witnessSocket, witnessKeyFile, witnessAuthorityId: 'operator:fallback-sink' }), { mode: 0o600 });
  }
  let witness: ChildProcess | null = null, sink: ChildProcess | null = null;
  try {
    if (!connect) {
      witness = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready');
      sink = await launch('attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    }
    const operator = createProcessWitnessClient({ socketPath: witnessSocket, key: witnessKey, timeoutMs: 5000 });
    const sinkStateWitness = operator.sinkStateWitness({ authorityId: 'operator:fallback-sink', anchor, adapterArtifactDigest });
    const catalog = operator.effectCatalog({ authorityId: 'operator:fallback-effects', repositoryId, deploymentId, clockDomain });
    const hostCatalog = operator.hostCatalog({ authorityId: 'operator:fallback-host', repositoryId, deploymentId });
    const hostJournalWitness = selectHostJournalWitness(hostCatalog, 'host:fallback');
    const sinkClient = createAttestedSinkClient({ socketPath: sinkSocket, authKey: sinkKey, anchor,
      adapterArtifactDigest, repositoryId, deploymentId, timeoutMs: 5000 });
    let executeRequest: EffectRequestV1 | null = null, outageInjected = false;
    const client: AttestedSinkClientV1 = { execute: request => {
      executeRequest = request;
      if (scenario === 'fence') {
        const fenced = sinkClient.status(request);
        if (fenced.state !== 'not_committed') throw new Error('signed noncommit fence unavailable');
        throw new Error('effect deliberately fenced before execution');
      }
      if (scenario === 'outage' && !outageInjected) {
        outageInjected = true;
        witness!.kill('SIGKILL');
        throw new Error('witness unavailable before sink dispatch');
      }
      return sinkClient.execute(request);
    }, status: request => sinkClient.status(request) };
    const adapter = createAttestedSinkAdapter({ id: 'adapter:fallback-sink', client,
      repositoryId, deploymentId, approvedAdapterArtifactDigest: adapterArtifactDigest, anchor });
    const policy: EffectResourcePolicyBodyV5 = { format: 'aether.effect-resource-policy/5',
      repositoryId, astRoot: new GraphStore().intern(module), policyEpoch: '0', rules: [{ capability: CAP,
        prefix: ['sink'], argument: null, adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter),
        adapterArtifactDigest, deadline: '1000', clockDomain, deploymentId,
        sinkAnchorDigest: domainDigest('aether.sink-anchor/1', anchor), sinkStateWitnessDigest: sinkStateWitness.digest }] };
    const manifestOptions = { registry, specification: 'Signed fallback with proved pure conservative tier',
      semanticsVersion: 'aether-reference/1', compilerDigest: domainDigest('aether.fallback-sink-test/1', 'compiler'),
      capabilityPolicyDigest: effectResourcePolicyDigestV5(policy),
      target: { abiVersion: 'process/1', profileDigest: domainDigest('aether.fallback-sink-test/1', 'profile'),
        artifactDigest: domainDigest('aether.fallback-sink-test/1', 'artifact') } };
    const manifest = createEvidenceManifest({ ...manifestOptions, module });
    const proofManifest = createEvidenceManifest({ ...manifestOptions, module: proofModule });
    const certificate = generatePortableCertificate(proofModule,
      { manifest: proofManifest, expectedManifest: proofManifest, specification: manifestOptions.specification });
    if (!certificate) throw new Error('no independent portable Tier 2 certificate');
    const conservativeProof: ConservativeFallbackProofInput = { module: proofModule, manifest: proofManifest,
      specification: manifestOptions.specification, certificate };
    const signed = signEffectResourcePolicyV5(policy, 'policy:fallback-sink', policyKeys.privateKey);
    const signer = createEffectSignerAnchor({ repositoryId, signer: signed.signer,
      epochAuthorityId: 'epoch:fallback-sink', publicKey: policyKeys.publicKey, currentEpoch: () => '0' });
    const clock = createTrustedClockAnchor({ authorityId: 'clock:fallback-operator', clockDomain,
      nowMs: () => 100, revision: () => '0' });
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(91), repositoryId,
      clock: () => 100, policyEpoch: () => '0', revocationEpoch: () => '0',
      isRevoked: () => false, authorizeIssue: () => true, authorizeDelegate: () => true });
    const key = fallbackKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const factory: NonNullable<ProcessHostOptions['effectRouterFactory']> = effect => {
      const broker = new DurableEffectBroker({ directory: join(directory, 'effects',
        domainDigest('aether.fallback-sink-effect-dir/1', effect.operationId).split(':').at(-1)!),
        clockDomain, clock: () => 100n, authorize: () => true, authorizeReconciliation: () => true,
        witness: selectEffectJournalWitness(catalog, effect.operationId),
        attestedSinkV4: { anchor, deploymentId, approvedAdapterArtifactDigest: adapterArtifactDigest,
          sinkStateWitness } });
      return new BrokerEffectRouter({ broker, manifest: effect.manifest,
        executionId: effect.operationId, policyEpoch: effect.policyEpoch!, deadline: effect.deadline!,
        adapters: new Map([[CAP, adapter]]), grantRef: effect.grantRef!,
        grant: () => { throw new Error('factory grant callback forbidden'); } });
    };
    const hostOptions: ProcessHostOptions = { directory: join(directory, 'host'), module, manifest, plan,
      registry, sealer: new CapabilitySealer(new Uint8Array(32).fill(92), () => 100), scopedGrants: grants,
      effectSignerAnchor: signer, trustedClockAnchor: clock, effectJournalWitnessCatalog: catalog,
      hostJournalWitness, attestedSinkAuthority: { repositoryId, deploymentId,
        approvedAdapterArtifactDigest: adapterArtifactDigest, anchor }, sinkStateWitness,
      anchoredEffectPolicyProfile: 'attested-sink-v8-host-witness', signedEffectResourcePolicy: signed,
      authorizeRecovery: () => true, effectRouterFactory: factory };
    const open = async (fault?: ConstructorParameters<typeof ProcessFallbackSupervisor>[0]['fault']) => {
      const host = await ProcessHost.open(hostOptions);
      const supervisor = new ProcessFallbackSupervisor({ directory: join(directory, 'supervisor'),
        host, module, manifest, tier1, tier2, key, conservativeProof, fault,
        tokensFor: (_tier, symbol) => host.issueScopedTokens(symbol, 60_000,
          symbol === tier1 ? new Map([[CAP, ['sink']]]) : new Map()) });
      return { host, supervisor };
    };
    return { open, module, manifest, tier1, tier2, conservativeProof, anchor, adapterArtifactDigest,
      servicePids: { sink: sink?.pid ?? null, witness: witness?.pid ?? null },
      witnessedDecisions: () => {
        const head = readSinkStateHead(sinkStateWitness);
        return { revision: head.revision,
          decisions: head.journal ? (JSON.parse(head.journal) as SinkStateJournalV2).decisions : [] };
      },
      decisionCount: () => JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length as number,
      request: () => executeRequest, stopWitness: async () => { await kill(witness); witness = null; },
      startWitness: async () => { witness = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready'); },
      close: async () => { await kill(sink); await kill(witness); } };
  } catch (error) { await kill(sink); await kill(witness); throw error; }
}
