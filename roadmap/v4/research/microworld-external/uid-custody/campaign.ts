/** Versioned same-VM three-UID custody trial for the exact signed external candidate. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../../src/fabric/identity.ts';
import type { LivingCase, LivingExternalCaseResultV4 } from '../../../../../src/tier3/living-campaign.ts';
import type { LivingPipelineReportV1 } from '../../../../../src/tier3/living-campaign-pipeline.ts';
import { auditExternalRaw, prepareExternal, type ExternalCampaignResult,
  type ExternalRegistration } from '../harness.ts';
import { externalFixture } from '../fixture.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const own = resolve(dirname(fileURLToPath(import.meta.url)));
const runtimeImage = 'node:26.7.0-bookworm-slim';
const builderImage = 'aether-uid-custody-builder:node26';
const group = 20000;
const ids = { candidate: 10001, sink: 10002, witness: 10003 } as const;
const volumeRoot = '/run/aether';
const p = (...parts: string[]) => [volumeRoot, ...parts].join('/');
const repo = '/repo';
const uidPath = `${repo}/roadmap/v4/research/microworld-external/uid-custody`;
const workerPath = `${repo}/roadmap/v4/research/microworld-external/worker.ts`;
const gatewayPath = `${repo}/roadmap/v4/research/microworld-external/gateway.ts`;
const caseDigest = (input: LivingCase) => domainDigest('aether.living-case/1', input);
interface D { path: string; uid: number; gid: number; mode: number }
interface F extends D { base64: string }
function docker(args: string[], input?: string): string {
  try { return execFileSync('docker', args, { input, encoding: 'utf8', timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024 }).trim(); }
  catch (error) { const e = error as { stderr?: Buffer; stdout?: Buffer; message: string };
    throw new Error(`docker ${args.slice(0, 4).join(' ')} failed: ${e.stderr?.toString() ?? e.message}`); }
}
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitReady(name: string, ready: string): void {
  for (let n = 0; n < 200; n++) {
    const logs = docker(['logs', name]);
    if (logs.includes(ready)) return;
    if (docker(['inspect', '-f', '{{.State.Running}}', name]) !== 'true')
      throw new Error(`${name} exited before ready: ${logs}`);
    sleep(100);
  }
  throw new Error(`${name} startup timeout: ${docker(['logs', name])}`);
}
function file(path: string, uid: number, value: Buffer | string | object): F {
  const bytes = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : Buffer.from(encodeCanonical(value));
  return { path, uid, gid: uid, mode: 0o600, base64: bytes.toString('base64') };
}
function dir(path: string, uid: number, gid: number, mode: number): D { return { path, uid, gid, mode }; }
function sha(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function client(container: string, socket: string, command: object): any {
  const value = docker(['exec', '-i', '--user', `${ids.candidate}:${group}`, container,
    'node', '--experimental-strip-types', `${uidPath}/client.ts`, socket, 'json'], JSON.stringify(command));
  return JSON.parse(value);
}
function probe(container: string, registrationPath: string): { revision: string; journal: string | null } {
  return JSON.parse(docker(['exec', '--user', `${ids.candidate}:${group}`, container,
    'node', '--experimental-strip-types', `${uidPath}/probe.ts`, p('witness-access', 'candidate.sock'),
    p('candidate', 'private', 'witness-key'), registrationPath]));
}
function launch(name: string, volume: string, uid: number, command: string[], ready: string): void {
  docker(['run', '-d', '--name', name, '--user', `${uid}:${group}`, '--network', 'none',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,src=${root},dst=${repo},readonly`,
    '--mount', `type=volume,src=${volume},dst=${volumeRoot}`,
    runtimeImage, ...command]);
  waitReady(name, ready);
}
function proxy(name: string, volume: string, uid: number, listen: string, upstream: string,
  clientUid: number, serviceUid: number): void {
  launch(name, volume, uid, [p('bin', 'witness-peer'), '--listen', listen,
    '--upstream', upstream, '--uid', String(clientUid), '--gid', String(group),
    '--upstream-uid', String(serviceUid), '--mode', '0660'], 'witness-peer ready');
}
function evidenceCopy(container: string, source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  docker(['cp', `${container}:${source}`, target]);
}
function access(container: string, uid: number, target: string): string {
  return docker(['exec', '--user', `${uid}:${group}`, container, 'node', '-e',
    'try{require("fs").openSync(process.argv[1],"r");process.stdout.write("readable")}catch(e){process.stdout.write(e.code)}', target]);
}
function stats(volume: string, paths: string[]): string {
  return docker(['run', '--rm', '--user', '0:0',
    '--mount', `type=volume,src=${volume},dst=${volumeRoot}`, runtimeImage,
    'stat', '-c', '%n %u:%g %a %F', ...paths]);
}
function peerProbe(container: string, uid: number, socket: string): { connected: boolean; closedWithinMs: number | null } {
  return JSON.parse(docker(['exec', '--user', `${uid}:${group}`, container,
    'node', '--experimental-strip-types', `${uidPath}/client.ts`, socket, 'peer-probe']));
}
function resultFrom(phases: [LivingPipelineReportV1, LivingPipelineReportV1],
  generated: readonly LivingCase[], cases: ExternalCampaignResult['cases'],
  partitionAttempt: LivingExternalCaseResultV4, unknown: number, reconciled: number,
  sinkRevision: string, sinkDecisions: number, attempted: number): ExternalCampaignResult {
  const coverage = [...new Set(cases.flatMap(item => item.result.coverage))].sort();
  return { format: 'aether.living-external-campaign/3', generated: generated.length, executed: cases.length,
    filtered: cases.filter(item => item.result.filtered).length,
    passed: cases.filter(item => item.result.passed).length, failed: cases.filter(item => !item.result.passed).length,
    attempted, partitionUnknown: unknown, reconciled, sinkDecisions, sinkWitnessRevision: sinkRevision,
    seeds: cases.map(item => item.input.seed), coverage, cases, partitionAttempt,
    faultActions: [], candidateRestarts: 1, workerTermination: 'SIGKILL',
    pipeline: { format: 'aether.living-restart-pipeline/1', phases, generated: phases[1].generated,
      executed: phases[1].executed, attemptedExecutions: attempted,
      failedAttempts: phases[0].failedAttempts + phases[1].failedAttempts,
      filteredAttempts: phases[0].filteredAttempts + phases[1].filteredAttempts,
      recoveries: phases[0].recoveries + phases[1].recoveries,
      seeds: phases[1].seeds, coverage: phases[1].coverage } };
}

const output = resolve(process.argv[2] ?? join(own, 'evidence', 'uid-custody-v1'));
if (existsSync(output)) throw new Error(`refusing to overwrite evidence: ${output}`);
mkdirSync(output, { recursive: true });
const runStarted = performance.now();
const scratch = mkdtempSync(join(tmpdir(), 'aether-uid-custody-'));
const names: string[] = [];
const prefix = `aether-uid-${randomUUID().slice(0, 8)}`;
const volume = `${prefix}-volume`;
const service = (short: string) => `${prefix}-${short}`;
let prepared: Awaited<ReturnType<typeof prepareExternal>> | null = null;
let volumeCreated = false;
try {
  prepared = await prepareExternal(join(scratch, 'private'), join(scratch, 'public'));
  const registrationMs = performance.now() - runStarted;
  const stopped = new Promise<void>(resolveDone => prepared!.witnessService.child.once('exit', () => resolveDone()));
  prepared.witnessService.child.kill('SIGTERM'); await stopped;
  const reg = prepared.registration;
  const regPath = p('public', 'registration.json');
  const witnessPrivate = p('witness', 'private'), sinkPrivate = p('sink', 'private');
  const candidatePrivate = p('candidate', 'private'), candidateState = p('candidate', 'state');
  const candidateLocal = p('candidate', 'local');
  const witnessSocket = p('witness', 'private', 'w.sock'), sinkSocket = p('sink', 'private', 's.sock');
  const witnessCandidateSocket = p('witness-access', 'candidate.sock');
  const witnessSinkSocket = p('witness-access', 'sink.sock');
  const sinkCandidateSocket = p('sink-access', 'candidate.sock');
  const gatewaySocket = p('candidate', 'local', 'gateway.sock');
  const workerSocket1 = p('candidate', 'local', 'worker1.sock');
  const workerSocket2 = p('candidate', 'local', 'worker2.sock');
  const directories: D[] = [
    dir(p('public'), 0, 0, 0o755), dir(p('bin'), 0, 0, 0o755),
    dir(p('witness'), 0, 0, 0o755), dir(witnessPrivate, ids.witness, ids.witness, 0o700),
    dir(p('witness', 'store'), ids.witness, ids.witness, 0o700),
    dir(p('witness-access'), ids.witness, group, 0o750),
    dir(p('sink'), 0, 0, 0o755), dir(sinkPrivate, ids.sink, ids.sink, 0o700),
    dir(p('sink', 'store'), ids.sink, ids.sink, 0o700),
    dir(p('sink-access'), ids.sink, group, 0o750),
    dir(p('candidate'), 0, 0, 0o755), dir(candidatePrivate, ids.candidate, ids.candidate, 0o700),
    dir(candidateState, ids.candidate, ids.candidate, 0o700),
    dir(candidateLocal, ids.candidate, ids.candidate, 0o700),
  ];
  const witnessKey = readFileSync(prepared.witnessKeyFile), sinkKey = readFileSync(prepared.sinkKeyFile);
  const witnessServiceConfig = { socketPath: witnessSocket, storageDir: p('witness', 'store'),
    keyFile: p('witness', 'private', 'key'), namespaces: [
      { kind: 'effect-scope', authorityId: 'operator:living-external', repositoryId: 'living-integrated-research',
        catalogDeploymentId: 'deployment:living-external', clockDomain: 'living-effect-clock/4' },
      { kind: 'sink-scope', authorityId: 'operator:living-external', anchor: reg.anchor,
        adapterArtifactDigest: externalFixture().policyBody.rules[0].adapterArtifactDigest },
    ] };
  const sinkServiceConfig = { format: 'aether.attested-sink-config/2', socketPath: sinkSocket,
    storageDir: p('sink', 'store'), authKeyFile: p('sink', 'private', 'auth-key'),
    signingKeyFile: p('sink', 'private', 'sign.pem'), anchor: reg.anchor,
    adapterArtifactDigest: externalFixture().policyBody.rules[0].adapterArtifactDigest,
    witnessSocketPath: witnessSinkSocket, witnessKeyFile: p('sink', 'private', 'witness-key'),
    witnessAuthorityId: 'operator:living-external' };
  const candidateConfig = (phase: 1 | 2) => ({ directory: candidateState,
    witnessSocket: witnessCandidateSocket, witnessKeyFile: p('candidate', 'private', 'witness-key'),
    gatewaySocket, sinkKeyFile: p('candidate', 'private', 'sink-key'),
    listenSocket: phase === 1 ? workerSocket1 : workerSocket2,
    pipelineDirectory: p('candidate', 'state', `pipeline-phase-${phase}`) });
  const files: F[] = [{ ...file(regPath, 0, readFileSync(prepared.registrationPath)), mode: 0o644 },
    file(p('witness', 'private', 'key'), ids.witness, witnessKey),
    file(p('witness', 'private', 'config.json'), ids.witness, witnessServiceConfig),
    file(p('sink', 'private', 'auth-key'), ids.sink, sinkKey),
    file(p('sink', 'private', 'witness-key'), ids.sink, witnessKey),
    file(p('sink', 'private', 'sign.pem'), ids.sink, readFileSync(join(dirname(prepared.sinkKeyFile), 'sign.pem'))),
    file(p('sink', 'private', 'config.json'), ids.sink, sinkServiceConfig),
    file(p('candidate', 'private', 'sink-key'), ids.candidate, sinkKey),
    file(p('candidate', 'private', 'witness-key'), ids.candidate, witnessKey),
    file(p('candidate', 'private', 'phase-1.json'), ids.candidate, candidateConfig(1)),
    file(p('candidate', 'private', 'phase-2.json'), ids.candidate, candidateConfig(2)),
  ];
  docker(['volume', 'create', volume]); volumeCreated = true;
  const provision = docker(['run', '--rm', '-i', '--user', '0:0',
    '--mount', `type=bind,src=${root},dst=${repo},readonly`,
    '--mount', `type=volume,src=${volume},dst=${volumeRoot}`, runtimeImage,
    'node', '--experimental-strip-types', `${uidPath}/setup.ts`], JSON.stringify({ directories, files }));
  docker(['run', '--rm', '--user', '0:0',
    '--mount', `type=bind,src=${root},dst=${repo},readonly`,
    '--mount', `type=volume,src=${volume},dst=${volumeRoot}`, builderImage,
    'gcc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    `${repo}/native/witness-peer/witness-peer.c`, '-o', p('bin', 'witness-peer')]);
  const witness = service('witness'); names.push(witness);
  launch(witness, volume, ids.witness, ['node', '--experimental-strip-types',
    `${repo}/src/fabric/witness-service-cli.ts`, '--config', p('witness', 'private', 'config.json')],
    'witness service ready');
  const witnessCandidateProxy = service('witness-candidate'); names.push(witnessCandidateProxy);
  proxy(witnessCandidateProxy, volume, ids.witness, witnessCandidateSocket, witnessSocket, ids.candidate, ids.witness);
  const witnessSinkProxy = service('witness-sink'); names.push(witnessSinkProxy);
  proxy(witnessSinkProxy, volume, ids.witness, witnessSinkSocket, witnessSocket, ids.sink, ids.witness);
  const sink = service('sink'); names.push(sink);
  launch(sink, volume, ids.sink, ['node', '--experimental-strip-types',
    `${repo}/src/fabric/attested-sink-service-cli.ts`, '--config', p('sink', 'private', 'config.json')],
    'attested sink service ready');
  const sinkProxy = service('sink-candidate'); names.push(sinkProxy);
  proxy(sinkProxy, volume, ids.sink, sinkCandidateSocket, sinkSocket, ids.candidate, ids.sink);
  const gateway1 = service('gateway-drop'); names.push(gateway1);
  launch(gateway1, volume, ids.candidate, ['node', '--experimental-strip-types', gatewayPath,
    gatewaySocket, sinkCandidateSocket, 'drop-first-response'], 'gateway ready');
  const worker1 = service('worker1'); names.push(worker1);
  launch(worker1, volume, ids.candidate, ['node', '--experimental-strip-types', workerPath,
    regPath, p('candidate', 'private', 'phase-1.json')], 'external worker ready');
  const runtimeIdentities = Object.fromEntries([[worker1, ids.candidate], [sink, ids.sink],
    [witness, ids.witness], [witnessCandidateProxy, ids.witness], [witnessSinkProxy, ids.witness],
    [sinkProxy, ids.sink], [gateway1, ids.candidate]].map(([name, expectedUid]) => {
    const actual = docker(['exec', name as string, 'id', '-u']) + ':' + docker(['exec', name as string, 'id', '-g']);
    if (actual !== `${expectedUid}:${group}`) throw new Error(`runtime UID/GID mismatch: ${name} ${actual}`);
    return [name, actual];
  }));
  const ownership = stats(volume, [p('witness', 'private', 'key'), p('witness', 'store'),
    p('sink', 'private', 'sign.pem'), p('sink', 'store'), p('candidate', 'private', 'sink-key'),
    candidateState, witnessCandidateSocket, witnessSinkSocket, sinkCandidateSocket]);
  const refusals = {
    candidateWitnessOwnerKey: access(worker1, ids.candidate, p('witness', 'private', 'key')),
    candidateSinkSigningKey: access(worker1, ids.candidate, p('sink', 'private', 'sign.pem')),
    sinkCandidateKey: access(sink, ids.sink, p('candidate', 'private', 'sink-key')),
    witnessSinkSigningKey: access(witness, ids.witness, p('sink', 'private', 'sign.pem')),
    wrongPeerWitness: peerProbe(worker1, 10004, witnessCandidateSocket),
    rightPeerWitness: peerProbe(worker1, ids.candidate, witnessCandidateSocket),
    wrongPeerSink: peerProbe(worker1, 10004, sinkCandidateSocket),
    rightPeerSink: peerProbe(worker1, ids.candidate, sinkCandidateSocket),
  };
  for (const [key, value] of Object.entries(refusals))
    if (key.startsWith('wrongPeer') ? typeof value === 'object' && value.connected
      && value.closedWithinMs !== null && value.closedWithinMs < 500
      : key.startsWith('rightPeer') ? typeof value === 'object' && value.connected
        && value.closedWithinMs === null : value === 'EACCES')
      continue;
    else throw new Error(`custody permission refusal missed: ${key}=${value}`);
  const generated = reg.generated;
  const input = generated.find(item => item.scenario === 'faulted-json-network' && item.ordinal === 0);
  if (!input) throw new Error('signed faulted case absent');
  const cmd = (op: string, item: LivingCase, kind?: string) => ({ op, input: item, ...(kind ? { kind } : {}) });
  const before = probe(worker1, regPath);
  if (before.revision !== '0') throw new Error('sink witness already advanced');
  const executionStarted = performance.now();
  let attempted = 1;
  const partitionAttempt = client(worker1, workerSocket1, cmd('run-case', input, 'original')) as LivingExternalCaseResultV4;
  if (partitionAttempt.passed || partitionAttempt.filtered || partitionAttempt.externalEffects.indeterminate !== 1)
    throw new Error('lost reply failed to preserve unknown outcome');
  for (let n = 0; n < 50 && docker(['inspect', '-f', '{{.State.Running}}', gateway1]) === 'true'; n++) sleep(100);
  if (docker(['inspect', '-f', '{{.State.Running}}', gateway1]) !== 'false') throw new Error('gateway did not partition');
  const prehealHead = probe(worker1, regPath);
  if (prehealHead.revision !== '1') throw new Error('sink did not commit before reply loss');
  writeFileSync(join(output, 'partition-preheal-sink-head.json'), JSON.stringify(prehealHead));
  const suffix = caseDigest(input).split(':').at(-1)!;
  evidenceCopy(worker1, p('candidate', 'state', 'external-effect-journals', suffix, 'effects-v4.json'),
    join(output, 'partition-preheal-effect.json'));
  const phase1 = client(worker1, workerSocket1, { op: 'finalize' }) as LivingPipelineReportV1;
  docker(['kill', worker1]);
  const worker2 = service('worker2'); names.push(worker2);
  launch(worker2, volume, ids.candidate, ['node', '--experimental-strip-types', workerPath,
    regPath, p('candidate', 'private', 'phase-2.json')], 'external worker ready');
  const during = client(worker2, workerSocket2, cmd('recover-case', input)) as { reconciled: number; unknown: number };
  if (during.reconciled !== 0 || during.unknown !== 1) throw new Error('partition status was guessed');
  const gateway2 = service('gateway-forward'); names.push(gateway2);
  launch(gateway2, volume, ids.candidate, ['node', '--experimental-strip-types', gatewayPath,
    gatewaySocket, sinkCandidateSocket, 'forward'], 'gateway ready');
  const healed = client(worker2, workerSocket2, cmd('recover-case', input)) as { reconciled: number; unknown: number };
  if (healed.reconciled !== 1 || healed.unknown !== 0) throw new Error('signed rejoin status failed');
  const observed = new Map<string, { input: LivingCase; result: LivingExternalCaseResultV4 }>();
  attempted++;
  const recovered = client(worker2, workerSocket2, cmd('run-case', input, 'retry')) as LivingExternalCaseResultV4;
  if (!recovered.passed || recovered.filtered || recovered.externalEffects.indeterminate) throw new Error('recovered case failed');
  observed.set(caseDigest(input), { input, result: recovered });
  attempted++;
  const duplicate = client(worker2, workerSocket2, cmd('run-case', input, 'duplicate')) as LivingExternalCaseResultV4;
  if (domainDigest('aether.living-external-case-result/4', duplicate)
    !== domainDigest('aether.living-external-case-result/4', recovered)) throw new Error('duplicate changed result');
  for (const next of generated) {
    if (caseDigest(next) === caseDigest(input)) continue;
    attempted++;
    const result = client(worker2, workerSocket2, cmd('run-case', next, 'original')) as LivingExternalCaseResultV4;
    if (!result.passed || result.filtered || result.externalEffects.indeterminate)
      throw new Error(`case failed: ${next.seed}`);
    observed.set(caseDigest(next), { input: next, result });
  }
  const cases = generated.map(next => { const value = observed.get(caseDigest(next));
    if (!value) throw new Error('signed case omitted'); return value; });
  const phase2 = client(worker2, workerSocket2, { op: 'finalize' }) as LivingPipelineReportV1;
  const finalHead = probe(worker2, regPath);
  const decisions = finalHead.journal ? (JSON.parse(finalHead.journal) as { decisions: unknown[] }).decisions.length : 0;
  const result = resultFrom([phase1, phase2], generated, cases, partitionAttempt,
    during.unknown, healed.reconciled, finalHead.revision, decisions, attempted);
  const executionMs = performance.now() - executionStarted;
  evidenceCopy(worker2, p('sink', 'store'), join(output, 'sink-store'));
  evidenceCopy(worker2, p('witness', 'store'), join(output, 'witness-store'));
  evidenceCopy(worker2, p('candidate', 'state', 'external-effect-journals'), join(output, 'broker-journals'));
  evidenceCopy(worker2, p('candidate', 'state', 'pipeline-phase-1'), join(output, 'pipeline', 'phase-1'));
  evidenceCopy(worker2, p('candidate', 'state', 'pipeline-phase-2'), join(output, 'pipeline', 'phase-2'));
  copyFileSync(prepared.registrationPath, join(output, 'registration.json'));
  auditExternalRaw(output, result, reg as ExternalRegistration);
  const sources = [join(own, 'campaign.ts'), join(own, 'setup.ts'), join(own, 'client.ts'),
    join(own, 'probe.ts'), join(own, 'verify.ts'), join(own, 'Dockerfile.builder'),
    join(root, 'native/witness-peer/witness-peer.c'),
    join(root, 'src/fabric/witness-service-cli.ts'), join(root, 'src/fabric/attested-sink-service-cli.ts'),
    join(root, 'roadmap/v4/research/microworld-external/worker.ts'),
    join(root, 'roadmap/v4/research/microworld-external/gateway.ts'),
    join(root, 'roadmap/v4/research/microworld-external/fixture.ts')];
  const machine = { dockerServer: docker(['version', '--format', '{{.Server.Version}}']),
    runtimeImage: docker(['image', 'inspect', '-f', '{{index .RepoDigests 0}}', runtimeImage]),
    builderImage: docker(['image', 'inspect', '-f', '{{.Id}}', builderImage]),
    nativeGatewaySha256: docker(['run', '--rm', '--user', '0:0',
      '--mount', `type=volume,src=${volume},dst=${volumeRoot}`, runtimeImage,
      'sha256sum', p('bin', 'witness-peer')]).split(' ')[0],
    kernel: docker(['exec', worker2, 'uname', '-a']), node: docker(['exec', worker2, 'node', '--version']),
    gcc: docker(['run', '--rm', builderImage, 'gcc', '--version']).split('\n')[0] };
  const report = { format: 'aether.living-external-uid-custody/1',
    sourceBaseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    provision: JSON.parse(provision), machine, identities: ids, sharedGroup: group,
    sameVmRootController: true, independentOperators: false, crossMachine: false,
    ownership, runtimeIdentities, refusals,
    measurements: { registrationMs, signedExecutionMs: executionMs,
      signedExecutedCasesPerSecond: result.executed / (executionMs / 1000),
      signedAttemptedExecutionsPerSecond: result.attempted / (executionMs / 1000),
      totalThroughAuditMs: performance.now() - runStarted },
    authorizationDigest: domainDigest('aether.living-effect-authorization/4', reg.authorization),
    candidateRoot: reg.authorization.executionManifest.astRoot,
    generated: result.generated, executed: result.executed, filtered: result.filtered,
    attempted: result.attempted, passed: result.passed, failed: result.failed,
    partitionUnknown: result.partitionUnknown, reconciled: result.reconciled,
    sinkDecisions: result.sinkDecisions, sinkWitnessRevision: result.sinkWitnessRevision,
    coverage: result.coverage, seeds: result.seeds,
    sourceSha256: Object.fromEntries(sources.map(path => [path.slice(root.length + 1), sha(path)])), result };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ output, generated: result.generated, executed: result.executed,
    filtered: result.filtered, attempted, sinkDecisions: decisions, audit: 'passed' }) + '\n');
} catch (error) {
  for (const name of names) {
    try { process.stderr.write(`${name} ${docker(['inspect', '-f', '{{.State.Status}}', name])}: ${docker(['logs', name])}\n`); }
    catch { /* best-effort diagnostics */ }
  }
  throw error;
} finally {
  for (const name of names.reverse()) { try { docker(['rm', '-f', name]); } catch {} }
  if (volumeCreated) { try { docker(['volume', 'rm', '-f', volume]); } catch {} }
  if (prepared?.witnessService.child.exitCode === null) prepared.witnessService.child.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
}
