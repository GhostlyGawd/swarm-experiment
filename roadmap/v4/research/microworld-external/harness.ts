/** Independent witness/sink/gateway/worker campaign for signed Aether code. */
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { DurableEffectBroker } from '../../../../src/fabric/effects.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { createProcessWitnessClient } from '../../../../src/fabric/witness-service.ts';
import { readSinkStateHead } from '../../../../src/fabric/sink-state-witness.ts';
import { verifySinkReceipt, type SinkPublicAnchorV1 } from '../../../../src/fabric/sink-receipt.ts';
import { selectEffectJournalWitness } from '../../../../src/fabric/effect-journal-witness.ts';
import { LivingCampaign, type LivingCase, type LivingExternalCaseResultV4 } from '../../../../src/tier3/living-campaign.ts';
import { auditLivingCampaignPipelineV1, type LivingPipelineReportV1 } from '../../../../src/tier3/living-campaign-pipeline.ts';
import { externalFixture, EXTERNAL_ARTIFACT, EXTERNAL_CLOCK, EXTERNAL_DEPLOYMENT,
  EXTERNAL_REPOSITORY, EXTERNAL_WITNESS_AUTHORITY, signExternalFixture } from './fixture.ts';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
function privateFile(path: string, value: unknown): void {
  const bytes = value instanceof Uint8Array || typeof value === 'string' ? value : encodeCanonical(value);
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
interface Service { readonly child: ChildProcess; readonly name: string }
async function launch(script: string, args: readonly string[], ready: string): Promise<Service> {
  const child = spawn(process.execPath, ['--experimental-strip-types', script, ...args],
    { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${script} startup timeout: ${stderr}`)); }, 12_000);
    child.stdout!.on('data', chunk => { if (String(chunk).includes(ready)) { clearTimeout(timer); resolveReady(); } });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`${script} exited ${code}/${signal}: ${stderr}`)); });
  });
  return { child, name: script };
}
async function stop(service: Service | null): Promise<void> {
  if (!service || service.child.exitCode !== null || service.child.signalCode !== null) return;
  const exit = new Promise<void>(resolveExit => service.child.once('exit', () => resolveExit()));
  service.child.kill('SIGTERM');
  const timer = setTimeout(() => service.child.kill('SIGKILL'), 3000);
  try { await exit; } finally { clearTimeout(timer); }
}
async function kill(service: Service): Promise<void> {
  if (service.child.exitCode !== null || service.child.signalCode !== null) throw new Error('candidate already stopped before crash');
  const exit = new Promise<NodeJS.Signals | null>(resolveExit =>
    service.child.once('exit', (_code, signal) => resolveExit(signal)));
  service.child.kill('SIGKILL');
  if (await exit !== 'SIGKILL') throw new Error('candidate restart lacked real SIGKILL');
}
async function frame(path: string, body: unknown): Promise<any> {
  return await new Promise((resolveValue, reject) => {
    const socket = connect(path); let buffer = '', finished = false;
    const timer = setTimeout(() => done(new Error('external worker TCP timeout')), 15_000);
    function done(error?: Error, result?: unknown): void {
      if (finished) return; finished = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolveValue(result);
    }
    socket.once('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', chunk => {
      buffer += String(chunk); const end = buffer.indexOf('\n'); if (end < 0) return;
      try { const value = JSON.parse(buffer.slice(0, end)); if (value.error) done(new Error(value.error)); else done(undefined, value.result); }
      catch (error) { done(error as Error); }
    });
    socket.once('error', error => done(error));
    socket.once('close', () => { if (!buffer.includes('\n')) done(new Error('external worker closed without response')); });
  });
}
async function faultFrame(path: string, payload: string, complete: boolean): Promise<void> {
  await new Promise<void>((resolveDone, reject) => {
    const socket = connect(path); let settled = false, response = '';
    const timer = setTimeout(() => done(new Error('fault frame timeout')), 5000);
    function done(error?: Error): void {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolveDone();
    }
    socket.once('connect', () => { socket.write(payload + (complete ? '\n' : '')); if (!complete) socket.end(); });
    socket.on('data', chunk => {
      response += String(chunk);
      if (response.includes('\n')) {
        try {
          const row = JSON.parse(response.slice(0, response.indexOf('\n')));
          if (!row.error) throw new Error('malformed fault frame was accepted');
          done();
        } catch (error) { done(error as Error); }
      }
    });
    socket.once('error', error => done(error));
    socket.once('close', () => {
      if (!complete && !response.includes('\n')) done();
      else if (complete && !response.includes('\n')) done(new Error('fault frame closed without refusal'));
    });
  });
}
const caseDigest = (input: LivingCase) => domainDigest('aether.living-case/1', input);
export type ExternalFaultActionV1 = 'malformed-command' | 'truncated-command' | 'healthy-case';
export interface ExternalRegistration {
  readonly authorization: NonNullable<ConstructorParameters<typeof LivingCampaign>[0]['effectAuthorization']>;
  readonly operatorPublicKeyPem: string;
  readonly anchor: SinkPublicAnchorV1;
  readonly generated: readonly LivingCase[];
}
export interface ExternalPrepared {
  readonly witnessService: Service;
  readonly registration: ExternalRegistration;
  readonly registrationPath: string;
  readonly privateDirectory: string;
  readonly witnessSocket: string;
  readonly sinkSocket: string;
  readonly gatewaySocket: string;
  readonly workerSocket: string;
  readonly workerSocketRestart: string;
  readonly witnessKeyFile: string;
  readonly sinkKeyFile: string;
  readonly witnessConfig: string;
  readonly sinkConfig: string;
  readonly workerConfig: string;
  readonly workerConfigRestart: string;
  readonly sinkStore: string;
  readonly witnessStore: string;
}
export async function prepareExternal(privateDirectory: string, publicDirectory: string): Promise<ExternalPrepared> {
  for (const path of [privateDirectory, publicDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const witnessDir = join(privateDirectory, 'witness'), sinkDir = join(privateDirectory, 'sink'),
    gatewayDir = join(privateDirectory, 'gateway'), workerDir = join(privateDirectory, 'worker');
  for (const path of [witnessDir, sinkDir, gatewayDir, workerDir]) mkdirSync(path, { mode: 0o700 });
  const witnessSocket = join(witnessDir, 'w.sock'), sinkSocket = join(sinkDir, 's.sock'),
    gatewaySocket = join(gatewayDir, 'g.sock'), workerSocket = join(workerDir, 'c.sock'),
    workerSocketRestart = join(workerDir, 'c2.sock');
  const witnessKey = randomBytes(32), sinkKey = randomBytes(32);
  const witnessKeyFile = join(witnessDir, 'key'), sinkKeyFile = join(sinkDir, 'key');
  privateFile(witnessKeyFile, witnessKey); privateFile(sinkKeyFile, sinkKey);
  const sinkKeys = generateKeyPairSync('ed25519'), operatorKeys = generateKeyPairSync('ed25519');
  const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId: EXTERNAL_REPOSITORY,
    sinkAuthorityId: 'sink-authority:living-external', sinkId: 'sink:living-external',
    keyId: 'key:living-external', keyEpoch: '1',
    publicKey: sinkKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const signingKeyFile = join(sinkDir, 'sign.pem');
  privateFile(signingKeyFile, sinkKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  const witnessStore = join(witnessDir, 'heads'), sinkStore = join(sinkDir, 'store');
  const witnessConfig = join(witnessDir, 'config.json'), sinkConfig = join(sinkDir, 'config.json'),
    workerConfig = join(workerDir, 'config.json'), workerConfigRestart = join(workerDir, 'config-restart.json');
  privateFile(witnessConfig, { socketPath: witnessSocket, storageDir: witnessStore, keyFile: witnessKeyFile,
    namespaces: [
      { kind: 'effect-scope', authorityId: EXTERNAL_WITNESS_AUTHORITY, repositoryId: EXTERNAL_REPOSITORY,
        catalogDeploymentId: EXTERNAL_DEPLOYMENT, clockDomain: EXTERNAL_CLOCK },
      { kind: 'sink-scope', authorityId: EXTERNAL_WITNESS_AUTHORITY, anchor,
        adapterArtifactDigest: EXTERNAL_ARTIFACT },
    ] });
  const witnessService = await launch(join(sourceRoot, 'src/fabric/witness-service-cli.ts'),
    ['--config', witnessConfig], 'witness service ready');
  try {
    const witness = createProcessWitnessClient({ socketPath: witnessSocket, key: witnessKey, timeoutMs: 3000 });
    const effectCatalog = witness.effectCatalog({ authorityId: EXTERNAL_WITNESS_AUTHORITY,
      repositoryId: EXTERNAL_REPOSITORY, deploymentId: EXTERNAL_DEPLOYMENT, clockDomain: EXTERNAL_CLOCK });
    const sinkStateWitness = witness.sinkStateWitness({ authorityId: EXTERNAL_WITNESS_AUTHORITY,
      anchor, adapterArtifactDigest: EXTERNAL_ARTIFACT });
    const fixture = externalFixture(), authorization = signExternalFixture(fixture, operatorKeys.privateKey,
      anchor, sinkStateWitness.digest, effectCatalog.digest);
    const operatorPublicKeyPem = operatorKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const registrationPath = join(publicDirectory, 'registration.json');
    privateFile(registrationPath, { authorization, operatorPublicKeyPem, anchor,
      generated: new LivingCampaign({ manifest: fixture.manifest, module: fixture.module, registry: fixture.registry,
        directory: join(privateDirectory, 'generated'), effectAuthorization: authorization,
        effectTrust: { repositoryId: EXTERNAL_REPOSITORY, policyEpoch: '1',
          signer: 'living-integrated-operator', key: operatorPublicKeyPem },
        externalEffectServices: { client: { execute: () => { throw new Error('registration sink forbidden'); },
          status: () => ({ state: 'unknown' }) }, sinkStateWitness, effectCatalog } }).generate() });
    privateFile(sinkConfig, { format: 'aether.attested-sink-config/2', socketPath: sinkSocket,
      storageDir: sinkStore, authKeyFile: sinkKeyFile, signingKeyFile, anchor,
      adapterArtifactDigest: EXTERNAL_ARTIFACT, witnessSocketPath: witnessSocket,
      witnessKeyFile, witnessAuthorityId: EXTERNAL_WITNESS_AUTHORITY });
    privateFile(workerConfig, { directory: join(privateDirectory, 'candidate'), witnessSocket, witnessKeyFile,
      gatewaySocket, sinkKeyFile, listenSocket: workerSocket,
      pipelineDirectory: join(privateDirectory, 'candidate', 'pipeline-phase-1') });
    privateFile(workerConfigRestart, { directory: join(privateDirectory, 'candidate'), witnessSocket, witnessKeyFile,
      gatewaySocket, sinkKeyFile, listenSocket: workerSocketRestart,
      pipelineDirectory: join(privateDirectory, 'candidate', 'pipeline-phase-2') });
    return { witnessService, registration: { authorization, operatorPublicKeyPem, anchor,
      generated: JSON.parse(readFileSync(registrationPath, 'utf8')).generated },
      registrationPath, privateDirectory, witnessSocket, sinkSocket, gatewaySocket, workerSocket, workerSocketRestart,
      witnessKeyFile, sinkKeyFile, witnessConfig, sinkConfig, workerConfig, workerConfigRestart, sinkStore, witnessStore };
  } catch (error) { await stop(witnessService); throw error; }
}
export interface ExternalCampaignResult {
  readonly format: 'aether.living-external-campaign/3';
  readonly generated: number; readonly executed: number; readonly filtered: number;
  readonly passed: number; readonly failed: number; readonly attempted: number;
  readonly partitionUnknown: number; readonly reconciled: number;
  readonly sinkDecisions: number; readonly sinkWitnessRevision: string;
  readonly seeds: readonly string[]; readonly coverage: readonly string[];
  readonly cases: readonly { input: LivingCase; result: LivingExternalCaseResultV4 }[];
  readonly partitionAttempt: LivingExternalCaseResultV4;
  readonly faultActions: readonly ExternalFaultActionV1[];
  readonly candidateRestarts: 1;
  readonly workerTermination: 'SIGKILL';
  readonly pipeline: {
    readonly format: 'aether.living-restart-pipeline/1';
    readonly phases: readonly [LivingPipelineReportV1, LivingPipelineReportV1];
    readonly generated: number; readonly executed: number; readonly attemptedExecutions: number;
    readonly failedAttempts: number; readonly filteredAttempts: number; readonly recoveries: number;
    readonly seeds: readonly string[]; readonly coverage: readonly string[];
  };
}
export async function runExternal(prepared: ExternalPrepared, publicDirectory: string,
  faultActions: readonly ExternalFaultActionV1[] = []): Promise<ExternalCampaignResult> {
  if (new Set(faultActions).size !== faultActions.length || faultActions.some(action =>
    !['malformed-command', 'truncated-command', 'healthy-case'].includes(action)))
    throw new TypeError('unsupported or duplicate external fault action');
  const services: Service[] = [prepared.witnessService], child = (name: string) => join(sourceRoot, 'src/fabric', name);
  let gateway: Service | null = null, activeWorker: Service | null = null;
  let activeSocket = prepared.workerSocket;
  try {
    services.push(await launch(child('attested-sink-service-cli.ts'), ['--config', prepared.sinkConfig], 'attested sink service ready'));
    gateway = await launch(join(dirname(fileURLToPath(import.meta.url)), 'gateway.ts'),
      [prepared.gatewaySocket, prepared.sinkSocket, 'drop-first-response'], 'gateway ready');
    activeWorker = await launch(join(dirname(fileURLToPath(import.meta.url)), 'worker.ts'),
      [prepared.registrationPath, prepared.workerConfig], 'external worker ready');
    services.push(activeWorker);
    const input = prepared.registration.generated.find(item => item.scenario === 'faulted-json-network' && item.ordinal === 0)!;
    let attempted = 0;
    const command = (op: string, caseInput: LivingCase, kind?: 'original' | 'retry' | 'duplicate') => ({ op, input: caseInput, ...(kind ? { kind } : {}) });
    const witnessClient = createProcessWitnessClient({ socketPath: prepared.witnessSocket,
      key: readFileSync(prepared.witnessKeyFile), timeoutMs: 3000 });
    const sinkWitness = witnessClient.sinkStateWitness({ authorityId: EXTERNAL_WITNESS_AUTHORITY,
      anchor: prepared.registration.anchor, adapterArtifactDigest: EXTERNAL_ARTIFACT });
    for (const action of faultActions) {
      if (action === 'malformed-command') await faultFrame(activeSocket, '{malformed', true);
      else if (action === 'truncated-command') await faultFrame(activeSocket, '{"op":"run-case"', false);
      else {
        const healthy = prepared.registration.generated.find(item => item.scenario === 'two-writers' && item.ordinal === 0)!;
        attempted++;
        const result = await frame(activeSocket, command('run-case', healthy, 'original')) as LivingExternalCaseResultV4;
        if (!result.passed || result.filtered || result.externalEffects.eventCount !== 0)
          throw new Error('healthy preflight case changed sink state');
      }
    }
    if (readSinkStateHead(sinkWitness).revision !== '0')
      throw new Error('optional fault actions dispatched an external effect');
    attempted++;
    const partitionAttempt = await frame(activeSocket, command('run-case', input, 'original')) as LivingExternalCaseResultV4;
    if (partitionAttempt.passed || partitionAttempt.filtered || partitionAttempt.externalEffects.indeterminate !== 1)
      throw new Error('post-sink partition did not preserve unknown effect outcome');
    if (gateway.child.exitCode === null && gateway.child.signalCode === null)
      await new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('partition gateway did not close after sink response')), 5000);
        gateway!.child.once('exit', () => { clearTimeout(timer); resolveExit(); });
      });
    gateway = null;
    if (existsSync(prepared.gatewaySocket)) throw new Error('partition gateway socket remained reachable');
    const partitionHead = readSinkStateHead(sinkWitness);
    if (partitionHead.revision !== '1')
      throw new Error('external sink did not commit before dropped response');
    privateFile(join(publicDirectory, 'partition-preheal-sink-head.json'), partitionHead);
    const prehealJournal = join(prepared.privateDirectory, 'candidate', 'external-effect-journals',
      caseDigest(input).split(':').at(-1)!, 'effects-v4.json');
    cpSync(prehealJournal, join(publicDirectory, 'partition-preheal-effect.json'));
    const phase1 = await frame(activeSocket, { op: 'finalize' }) as LivingPipelineReportV1;
    if (phase1.complete || phase1.generated !== 15 || phase1.failedAttempts !== 1
      || phase1.filteredAttempts !== 0 || phase1.attemptedExecutions !== attempted
      || phase1.recoveries !== 0) throw new Error('first worker omitted partition failure');
    await kill(activeWorker);
    activeWorker = await launch(join(dirname(fileURLToPath(import.meta.url)), 'worker.ts'),
      [prepared.registrationPath, prepared.workerConfigRestart], 'external worker ready');
    services.push(activeWorker); activeSocket = prepared.workerSocketRestart;
    const during = await frame(activeSocket, command('recover-case', input)) as { reconciled: number; unknown: number };
    if (during.reconciled !== 0 || during.unknown !== 1) throw new Error('partitioned status guessed a terminal outcome');
    gateway = await launch(join(dirname(fileURLToPath(import.meta.url)), 'gateway.ts'),
      [prepared.gatewaySocket, prepared.sinkSocket, 'forward'], 'gateway ready');
    const healed = await frame(activeSocket, command('recover-case', input)) as { reconciled: number; unknown: number };
    if (healed.reconciled !== 1 || healed.unknown !== 0)
      throw new Error(`rejoined signed status did not reconcile: ${JSON.stringify(healed)}`);
    const observed = new Map<string, { input: LivingCase; result: LivingExternalCaseResultV4 }>();
    attempted++;
    const recovered = await frame(activeSocket, command('run-case', input, 'retry')) as LivingExternalCaseResultV4;
    if (!recovered.passed || recovered.filtered || recovered.externalEffects.indeterminate)
      throw new Error('recovered external candidate case failed');
    observed.set(caseDigest(input), { input, result: recovered });
    attempted++;
    const duplicate = await frame(activeSocket, command('run-case', input, 'duplicate')) as LivingExternalCaseResultV4;
    if (domainDigest('aether.living-external-case-result/4', duplicate)
      !== domainDigest('aether.living-external-case-result/4', recovered))
      throw new Error('duplicate external case changed result');
    for (const next of prepared.registration.generated) {
      if (caseDigest(next) === caseDigest(input)) continue;
      attempted++;
      const result = await frame(activeSocket, command('run-case', next, 'original')) as LivingExternalCaseResultV4;
      if (!result.passed || result.filtered || result.externalEffects.indeterminate)
        throw new Error(`external candidate case failed: ${next.seed}`);
      observed.set(caseDigest(next), { input: next, result });
    }
    const cases = prepared.registration.generated.map(next => {
      const item = observed.get(caseDigest(next)); if (!item) throw new Error('generated external case omitted'); return item;
    });
    const head = readSinkStateHead(sinkWitness);
    if (head.revision !== '9' || !head.journal) throw new Error('external sink decision count mismatch');
    const state = JSON.parse(head.journal) as { decisions: { request: any; value: any; receipt: any }[] };
    if (state.decisions.length !== 9) throw new Error('external sink inventory incomplete');
    for (const row of state.decisions) {
      if (!verifySinkReceipt(row.receipt, prepared.registration.anchor, {
        repositoryId: EXTERNAL_REPOSITORY, deploymentId: EXTERNAL_DEPLOYMENT, request: row.request,
        sinkAuthorityId: prepared.registration.anchor.sinkAuthorityId,
        sinkId: prepared.registration.anchor.sinkId, adapterArtifactDigest: EXTERNAL_ARTIFACT,
        disposition: 'committed', value: row.value })) throw new Error('external sink receipt invalid');
    }
    const coverage = [...new Set(cases.flatMap(item => item.result.coverage))].sort();
    for (const label of ['scheduler:switched', 'resource:exhausted', 'network:malformed', 'event:reordered', 'effect:committed'])
      if (!coverage.includes(label)) throw new Error(`external candidate coverage missing ${label}`);
    const phase2 = await frame(activeSocket, { op: 'finalize' }) as LivingPipelineReportV1;
    if (!phase2.complete || phase2.generated !== cases.length || phase2.executed !== cases.length
      || phase1.attemptedExecutions + phase2.attemptedExecutions !== attempted
      || phase2.failedAttempts !== 0 || phase2.filteredAttempts !== 0 || phase2.recoveries !== 2
      || phase1.manifestDigest !== phase2.manifestDigest
      || phase1.authorizationDigest !== phase2.authorizationDigest
      || JSON.stringify(phase2.coverage) !== JSON.stringify(coverage)
      || JSON.stringify(phase2.seeds) !== JSON.stringify(cases.map(item => item.input.seed)))
      throw new Error('external pipeline omitted or reclassified an execution');
    const pipeline: ExternalCampaignResult['pipeline'] = { format: 'aether.living-restart-pipeline/1',
      phases: [phase1, phase2], generated: phase2.generated, executed: phase2.executed,
      attemptedExecutions: attempted, failedAttempts: phase1.failedAttempts + phase2.failedAttempts,
      filteredAttempts: phase1.filteredAttempts + phase2.filteredAttempts,
      recoveries: phase1.recoveries + phase2.recoveries,
      seeds: phase2.seeds, coverage: phase2.coverage };
    const result: ExternalCampaignResult = { format: 'aether.living-external-campaign/3',
      generated: prepared.registration.generated.length, executed: cases.length,
      filtered: cases.filter(item => item.result.filtered).length,
      passed: cases.filter(item => item.result.passed).length,
      failed: cases.filter(item => !item.result.passed).length, attempted,
      partitionUnknown: during.unknown, reconciled: healed.reconciled,
      sinkDecisions: state.decisions.length, sinkWitnessRevision: head.revision,
      seeds: cases.map(item => item.input.seed), coverage, cases, partitionAttempt,
      faultActions: [...faultActions], candidateRestarts: 1, workerTermination: 'SIGKILL', pipeline };
    cpSync(prepared.sinkStore, join(publicDirectory, 'sink-store'), { recursive: true });
    cpSync(prepared.witnessStore, join(publicDirectory, 'witness-store'), { recursive: true });
    cpSync(join(prepared.privateDirectory, 'candidate', 'external-effect-journals'),
      join(publicDirectory, 'broker-journals'), { recursive: true });
    cpSync(join(prepared.privateDirectory, 'candidate', 'pipeline-phase-1'),
      join(publicDirectory, 'pipeline', 'phase-1'), { recursive: true });
    cpSync(join(prepared.privateDirectory, 'candidate', 'pipeline-phase-2'),
      join(publicDirectory, 'pipeline', 'phase-2'), { recursive: true });
    return result;
  } finally {
    await stop(gateway);
    for (const service of services.reverse()) await stop(service);
  }
}
/** Offline audit uses only the preregistered public anchor and retained bytes. */
export function auditExternalRaw(publicDirectory: string, result: ExternalCampaignResult,
  registration: ExternalRegistration): void {
  if (result.format !== 'aether.living-external-campaign/3'
    || result.pipeline.format !== 'aether.living-restart-pipeline/1'
    || result.candidateRestarts !== 1 || result.workerTermination !== 'SIGKILL')
    throw new Error('external restart pipeline result version mismatch');
  const required = [...new Set(externalFixture().manifest.scenarios.flatMap(item => item.requiredCoverage))];
  const [phase1, phase2] = result.pipeline.phases;
  auditLivingCampaignPipelineV1(join(publicDirectory, 'pipeline', 'phase-1'), phase1, required);
  auditLivingCampaignPipelineV1(join(publicDirectory, 'pipeline', 'phase-2'), phase2, required);
  if (phase1.complete || !phase2.complete || phase1.generated !== phase2.generated
    || phase1.manifestDigest !== phase2.manifestDigest
    || phase1.authorizationDigest !== phase2.authorizationDigest
    || result.pipeline.generated !== phase2.generated || result.pipeline.executed !== phase2.executed
    || result.pipeline.attemptedExecutions !== phase1.attemptedExecutions + phase2.attemptedExecutions
    || result.pipeline.failedAttempts !== phase1.failedAttempts + phase2.failedAttempts
    || result.pipeline.filteredAttempts !== phase1.filteredAttempts + phase2.filteredAttempts
    || result.pipeline.recoveries !== phase1.recoveries + phase2.recoveries
    || JSON.stringify(result.pipeline.seeds) !== JSON.stringify(phase2.seeds)
    || JSON.stringify(result.pipeline.coverage) !== JSON.stringify(phase2.coverage)
    || result.attempted !== result.pipeline.attemptedExecutions)
    throw new Error('external restart pipeline omitted an attempt or recovery');
  const authorization = registration.authorization;
  if (authorization.format !== 'aether.living-effect-authorization/4'
    || domainDigest('aether.sink-anchor/1', registration.anchor)
      !== domainDigest('aether.sink-anchor/1', authorization.externalSink.anchor))
    throw new Error('external public anchor differs from signed authority');
  const signedExecution = domainDigest('aether.execution/1', authorization.executionManifest);
  const stateBytes = readFileSync(join(publicDirectory, 'sink-store', 'sink-state-v2.json'));
  const state = JSON.parse(stateBytes.toString()) as { decisions: { request: any; value: any; receipt: any }[];
    witnessRevision: string };
  if (state.witnessRevision !== result.sinkWitnessRevision || state.decisions.length !== result.sinkDecisions)
    throw new Error('external sink state/count changed');
  for (const row of state.decisions) {
    if (row.request.executionManifest !== signedExecution || row.request.policyEpoch !== '1'
      || row.request.capabilityGrantRef !== 'grant:living-effect')
      throw new Error('external sink decision outside signed execution');
    if (!verifySinkReceipt(row.receipt, registration.anchor, {
      repositoryId: EXTERNAL_REPOSITORY, deploymentId: EXTERNAL_DEPLOYMENT,
      request: row.request, sinkAuthorityId: registration.anchor.sinkAuthorityId,
      sinkId: registration.anchor.sinkId, adapterArtifactDigest: EXTERNAL_ARTIFACT,
      disposition: 'committed', value: row.value })) throw new Error('external sink receipt changed');
  }
  const witnessFiles = readdirSync(join(publicDirectory, 'witness-store')).filter(name => name.endsWith('.json'));
  const heads = witnessFiles.map(name => JSON.parse(readFileSync(join(publicDirectory, 'witness-store', name), 'utf8')) as
    { identity: { kind: string; operationId?: string }; head: { revision: string; journal: string | null } });
  const sinkHead = heads.find(row => row.identity.kind === 'sink');
  if (!sinkHead || sinkHead.head.revision !== result.sinkWitnessRevision
    || sinkHead.head.journal !== stateBytes.toString()) throw new Error('external sink witness head changed');
  const observedReceipts: string[] = [];
  for (const item of result.cases) {
    const suffix = caseDigest(item.input).split(':').at(-1)!;
    const journalPath = join(publicDirectory, 'broker-journals', suffix, 'effects-v4.json');
    const journalBytes = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : null;
    const journal = journalBytes ? JSON.parse(journalBytes) as { records: any[] } : { records: [] as any[] };
    const receipts = journal.records.map(row => row.signedSinkReceipt ?? null);
    const summary = item.result.externalEffects;
    if (domainDigest('aether.living-external-journal/4', journal.records) !== summary.journalDigest
      || domainDigest('aether.living-external-receipts/4', receipts) !== summary.receiptDigest
      || journal.records.length !== summary.eventCount || summary.indeterminate !== 0
      || journal.records.filter(row => row.outcome?.state === 'committed' && row.signedSinkReceipt).length !== summary.committedReceipts)
      throw new Error(`external broker case changed: ${item.input.seed}`);
    for (const receipt of receipts) if (receipt) observedReceipts.push(domainDigest('aether.sink-receipt/1', receipt));
    const head = heads.find(row => row.identity.kind === 'effect'
      && row.identity.operationId === `living-effect:${suffix}`);
    if (head ? head.head.journal !== journalBytes : journal.records.length !== 0)
      throw new Error(`external effect witness changed: ${item.input.seed}`);
  }
  const sinkReceipts = state.decisions.map(row => domainDigest('aether.sink-receipt/1', row.receipt)).sort();
  if (JSON.stringify(observedReceipts.sort()) !== JSON.stringify(sinkReceipts))
    throw new Error('external sink decisions differ from witnessed broker receipts');
  const preheal = JSON.parse(readFileSync(join(publicDirectory, 'partition-preheal-effect.json'), 'utf8')) as
    { records: { request: any; outcome: { state: string }; signedSinkReceipt: unknown }[] };
  const prehealHead = JSON.parse(readFileSync(join(publicDirectory, 'partition-preheal-sink-head.json'), 'utf8')) as
    { revision: string; journal: string | null };
  const prehealState = prehealHead.journal ? JSON.parse(prehealHead.journal) as
    { decisions: { request: any; receipt: any }[] } : null;
  if (preheal.records.length !== 1 || preheal.records[0].outcome?.state !== 'indeterminate'
    || preheal.records[0].signedSinkReceipt !== null || prehealHead.revision !== '1'
    || prehealState?.decisions.length !== 1
    || domainDigest('aether.effect/1', prehealState.decisions[0].request)
      !== domainDigest('aether.effect/1', preheal.records[0].request))
    throw new Error('partition evidence no longer proves committed sink with unknown broker outcome');
}
