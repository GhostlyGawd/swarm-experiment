import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as b from '../../src/tier1/build.ts';
import { capability, typeName } from '../../src/tier1/ids.ts';
import type { Ty } from '../../src/tier1/ast.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { createTrustedClockAnchor } from '../../src/tier2/trusted-clock-anchor.ts';
import { effectResourcePolicyDigestV5, signEffectResourcePolicyV5,
  effectResourcePolicyDigestV6, signEffectResourcePolicyV6,
  type EffectResourcePolicyBodyV5, type SignedEffectResourcePolicyV5,
  type EffectResourcePolicyBodyV6, type SignedEffectResourcePolicyV6 } from '../../src/tier2/effect-resource-policy.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { DurableEffectBroker, effectAdapterDigest } from '../../src/fabric/effects.ts';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { createAttestedSinkAdapter } from '../../src/fabric/attested-sink-adapter.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { readWitnessHead, selectEffectJournalWitness } from '../../src/fabric/effect-journal-witness.ts';
import { selectHostJournalWitness } from '../../src/fabric/host-journal-witness.ts';
import { PromotionCoordinator, approvePromotion, evidenceBundleDigest,
  migrationPlanDigest, effectPlanDigest, type PromotionInput } from '../../src/fabric/promotion.ts';
import type { SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessHost, PROCESS_INVOKE, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { ProcessDeployment, processMigrationPlan, processHostWitnessedSinkEffectPlan,
  processResourceScopedSinkEffectPlan,
  type ProcessDeploymentOptions } from '../../src/tier4/process-deployment.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const sourceRoot = resolve(import.meta.dirname, '../..');
async function launch(script: string, config: string, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(sourceRoot, 'src/fabric', script),
    '--config', config], { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('V10 and V11 ProcessHost/Deployment pin sink outcomes and target grants across promotion and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-attested-host-'));
  let sink: ChildProcess | null = null, witnessProcess: ChildProcess | null = null,
    operatorWitnessProcess: ChildProcess | null = null,
    host: ProcessHost | null = null, resourceHost: ProcessHost | null = null,
    deployment: ProcessDeployment | null = null, resourceDeployment: ProcessDeployment | null = null;
  try {
    const repositoryId = 'repo:host-sink', deploymentId = 'deployment:host-sink', clockDomain = 'clock:host-sink';
    const symbols = new SymbolSpace('attested-sink-host'), entry = symbols.define('entry'),
      valueSymbol = symbols.define('value'), mutatingEntry = symbols.define('mutatingEntry'),
      counterSymbol = symbols.define('counter'), targetSymbol = symbols.define('target');
    const CAP = capability('cap:test:attested_sink'), registry = new CapabilityRegistry();
    registry.define({ name: CAP, domain: 'test', operation: 'attested_sink', arity: 1,
      description: 'append to witnessed sink', effectful: true });
    const counterType: Ty = { t: 'Record', name: typeName('type:test:target_counter'),
      fields: [['count', b.Int]] };
    const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
      b.fn({ symbol: entry, params: [b.param(valueSymbol, b.Str)], returns: b.Str,
        capabilities: [CAP], purity: 'effectful', contract: b.contract({}),
        body: b.block(b.exprStmt(b.invoke(CAP, b.v(valueSymbol))), b.ret(b.v(valueSymbol))) }),
      b.fn({ symbol: mutatingEntry,
        params: [b.param(counterSymbol, counterType), b.param(targetSymbol, b.Str)],
        returns: b.Str, capabilities: [CAP], purity: 'effectful',
        contract: b.contract({ modifies: [b.place(counterSymbol, 'count')] }),
        body: b.block(b.assign(b.place(counterSymbol, 'count'),
          b.add(b.field(b.v(counterSymbol), 'count'), b.int(1))),
        b.exprStmt(b.invoke(CAP, b.v(targetSymbol))), b.ret(b.v(targetSymbol))) }),
    ] });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [entry, mutatingEntry],
      capabilities: [CAP], placement: 'container', memoryMb: 16 }], crossEdges: [],
      transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    const sinkKeys = generateKeyPairSync('ed25519'), policyKeys = generateKeyPairSync('ed25519');
    const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId,
      sinkAuthorityId: 'authority:host-sink', sinkId: 'sink:host-ledger', keyId: 'key:host-sink',
      keyEpoch: '0', publicKey: sinkKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const adapterArtifactDigest = domainDigest('aether.effect-adapter-artifact/2', 'host-fixture');
    const sinkSocket = join(directory, 'sink.sock'), witnessSocket = join(directory, 'witness.sock');
    const operatorWitnessSocket = join(directory, 'operator.sock');
    const sinkKeyFile = join(directory, 'sink.key'), witnessKeyFile = join(directory, 'witness.key');
    const operatorWitnessKeyFile = join(directory, 'operator.key');
    const sinkSignerFile = join(directory, 'sink.pem'), sinkConfig = join(directory, 'sink.json');
    const witnessConfig = join(directory, 'witness.json'), operatorWitnessConfig = join(directory, 'operator.json');
    const sinkKey = randomBytes(32), witnessKey = randomBytes(32), operatorWitnessKey = randomBytes(32);
    writeFileSync(sinkKeyFile, sinkKey, { mode: 0o600 });
    writeFileSync(witnessKeyFile, witnessKey, { mode: 0o600 });
    writeFileSync(operatorWitnessKeyFile, operatorWitnessKey, { mode: 0o600 });
    writeFileSync(sinkSignerFile, sinkKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    writeFileSync(witnessConfig, encodeCanonical({ socketPath: witnessSocket,
      storageDir: join(directory, 'witness-store'), keyFile: witnessKeyFile,
      namespaces: [{ kind: 'sink-scope', authorityId: 'operator:host-sink', anchor,
        adapterArtifactDigest }] }), { mode: 0o600 });
    writeFileSync(operatorWitnessConfig, encodeCanonical({ socketPath: operatorWitnessSocket,
      storageDir: join(directory, 'operator-store'), keyFile: operatorWitnessKeyFile,
      namespaces: [
        { kind: 'effect-scope', authorityId: 'operator:effects', repositoryId,
          catalogDeploymentId: deploymentId, clockDomain },
        { kind: 'host-scope', authorityId: 'operator:host-catalog', repositoryId, deploymentId },
        { kind: 'host-scope', authorityId: 'operator:resource-host-catalog', repositoryId, deploymentId },
        { kind: 'deployment', authorityId: 'operator:deployment', repositoryId, deploymentId },
        { kind: 'deployment', authorityId: 'operator:resource-deployment', repositoryId, deploymentId },
      ] }), { mode: 0o600 });
    writeFileSync(sinkConfig, encodeCanonical({ format: 'aether.attested-sink-config/2',
      socketPath: sinkSocket, storageDir: join(directory, 'sink-store'), authKeyFile: sinkKeyFile,
      signingKeyFile: sinkSignerFile, anchor, adapterArtifactDigest,
      witnessSocketPath: witnessSocket, witnessKeyFile, witnessAuthorityId: 'operator:host-sink' }), { mode: 0o600 });
    witnessProcess = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready');
    operatorWitnessProcess = await launch('witness-service-cli.ts', operatorWitnessConfig, 'witness service ready');
    sink = await launch('attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    const sinkStateWitness = createProcessWitnessClient({ socketPath: witnessSocket, key: witnessKey })
      .sinkStateWitness({ authorityId: 'operator:host-sink', anchor, adapterArtifactDigest });
    const substituteWitness = createProcessWitnessClient({ socketPath: witnessSocket, key: witnessKey })
      .sinkStateWitness({ authorityId: 'operator:host-sink', anchor, adapterArtifactDigest });
    const sinkClient = createAttestedSinkClient({ socketPath: sinkSocket, authKey: sinkKey, anchor,
      adapterArtifactDigest, repositoryId, deploymentId, timeoutMs: 5000 });
    const sinkAdapter = createAttestedSinkAdapter({ id: 'adapter:host-sink', client: sinkClient,
      repositoryId, deploymentId, approvedAdapterArtifactDigest: adapterArtifactDigest, anchor });
    const policy: EffectResourcePolicyBodyV5 = { format: 'aether.effect-resource-policy/5',
      repositoryId, astRoot: new GraphStore().intern(module), policyEpoch: '0', rules: [{
        capability: CAP, prefix: ['sink'], argument: null, adapterId: sinkAdapter.id,
        adapterDigest: effectAdapterDigest(sinkAdapter), adapterArtifactDigest, deadline: '1000',
        clockDomain, deploymentId, sinkAnchorDigest: domainDigest('aether.sink-anchor/1', anchor),
        sinkStateWitnessDigest: sinkStateWitness.digest,
      }] };
    const digest = (value: string) => domainDigest('aether.attested-host-test/1', value);
    const context: EvidenceContext = { module, registry, specification: 'Witnessed sink host effect',
      semanticsVersion: 'reference/1', compilerDigest: digest('compiler'),
      capabilityPolicyDigest: effectResourcePolicyDigestV5(policy),
      target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
      policy: { ...DEFAULT_EVIDENCE_POLICY_V2, requireFormal: false } };
    const evidence = mintLocalEvidence(context), manifest = evidence.manifest;
    const signed = signEffectResourcePolicyV5(policy, 'policy:host-sink', policyKeys.privateKey);
    const signer = createEffectSignerAnchor({ repositoryId, signer: signed.signer,
      epochAuthorityId: 'epoch:host-sink', publicKey: policyKeys.publicKey, currentEpoch: () => '0' });
    const clock = createTrustedClockAnchor({ authorityId: 'clock:operator', clockDomain,
      nowMs: () => 100, revision: () => '0' });
    let revoked = false;
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(73), repositoryId,
      clock: () => 100, policyEpoch: () => '0', revocationEpoch: () => revoked ? '1' : '0',
      isRevoked: () => revoked, authorizeIssue: () => true, authorizeDelegate: () => true });
    const operatorClient = createProcessWitnessClient({ socketPath: operatorWitnessSocket,
      key: operatorWitnessKey, timeoutMs: 10_000 });
    const catalog = operatorClient.effectCatalog({ authorityId: 'operator:effects',
      repositoryId, deploymentId, clockDomain });
    const hostCatalog = operatorClient.hostCatalog({ authorityId: 'operator:host-catalog',
      repositoryId, deploymentId });
    const resourceHostCatalog = operatorClient.hostCatalog({
      authorityId: 'operator:resource-host-catalog', repositoryId, deploymentId });
    const hostWitness = selectHostJournalWitness(hostCatalog, 'host:direct');
    const deploymentWitness = operatorClient.deploymentWitness({ authorityId: 'operator:deployment',
      repositoryId, deploymentId });
    const resourceDeploymentWitness = operatorClient.deploymentWitness({
      authorityId: 'operator:resource-deployment', repositoryId, deploymentId });
    let replaceSinkWitness = false;
    const factory: NonNullable<ProcessHostOptions['effectRouterFactory']> = effect => {
      const effectWitness = selectEffectJournalWitness(catalog, effect.operationId);
      const broker = new DurableEffectBroker({ directory: join(directory, 'effects',
        domainDigest('aether.attested-host-effect-dir/1', effect.operationId).split(':').at(-1)!),
        clockDomain, clock: () => 100n, authorize: () => true,
        authorizeReconciliation: () => true, witness: effectWitness,
        attestedSinkV4: { anchor, deploymentId, approvedAdapterArtifactDigest: adapterArtifactDigest,
          sinkStateWitness: replaceSinkWitness ? substituteWitness : sinkStateWitness } });
      return new BrokerEffectRouter({ broker, manifest: effect.manifest,
        executionId: effect.operationId, policyEpoch: effect.policyEpoch!, deadline: effect.deadline!,
        adapters: new Map([[CAP, sinkAdapter]]), grantRef: effect.grantRef!,
        grant: () => { throw new Error('factory grant callback forbidden'); } });
    };
    const options: ProcessHostOptions = { directory: join(directory, 'host'), module, manifest, plan,
      registry, sealer: new CapabilitySealer(new Uint8Array(32).fill(74), () => 100),
      scopedGrants: grants, effectSignerAnchor: signer, trustedClockAnchor: clock,
      effectJournalWitnessCatalog: catalog, hostJournalWitness: hostWitness,
      attestedSinkAuthority: { repositoryId, deploymentId,
        approvedAdapterArtifactDigest: adapterArtifactDigest, anchor }, sinkStateWitness,
      anchoredEffectPolicyProfile: 'attested-sink-v8-host-witness',
      signedEffectResourcePolicy: signed, authorizeRecovery: () => true, effectRouterFactory: factory };
    host = await ProcessHost.open(options);
    const tokens = () => host!.issueScopedTokens(entry, 60_000, new Map([[CAP, ['sink']]]));
    const before = readFileSync(join(options.directory, 'host.json'), 'utf8');
    const good = tokens(), invokeGrant = good.find(token => token.body.capability === PROCESS_INVOKE)!;
    await assert.rejects(host.call(entry, [{ tag: 'string', value: 'denied' }],
      { operationId: 'denied', tokens: [invokeGrant] }), /authority_denied/);
    assert.equal(readFileSync(join(options.directory, 'host.json'), 'utf8'), before);
    assert.equal(existsSync(join(directory, 'sink-store', 'sink-state-v2.json')), true);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 0);
    const result = await host.call(entry, [{ tag: 'string', value: 'hello' }],
      { operationId: 'call:1', tokens: tokens() });
    assert.equal(result.state, 'completed');
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 1);
    assert.equal(JSON.parse(readFileSync(join(options.directory, 'host.json'), 'utf8')).configuration.split(':')[0],
      'aether.process-host-config/8');
    assert.deepEqual(host.operationResult('call:1'), result);
    replaceSinkWitness = true;
    assert.throws(() => host!.operationResult('call:1'), /broker sink authority differs from operator selection/);
    replaceSinkWitness = false;
    assert.deepEqual(host.operationResult('call:1'), result);
    await kill(witnessProcess); witnessProcess = null;
    assert.throws(() => host!.operationResult('call:1'), /witness|sink decision/i);
    witnessProcess = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready');
    assert.deepEqual(host.operationResult('call:1'), result);
    await host.close(); host = null;
    await kill(sink); sink = null;
    unlinkSync(join(directory, 'sink-store', 'sink-state-v2.json'));
    sink = await launch('attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    host = await ProcessHost.open(options);
    assert.deepEqual(host.operationResult('call:1'), result);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 1);
    const revokedTokens = tokens();
    revoked = true;
    await assert.rejects(host.call(entry, [{ tag: 'string', value: 'revoked' }],
      { operationId: 'call:revoked', tokens: revokedTokens }), /authority_denied|grant/);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 1);
    revoked = false;
    const governor = generateKeyPairSync('ed25519');
    const coordinator = new PromotionCoordinator({ profile: 'baseline-governor-v1',
      directory: join(directory, 'coordinator'), repositoryId,
      genesisManifest: executionManifestDigest(manifest),
      authority: () => ({ repositoryId, membershipEpoch: '1', policyEpoch: '1',
        eligibleGovernors: ['governor'] }), governorKey: () => governor.publicKey,
      clock: () => 100n });
    const factoryId = 'attested-sink-services/1';
    let candidateSigned: SignedEffectResourcePolicyV5 | null = null;
    const deploymentOptions: ProcessDeploymentOptions = {
      directory: join(directory, 'deployment'), coordinator,
      capabilityProfile: 'scoped-anchored-sink-v10', effectSignerAnchor: signer,
      trustedClockAnchor: clock, effectJournalWitnessCatalog: catalog,
      hostJournalWitnessCatalog: hostCatalog, deploymentJournalWitness: deploymentWitness,
      attestedSinkAuthority: options.attestedSinkAuthority, sinkStateWitness,
      factories: new Map([[factoryId, artifact => ({ sealer: options.sealer, scopedGrants: grants,
        signedEffectResourcePolicy: artifact.manifest.capabilityPolicyDigest === manifest.capabilityPolicyDigest
          ? signed : candidateSigned!, effectRouterFactory: factory,
        authorizeRecovery: () => true })]]),
      genesis: { context, evidence, plan, factoryId },
    };
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions,
      directory: join(directory, 'factory-supplied-sink'), factories: new Map([[factoryId,
        () => ({ sealer: options.sealer, scopedGrants: grants,
          signedEffectResourcePolicy: signed, effectRouterFactory: factory,
          attestedSinkAuthority: options.attestedSinkAuthority } as never)]]) }),
    /independently provisioned/);
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions,
      directory: join(directory, 'factory-supplied-sink-witness'), factories: new Map([[factoryId,
        () => ({ sealer: options.sealer, scopedGrants: grants,
          signedEffectResourcePolicy: signed, effectRouterFactory: factory,
          sinkStateWitness } as never)]]) }), /independently provisioned/);
    deployment = await ProcessDeployment.open(deploymentOptions);
    assert.equal(deployment.status().capabilityProfile, 'scoped-anchored-sink-v10');
    assert.equal(JSON.parse(readFileSync(join(deploymentOptions.directory, 'deployment.json'), 'utf8')).format,
      'aether.process-deployment/10');
    assert.equal(JSON.parse(readFileSync(join(deploymentOptions.directory, 'deployments',
      'genesis', 'prepared.json'), 'utf8')).format, 'aether.process-deployment-prepared/8');
    const deployedTokens = () => deployment!.issueScopedTokens(entry, 60_000,
      new Map([[CAP, ['sink']]]));
    const deploymentBefore = readFileSync(join(deploymentOptions.directory, 'deployment.json'), 'utf8');
    const granted = deployedTokens(), onlyInvoke = granted.filter(token => token.body.capability === PROCESS_INVOKE);
    const effectGrant = granted.find(token => token.body.capability === CAP)!;
    const deniedGrants = [
      ['missing', onlyInvoke],
      ['forged', [...onlyInvoke, { ...effectGrant, signature: '0'.repeat(64) }]],
      ['wrong-audience', [...onlyInvoke, grants.issue({ capability: CAP,
        audience: 'other-entry', path: effectGrant.body.path }, 60_000)]],
      ['wrong-path', [...onlyInvoke, grants.issue({ capability: CAP,
        audience: entry, path: ['wrong'] }, 60_000)]],
      ['forged-widening', [...onlyInvoke, { ...effectGrant,
        body: { ...effectGrant.body, path: effectGrant.body.path.slice(0, -1) } }]],
      ['narrowed-child', [...onlyInvoke, grants.attenuate(effectGrant, { capability: CAP,
        audience: entry, path: [...effectGrant.body.path, 'other'] }, 60_000)]],
    ] as const;
    for (const [name, denied] of deniedGrants)
      await assert.rejects(deployment.call(entry, [{ tag: 'string', value: 'denied' }],
        { operationId: `deployed:denied:${name}`, tokens: denied }), /authority_denied|grant/, name);
    assert.equal(readFileSync(join(deploymentOptions.directory, 'deployment.json'), 'utf8'), deploymentBefore);
    const deployed = await deployment.call(entry, [{ tag: 'string', value: 'deployed' }],
      { operationId: 'deployed:1', tokens: deployedTokens() });
    assert.equal(deployed.state, 'completed');
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 2);
    assert.deepEqual(await deployment.call(entry, [{ tag: 'string', value: 'deployed' }],
      { operationId: 'deployed:1', tokens: deployedTokens() }), deployed);
    const retryTokens = deployedTokens();
    replaceSinkWitness = true;
    await assert.rejects(deployment.call(entry, [{ tag: 'string', value: 'deployed' }],
      { operationId: 'deployed:1', tokens: retryTokens }), /broker sink authority differs/);
    replaceSinkWitness = false;
    await deployment.close(); deployment = null;
    deployment = await ProcessDeployment.open({ ...deploymentOptions, genesis: undefined });
    assert.deepEqual(await deployment.call(entry, [{ tag: 'string', value: 'deployed' }],
      { operationId: 'deployed:1', tokens: deployedTokens() }), deployed);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 2);
    const deploymentFile = join(deploymentOptions.directory, 'deployment.json');
    const priorRegistry = readFileSync(deploymentFile);
    if (module.kind !== 'Module') throw new Error('invalid test module');
    const candidateModule = { ...module, members: module.members.map(member =>
      member.kind === 'FunctionDecl' && member.symbol === entry
        ? { ...member, body: b.block(b.exprStmt(b.str('candidate')),
          b.exprStmt(b.invoke(CAP, b.v(valueSymbol))), b.ret(b.v(valueSymbol))) }
        : member) };
    const candidatePolicy: EffectResourcePolicyBodyV5 = { ...policy,
      astRoot: new GraphStore().intern(candidateModule) };
    candidateSigned = signEffectResourcePolicyV5(candidatePolicy, signed.signer, policyKeys.privateKey);
    const candidateContext: EvidenceContext = { ...context, module: candidateModule,
      capabilityPolicyDigest: effectResourcePolicyDigestV5(candidatePolicy) };
    const candidateEvidence = mintLocalEvidence(candidateContext);
    const candidateArtifact = deployment.registerArtifact({ context: candidateContext,
      evidence: candidateEvidence, plan, factoryId });
    const migrationPlan = processMigrationPlan(await deployment.snapshot(), candidateArtifact);
    const effectPlan = processHostWitnessedSinkEffectPlan(factoryId,
      candidateEvidence.manifest.capabilityPolicyDigest, signer.digest, clock.digest,
      catalog.digest, hostCatalog.digest, deploymentWitness.digest,
      domainDigest('aether.sink-anchor/1', anchor), deploymentId, adapterArtifactDigest,
      sinkStateWitness.digest);
    const proposal = { format: 'aether.promotion/1' as const, repositoryId,
      expectedParent: coordinator.state().committedManifest,
      candidateManifest: executionManifestDigest(candidateEvidence.manifest),
      evidenceBundleDigest: evidenceBundleDigest(candidateEvidence),
      migrationPlanDigest: migrationPlanDigest(migrationPlan),
      effectPlanDigest: effectPlanDigest(effectPlan), membershipEpoch: '1',
      policyEpoch: '1', expiresAt: '1000' };
    const promotion: PromotionInput = { proposal,
      approval: approvePromotion(proposal, 'governor', governor.privateKey),
      evidence: candidateEvidence, context: candidateContext, migrationPlan, effectPlan };
    await deployment.promote(promotion);
    assert.equal(deployment.status().generation, '1');
    const promoted = await deployment.call(entry, [{ tag: 'string', value: 'promoted' }],
      { operationId: 'deployed:promoted', tokens: deployedTokens() });
    assert.equal(promoted.state, 'completed');
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 3);
    const promotedTokens = deployedTokens();
    await kill(witnessProcess); witnessProcess = null;
    assert.equal(deployment.status().servingReady, false);
    await assert.rejects(deployment.call(entry, [{ tag: 'string', value: 'promoted' }],
      { operationId: 'deployed:promoted', tokens: promotedTokens }), /witness|sink decision/i);
    witnessProcess = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready');
    assert.equal(deployment.status().servingReady, true);
    assert.deepEqual(await deployment.call(entry, [{ tag: 'string', value: 'promoted' }],
      { operationId: 'deployed:promoted', tokens: promotedTokens }), promoted);
    await deployment.close(); deployment = null;
    writeFileSync(deploymentFile, priorRegistry);
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions,
      capabilityProfile: 'scoped-anchored-wasm-v9', attestedSinkAuthority: undefined,
      sinkStateWitness: undefined, genesis: undefined }), /invalid deployment readiness\/profile|invalid deployment witness journal|diverges from operator witness/);
    deployment = await ProcessDeployment.open({ ...deploymentOptions, genesis: undefined });
    assert.equal(deployment.status().generation, '1');
    assert.deepEqual(await deployment.call(entry, [{ tag: 'string', value: 'promoted' }],
      { operationId: 'deployed:promoted', tokens: deployedTokens() }), promoted);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 3);

    const scopedPolicy: EffectResourcePolicyBodyV6 = { ...policy,
      format: 'aether.effect-resource-policy/6', rules: [{ ...policy.rules[0],
        prefix: ['account'], argument: 0 }] };
    const scopedContext: EvidenceContext = { ...context,
      capabilityPolicyDigest: effectResourcePolicyDigestV6(scopedPolicy) };
    const scopedEvidence = mintLocalEvidence(scopedContext), scopedManifest = scopedEvidence.manifest;
    const scopedSigned = signEffectResourcePolicyV6(scopedPolicy, signed.signer, policyKeys.privateKey);
    const scopedOptions: ProcessHostOptions = { ...options,
      directory: join(directory, 'resource-host'), manifest: scopedManifest,
      hostJournalWitness: selectHostJournalWitness(resourceHostCatalog, 'host:resource'),
      anchoredEffectPolicyProfile: 'attested-sink-v9-resource-witness',
      signedEffectResourcePolicy: scopedSigned };
    resourceHost = await ProcessHost.open(scopedOptions);
    const targetTokens = (target: string) => resourceHost!.issueScopedTokens(entry, 60_000,
      new Map([[CAP, ['account', target]]]));
    for (const target of ['alice', 'bob']) {
      const completed = await resourceHost.call(entry, [{ tag: 'string', value: target }],
        { operationId: `resource:${target}`, tokens: targetTokens(target) });
      assert.equal(completed.state, 'completed', target);
    }
    await assert.rejects(resourceHost.call(entry, [{ tag: 'string', value: 'bob' }],
      { operationId: 'resource:bob', tokens: targetTokens('alice') }),
    /authority_denied: cached effect target/);
    assert.equal(JSON.parse(readFileSync(join(scopedOptions.directory, 'host.json'), 'utf8')).configuration.split(':')[0],
      'aether.process-host-config/9');
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 5);
    const scopedHostJournal = JSON.parse(readFileSync(join(scopedOptions.directory, 'host.json'), 'utf8'));
    const aliceEffectId = scopedHostJournal.calls.find((call: { operationId: string }) =>
      call.operationId === 'resource:alice').effects[0].id as string;
    const aliceEffectJournal = JSON.parse(readWitnessHead(
      selectEffectJournalWitness(catalog, aliceEffectId)).journal!);
    assert.match(aliceEffectJournal.records[0].request.capabilityGrantRef,
      /^aether\.process-effect-grant-ref\/2:b3:/);
    const bobEffectId = scopedHostJournal.calls.find((call: { operationId: string }) =>
      call.operationId === 'resource:bob').effects[0].id as string;
    const bobEffectJournal = JSON.parse(readWitnessHead(
      selectEffectJournalWitness(catalog, bobEffectId)).journal!);
    assert.notEqual(aliceEffectJournal.records[0].request.capabilityGrantRef,
      bobEffectJournal.records[0].request.capabilityGrantRef,
      'the signed grant reference binds the concrete target path');
    let mismatched: Awaited<ReturnType<ProcessHost['call']>> | null = null;
    try { mismatched = await resourceHost.call(entry, [{ tag: 'string', value: 'bob' }],
      { operationId: 'resource:wrong-target', tokens: targetTokens('alice') }); }
    catch { /* A pre-dispatch authority error may reject the whole call. */ }
    if (mismatched && mismatched.state === 'completed')
      assert.equal(mismatched.execution.ok, false, 'wrong target must be a failed execution');
    const deniedCall = JSON.parse(readFileSync(join(scopedOptions.directory, 'host.json'), 'utf8'))
      .calls.find((call: { operationId: string }) => call.operationId === 'resource:wrong-target');
    assert.equal(deniedCall.effects.length, 0, 'wrong target is denied before an effect intent');
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 5,
      'an Alice-only grant cannot write Bob');
    const broadTokens = resourceHost.issueScopedTokens(entry, 60_000,
      new Map([[CAP, ['account']]]));
    const invalidTarget = await resourceHost.call(entry, [{ tag: 'string', value: '../bad' }],
      { operationId: 'resource:invalid', tokens: broadTokens });
    assert.equal(invalidTarget.state, 'completed');
    if (invalidTarget.state === 'completed') assert.equal(invalidTarget.execution.ok, false);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 5);
    const counterRef = await resourceHost.allocateRecord(counterType,
      { count: { tag: 'int', value: '0' } }, { operationId: 'resource:counter' });
    const deniedMutation = await resourceHost.call(mutatingEntry,
      [{ tag: 'ref', value: counterRef }, { tag: 'string', value: 'bob' }],
      { operationId: 'resource:denied-mutation', tokens: resourceHost.issueScopedTokens(mutatingEntry,
        60_000, new Map([[CAP, ['account', 'alice']]])) });
    if (deniedMutation.state === 'completed') assert.equal(deniedMutation.execution.ok, false);
    const counter = (await resourceHost.snapshot()).records.find(row => row.objectId === counterRef.objectId);
    const count = counter?.fields.find(([name]) => name === 'count')?.[1];
    assert.equal(count?.tag, 'int');
    if (count?.tag === 'int') assert.equal(count.value, '0',
      'denied dynamic target must not adopt the worker mutation before the effect');
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 5);

    const resourceCoordinator = new PromotionCoordinator({ profile: 'baseline-governor-v1',
      directory: join(directory, 'resource-coordinator'), repositoryId,
      genesisManifest: executionManifestDigest(scopedManifest),
      authority: () => ({ repositoryId, membershipEpoch: '1', policyEpoch: '1',
        eligibleGovernors: ['governor'] }), governorKey: () => governor.publicKey,
      clock: () => 100n });
    const resourceFactoryId = 'resource-sink-services/1';
    let candidateResourceSigned: SignedEffectResourcePolicyV6 | null = null;
    const resourceDeploymentOptions: ProcessDeploymentOptions = {
      directory: join(directory, 'resource-deployment'), coordinator: resourceCoordinator,
      capabilityProfile: 'scoped-anchored-sink-v11', effectSignerAnchor: signer,
      trustedClockAnchor: clock, effectJournalWitnessCatalog: catalog,
      hostJournalWitnessCatalog: resourceHostCatalog,
      deploymentJournalWitness: resourceDeploymentWitness,
      attestedSinkAuthority: options.attestedSinkAuthority, sinkStateWitness,
      factories: new Map([[resourceFactoryId, artifact => ({ sealer: options.sealer,
        scopedGrants: grants, signedEffectResourcePolicy:
          artifact.manifest.capabilityPolicyDigest === scopedManifest.capabilityPolicyDigest
            ? scopedSigned : candidateResourceSigned!,
        effectRouterFactory: factory, authorizeRecovery: () => true })]]),
      genesis: { context: scopedContext, evidence: scopedEvidence, plan,
        factoryId: resourceFactoryId },
    };
    resourceDeployment = await ProcessDeployment.open(resourceDeploymentOptions);
    assert.equal(resourceDeployment.status().capabilityProfile, 'scoped-anchored-sink-v11');
    assert.equal(JSON.parse(readFileSync(join(resourceDeploymentOptions.directory, 'deployment.json'), 'utf8')).format,
      'aether.process-deployment/11');
    assert.equal(JSON.parse(readFileSync(join(resourceDeploymentOptions.directory, 'deployments',
      'genesis', 'prepared.json'), 'utf8')).format, 'aether.process-deployment-prepared/9');
    const deployedTargetTokens = (target: string) => resourceDeployment!.issueScopedTokens(entry,
      60_000, new Map([[CAP, ['account', target]]]));
    for (const target of ['alice', 'bob']) {
      const completed = await resourceDeployment.call(entry, [{ tag: 'string', value: target }],
        { operationId: `deployed-resource:${target}`, tokens: deployedTargetTokens(target) });
      assert.equal(completed.state, 'completed', target);
    }
    await assert.rejects(resourceDeployment.call(entry, [{ tag: 'string', value: 'bob' }],
      { operationId: 'deployed-resource:bob', tokens: deployedTargetTokens('alice') }),
    /authority_denied: cached effect target/);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 7);
    const wrongTarget = await resourceDeployment.call(entry, [{ tag: 'string', value: 'bob' }],
      { operationId: 'deployed-resource:wrong', tokens: deployedTargetTokens('alice') });
    assert.equal(wrongTarget.state, 'completed');
    if (wrongTarget.state === 'completed') assert.equal(wrongTarget.execution.ok, false);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 7,
      'a deployed Alice-only grant cannot write Bob');
    const resourceDeploymentFile = join(resourceDeploymentOptions.directory, 'deployment.json');
    const priorResourceRegistry = readFileSync(resourceDeploymentFile);
    const candidateScopedPolicy: EffectResourcePolicyBodyV6 = { ...scopedPolicy,
      astRoot: new GraphStore().intern(candidateModule) };
    candidateResourceSigned = signEffectResourcePolicyV6(candidateScopedPolicy,
      scopedSigned.signer, policyKeys.privateKey);
    const candidateScopedContext: EvidenceContext = { ...scopedContext,
      module: candidateModule,
      capabilityPolicyDigest: effectResourcePolicyDigestV6(candidateScopedPolicy) };
    const candidateScopedEvidence = mintLocalEvidence(candidateScopedContext);
    const resourceArtifact = resourceDeployment.registerArtifact({ context: candidateScopedContext,
      evidence: candidateScopedEvidence, plan, factoryId: resourceFactoryId });
    const resourceMigrationPlan = processMigrationPlan(await resourceDeployment.snapshot(), resourceArtifact);
    const resourceEffectPlan = processResourceScopedSinkEffectPlan(resourceFactoryId,
      candidateScopedEvidence.manifest.capabilityPolicyDigest, signer.digest, clock.digest,
      catalog.digest, resourceHostCatalog.digest, resourceDeploymentWitness.digest,
      domainDigest('aether.sink-anchor/1', anchor), deploymentId, adapterArtifactDigest,
      sinkStateWitness.digest);
    const resourceProposal = { format: 'aether.promotion/1' as const, repositoryId,
      expectedParent: resourceCoordinator.state().committedManifest,
      candidateManifest: executionManifestDigest(candidateScopedEvidence.manifest),
      evidenceBundleDigest: evidenceBundleDigest(candidateScopedEvidence),
      migrationPlanDigest: migrationPlanDigest(resourceMigrationPlan),
      effectPlanDigest: effectPlanDigest(resourceEffectPlan), membershipEpoch: '1',
      policyEpoch: '1', expiresAt: '1000' };
    const resourcePromotion: PromotionInput = { proposal: resourceProposal,
      approval: approvePromotion(resourceProposal, 'governor', governor.privateKey),
      evidence: candidateScopedEvidence, context: candidateScopedContext,
      migrationPlan: resourceMigrationPlan, effectPlan: resourceEffectPlan };
    await resourceDeployment.promote(resourcePromotion);
    assert.equal(resourceDeployment.status().generation, '1');
    const carol = await resourceDeployment.call(entry, [{ tag: 'string', value: 'carol' }],
      { operationId: 'deployed-resource:carol', tokens: deployedTargetTokens('carol') });
    assert.equal(carol.state, 'completed');
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 8);
    const reboundContext: EvidenceContext = { ...candidateScopedContext,
      target: { ...candidateScopedContext.target,
        artifactDigest: digest('resource-scoped-target-rebound') } };
    const reboundEvidence = mintLocalEvidence(reboundContext);
    const reboundArtifact = resourceDeployment.registerArtifact({ context: reboundContext,
      evidence: reboundEvidence, plan, factoryId: resourceFactoryId });
    const reboundMigrationPlan = processMigrationPlan(await resourceDeployment.snapshot(), reboundArtifact);
    const reboundEffectPlan = processResourceScopedSinkEffectPlan(resourceFactoryId,
      reboundEvidence.manifest.capabilityPolicyDigest, signer.digest, clock.digest,
      catalog.digest, resourceHostCatalog.digest, resourceDeploymentWitness.digest,
      domainDigest('aether.sink-anchor/1', anchor), deploymentId, adapterArtifactDigest,
      sinkStateWitness.digest);
    const reboundProposal = { format: 'aether.promotion/1' as const, repositoryId,
      expectedParent: resourceCoordinator.state().committedManifest,
      candidateManifest: executionManifestDigest(reboundEvidence.manifest),
      evidenceBundleDigest: evidenceBundleDigest(reboundEvidence),
      migrationPlanDigest: migrationPlanDigest(reboundMigrationPlan),
      effectPlanDigest: effectPlanDigest(reboundEffectPlan), membershipEpoch: '1',
      policyEpoch: '1', expiresAt: '1000' };
    await resourceDeployment.promote({ proposal: reboundProposal,
      approval: approvePromotion(reboundProposal, 'governor', governor.privateKey),
      evidence: reboundEvidence, context: reboundContext,
      migrationPlan: reboundMigrationPlan, effectPlan: reboundEffectPlan });
    assert.equal(resourceDeployment.status().generation, '2');
    assert.deepEqual(await resourceDeployment.call(entry, [{ tag: 'string', value: 'carol' }],
      { operationId: 'deployed-resource:carol', tokens: deployedTargetTokens('carol') }), carol);
    await assert.rejects(resourceDeployment.call(entry, [{ tag: 'string', value: 'carol' }],
      { operationId: 'deployed-resource:carol', tokens: deployedTargetTokens('alice') }),
    /authority_denied: cached effect target/);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 8,
      'cross-generation cached receipts cannot redispatch the sink');
    await resourceDeployment.close(); resourceDeployment = null;
    writeFileSync(resourceDeploymentFile, priorResourceRegistry);
    await assert.rejects(ProcessDeployment.open({ ...resourceDeploymentOptions,
      capabilityProfile: 'scoped-anchored-sink-v10', genesis: undefined }),
    /diverges from operator witness|invalid deployment readiness\/profile/);
    resourceDeployment = await ProcessDeployment.open({ ...resourceDeploymentOptions, genesis: undefined });
    assert.equal(resourceDeployment.status().generation, '2');
    assert.deepEqual(await resourceDeployment.call(entry, [{ tag: 'string', value: 'carol' }],
      { operationId: 'deployed-resource:carol', tokens: deployedTargetTokens('carol') }), carol);
    await assert.rejects(resourceDeployment.call(entry, [{ tag: 'string', value: 'carol' }],
      { operationId: 'deployed-resource:carol', tokens: deployedTargetTokens('alice') }),
    /authority_denied: cached effect target/);
    assert.equal(JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 8);
  } finally {
    await resourceDeployment?.close(); await deployment?.close();
    await resourceHost?.close(); await host?.close(); await kill(sink);
    await kill(witnessProcess); await kill(operatorWitnessProcess);
    rmSync(directory, { recursive: true, force: true });
  }
});
