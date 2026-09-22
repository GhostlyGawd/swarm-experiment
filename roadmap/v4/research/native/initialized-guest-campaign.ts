/** Protocol v2: preserve protocol v1 source and evidence unchanged. */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileBoot, compileNative, conformance, DIRECTORY, sha256, summary } from './harness.ts';

export interface FreshGuestProfile {
  format: 'aether.fresh-guest-campaign/1'; version: string; approvedProfile: string;
  trialCount: number; guestWarmupCount: number; controllerProcesses: number; parallelGuests: number;
  controllerTimeoutMilliseconds: number; guestMappedBytes: number;
  bootMaximumNanoseconds: number; guestResidentMaximumBytes: number;
  [key: string]: unknown;
}
interface Registration {
  format: 'aether.fresh-guest-registration/1'; registeredAt: string; subjectCommit: string; workingTreeDirty: boolean;
  profile: FreshGuestProfile; profileDigest: string; approvedProfile: unknown; approvedProfileDigest: string;
  sourceFiles: Array<{ path: string; digest: string }>;
}
interface Admission { format: 'aether.fresh-guest-admission/1'; completedAt: string; registrationDigest: string; conformanceCases: number; compiler: string; linkerVersion: string; abi: string; astRoots: unknown; artifacts: Array<{ path: string; bytes: number; digest: string }> }
export interface ControllerExecution { exitCode: number | null; signal: string | null; timedOut: boolean; processLaunchToReadyNs: number | null; events: Array<Record<string, unknown>>; stderr: string; error: string | null }
const root = resolve(DIRECTORY, '../../../..');
const profilePath = join(DIRECTORY, 'initialized-guest-campaign-profile.json');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

export function validateFreshGuestProfile(profile: FreshGuestProfile): void {
  if (profile.format !== 'aether.fresh-guest-campaign/1' || profile.version !== '2.0.0' || !Number.isSafeInteger(profile.trialCount) || profile.trialCount < 1 || profile.trialCount > 100000 || profile.guestWarmupCount !== 0 || profile.controllerProcesses !== 1 || profile.parallelGuests !== 1 || profile.bootMaximumNanoseconds !== 1000000 || profile.guestResidentMaximumBytes !== 2000000 || profile.guestMappedBytes !== 65536 || !Number.isSafeInteger(profile.controllerTimeoutMilliseconds) || profile.controllerTimeoutMilliseconds < 1 || profile.controllerTimeoutMilliseconds > 60000) throw new Error('invalid or weakened fresh-guest campaign profile');
  const bootstrap = profile.hypervisorBootstrap as Record<string, unknown> | undefined;
  if (!bootstrap || typeof bootstrap !== 'object' || Object.keys(bootstrap).length !== 6 || bootstrap.emptyVmContextsCreated !== 1 || bootstrap.emptyVmContextsDestroyed !== 1 || bootstrap.vcpusCreated !== 1 || bootstrap.vcpusDestroyed !== 1 || bootstrap.guestMappings !== 0 || bootstrap.guestExecutions !== 0) throw new Error('unsupported hypervisor bootstrap profile');
}
export function registerFreshGuestCampaign(directory: string): Registration {
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('campaign output must be a new empty directory; historical results are immutable');
  mkdirSync(directory, { recursive: true });
  const profileBytes = readFileSync(profilePath), profile = JSON.parse(profileBytes.toString('utf8')) as FreshGuestProfile;
  validateFreshGuestProfile(profile);
  const approvedBytes = readFileSync(join(root, profile.approvedProfile));
  const approved = JSON.parse(approvedBytes.toString('utf8'));
  if (approved.format !== 'aether.native-qualification-profile/1' || approved.version !== '1.0.0' || approved.boot.maximumMilliseconds !== 1 || approved.memory.maximumBytes !== 2000000 || approved.boot.reuseExistingGuest !== false) throw new Error('approved native qualification profile mismatch');
  const paths = [
    ...['initialized-guest-campaign.c', 'initialized-guest-campaign.ts', 'initialized-guest-campaign-profile.json', 'harness.ts', 'lower.ts', 'driver.c', 'boot.c', 'start.S', 'kernel.ld', 'hypervisor.entitlements'].map(path => `roadmap/v4/research/native/${path}`),
    ...git('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src/tier1', 'src/tier2', 'src/tier3').split('\0').filter(Boolean),
  ];
  const registration: Registration = {
    format: 'aether.fresh-guest-registration/1', registeredAt: new Date().toISOString(), subjectCommit: git('rev-parse', 'HEAD'), workingTreeDirty: git('status', '--porcelain').length > 0,
    profile, profileDigest: sha256(profileBytes), approvedProfile: approved, approvedProfileDigest: sha256(approvedBytes),
    sourceFiles: [...new Set(paths)].sort().map(path => ({ path, digest: sha256(readFileSync(join(root, path))) })),
  };
  // Registration is written before compilation/admission and before any guest runs.
  writeFileSync(join(directory, 'preregistration.json'), json(registration), { flag: 'wx' });
  return registration;
}
export function prepareFreshGuestCampaign(directory: string): Admission {
  const registrationBytes = readFileSync(join(directory, 'preregistration.json'));
  const registration = JSON.parse(registrationBytes.toString('utf8')) as Registration;
  validateFreshGuestProfile(registration.profile);
  if (existsSync(join(directory, 'admission.json')) || existsSync(join(directory, 'attempt.json'))) throw new Error('campaign admission already exists');
  const native = compileNative(directory), correctness = conformance(native.driver), boot = compileBoot(directory);
  writeFileSync(join(directory, 'conformance.json'), json(correctness), { flag: 'wx' });
  const controller = join(directory, 'initialized-guest-campaign');
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', join(DIRECTORY, 'initialized-guest-campaign.c'), '-framework', 'Hypervisor', '-o', controller]);
  execFileSync('clang', ['-O2', '-S', join(DIRECTORY, 'initialized-guest-campaign.c'), '-o', join(directory, 'initialized-guest-campaign.s')]);
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', join(DIRECTORY, 'hypervisor.entitlements'), controller], { stdio: 'pipe' });
  execFileSync('codesign', ['--verify', '--strict', controller], { stdio: 'pipe' });
  const artifacts = readdirSync(directory).filter(name => name !== 'preregistration.json').sort().map(path => ({ path, bytes: readFileSync(join(directory, path)).byteLength, digest: sha256(readFileSync(join(directory, path))) }));
  const admission: Admission = { format: 'aether.fresh-guest-admission/1', completedAt: new Date().toISOString(), registrationDigest: sha256(registrationBytes), conformanceCases: correctness.cases.length, compiler: native.compiler, linkerVersion: boot.linkerVersion, abi: native.abi, astRoots: native.astRoots, artifacts };
  writeFileSync(join(directory, 'admission.json'), json(admission), { flag: 'wx' });
  return admission;
}
function decimal(value: unknown): bigint { if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid raw counter'); return BigInt(value); }
/** The whole preregistered population is required. Means and trimmed samples
 * cannot turn a maximum-bound miss or incomplete campaign into success. */
export function assessFreshGuestCampaign(profile: FreshGuestProfile, execution: ControllerExecution) {
  validateFreshGuestProfile(profile);
  const reasons: string[] = [], events = execution.events;
  const ready = events.filter(event => event.kind === 'controller_ready');
  const complete = events.filter(event => event.kind === 'campaign_complete');
  const samples = events.filter(event => event.kind === 'guest_sample');
  if (execution.error || execution.exitCode !== 0 || execution.signal || execution.timedOut) reasons.push('controller execution failed or timed out');
  if (ready.length !== 1 || events[0]?.kind !== 'controller_ready' || complete.length !== 1 || events.at(-1)?.kind !== 'campaign_complete') reasons.push('missing, duplicate or misplaced controller lifecycle records');
  if (events.length !== samples.length + 2 || samples.length !== profile.trialCount) reasons.push('campaign does not contain every preregistered guest');
  const controller = ready[0], finished = complete[0];
  if (controller && (controller.format !== 'aether.fresh-guest-controller/2' || controller.requestedTrials !== profile.trialCount || controller.createdVmsBeforeCampaign !== 1 || controller.destroyedVmsBeforeCampaign !== 1 || controller.createdVcpusBeforeCampaign !== 1 || controller.destroyedVcpusBeforeCampaign !== 1 || controller.executedGuestsBeforeCampaign !== 0 || controller.guestBytesBeforeCampaign !== 0 || typeof controller.hypervisorInitializationNs !== 'number' || controller.hypervisorInitializationNs < 0 || !Number.isSafeInteger(controller.pid) || (controller.pid as number) < 1 || !Number.isSafeInteger(controller.timebaseNumer) || (controller.timebaseNumer as number) < 1 || !Number.isSafeInteger(controller.timebaseDenom) || (controller.timebaseDenom as number) < 1)) reasons.push('controller preinitialization or timer metadata is invalid');
  if (finished && ['completedTrials', 'createdVms', 'destroyedVms', 'createdVcpus', 'destroyedVcpus', 'unmappedGuests'].some(key => finished[key] !== profile.trialCount)) reasons.push('guest creation/destruction counts do not match the preregistration');
  const durations: number[] = [], resident: number[] = [], upperBounds: number[] = [], controllerRss: number[] = [], peakRss: number[] = [];
  const timedTrials: Array<{ trial: number; nanoseconds: number }> = [];
  let validTrials = 0;
  const guestIds = new Set<string>();
  for (const [index, sample] of samples.entries()) {
    try {
      if (!controller || sample.trial !== index || sample.guestId !== `${controller.pid}:${index}` || guestIds.has(sample.guestId as string)) throw new Error('missing/repeated/reordered guest identity');
      guestIds.add(sample.guestId as string);
      if (sample.gross !== String(1000 + 200 * index) || sample.adjustment !== '7' || sample.expected !== String(12 + index) || sample.actual !== sample.expected || sample.status !== '0' || sample.responseValidated !== true || sample.freshVmCreated !== true || sample.freshVcpuCreated !== true || sample.cleanupSucceeded !== true || sample.errorStage !== null || sample.errorCode !== '0' || sample.exceptionReason !== 1 || decimal(sample.syndrome) >> 26n !== 0x16n) throw new Error('guest response, freshness or cleanup invalid');
      const start = decimal(sample.startTick), end = decimal(sample.validatedResponseTick), ticks = decimal(sample.durationTicks);
      if (end <= start || end - start !== ticks) throw new Error('invalid timing interval');
      const duration = Number(ticks) * Number(controller.timebaseNumer) / Number(controller.timebaseDenom);
      if (!Number.isFinite(duration) || typeof sample.freshGuestToValidatedResponseNs !== 'number' || Math.abs(duration - sample.freshGuestToValidatedResponseNs) > 0.01) throw new Error('timing conversion does not match raw counters');
      durations.push(duration); timedTrials.push({ trial: index, nanoseconds: duration });
      if (sample.guestMappedBytes !== profile.guestMappedBytes || sample.guestResidentPeakUpperBoundBytes !== profile.guestMappedBytes || sample.guestResidentObservedBytes !== profile.guestMappedBytes || typeof sample.guestImageBytes !== 'number' || sample.guestImageBytes <= 0 || sample.guestImageBytes !== controller.imageBytes) throw new Error('guest residency/footprint evidence incomplete');
      resident.push(sample.guestResidentObservedBytes as number); upperBounds.push(sample.guestResidentPeakUpperBoundBytes as number);
      if (typeof sample.controllerCurrentRssBytes === 'number' && sample.controllerCurrentRssBytes > 0) controllerRss.push(sample.controllerCurrentRssBytes);
      if (typeof sample.controllerPeakRssBytes === 'number' && sample.controllerPeakRssBytes > 0) peakRss.push(sample.controllerPeakRssBytes);
      validTrials++;
    } catch (error) { reasons.push(`trial ${index}: ${String(error)}`); }
  }
  const validCampaign = reasons.length === 0 && durations.length === profile.trialCount;
  const bootMaximum = durations.length ? Math.max(...durations) : null, memoryMaximum = upperBounds.length ? Math.max(...upperBounds) : null;
  const bootVerdict = !validCampaign ? 'invalid_or_incomplete' : bootMaximum! <= profile.bootMaximumNanoseconds ? 'pass' : 'fail';
  const memoryVerdict = !validCampaign ? 'invalid_or_incomplete' : memoryMaximum! <= profile.guestResidentMaximumBytes ? 'pass' : 'fail';
  return {
    validCampaign, requestedTrials: profile.trialCount, recordedTrials: samples.length, validTrials, reasons,
    boot: { verdict: bootVerdict, thresholdNanoseconds: profile.bootMaximumNanoseconds, summaryNanoseconds: durations.length ? summary(durations) : null, misses: timedTrials.filter(sample => sample.nanoseconds > profile.bootMaximumNanoseconds) },
    guestMemory: { verdict: memoryVerdict, thresholdBytes: profile.guestResidentMaximumBytes, observedResidentBytes: resident.length ? summary(resident) : null, peakUpperBoundBytes: memoryMaximum },
    diagnostics: { processLaunchToControllerReadyNs: execution.processLaunchToReadyNs, hypervisorInitializationNs: controller?.hypervisorInitializationNs ?? null, controllerCurrentRssBytes: controllerRss.length ? summary(controllerRss) : null, controllerPeakRssBytes: peakRss.length ? summary(peakRss) : null, imageBytes: controller?.imageBytes ?? null, hostHypervisorKernelOverheadBytes: null, hostHypervisorKernelOverheadReason: 'Not directly measured; excluded by the approved guest-resident-memory profile.' },
    qualification: validCampaign && bootVerdict === 'pass' && memoryVerdict === 'pass' ? 'bounded_campaign_pass' : 'not_qualified',
    scope: 'One preregistered scalar guest campaign on the named host. This result does not complete the native/unikernel implementation or prove universal latency bounds.',
  };
}
async function executeController(directory: string, profile: FreshGuestProfile): Promise<ControllerExecution> {
  const rawPath = join(directory, 'raw.jsonl'), stderrPath = join(directory, 'stderr.txt');
  writeFileSync(rawPath, '', { flag: 'wx' }); writeFileSync(stderrPath, '', { flag: 'wx' });
  return new Promise(resolveExecution => {
    const started = process.hrtime.bigint();
    const child = spawn(join(directory, 'initialized-guest-campaign'), [join(directory, 'kernel.bin'), String(profile.trialCount)]);
    const result: ControllerExecution = { exitCode: null, signal: null, timedOut: false, processLaunchToReadyNs: null, events: [], stderr: '', error: null };
    let buffer = '', bytes = 0;
    const timer = setTimeout(() => { result.timedOut = true; child.kill('SIGKILL'); }, profile.controllerTimeoutMilliseconds);
    child.stdout.on('data', chunk => {
      appendFileSync(rawPath, chunk); bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { result.error = 'controller output exceeded bounded capture'; child.kill('SIGKILL'); return; }
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n'); if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const event = JSON.parse(line) as Record<string, unknown>; if (event.kind === 'controller_ready' && result.processLaunchToReadyNs === null) result.processLaunchToReadyNs = Number(process.hrtime.bigint() - started); result.events.push(event); }
        catch { result.error = 'invalid controller JSONL'; child.kill('SIGKILL'); }
      }
    });
    child.stderr.on('data', chunk => { appendFileSync(stderrPath, chunk); if (result.stderr.length < 16384) result.stderr += String(chunk); });
    child.on('error', error => { result.error = String(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); result.exitCode = code; result.signal = signal; if (buffer.length) result.error = 'truncated controller record'; resolveExecution(result); });
  });
}
export async function runFreshGuestCampaign(directory: string) {
  const registrationBytes = readFileSync(join(directory, 'preregistration.json')), admissionBytes = readFileSync(join(directory, 'admission.json'));
  const registration = JSON.parse(registrationBytes.toString('utf8')) as Registration, admission = JSON.parse(admissionBytes.toString('utf8')) as Admission;
  validateFreshGuestProfile(registration.profile);
  if (sha256(readFileSync(join(root, registration.profile.approvedProfile))) !== registration.approvedProfileDigest) throw new Error('approved profile changed after registration');
  if (admission.registrationDigest !== sha256(registrationBytes) || admission.conformanceCases !== 1345) throw new Error('campaign admission does not bind preregistered workload');
  for (const source of registration.sourceFiles) if (sha256(readFileSync(join(root, source.path))) !== source.digest) throw new Error(`source changed after registration: ${source.path}`);
  for (const artifact of admission.artifacts) if (sha256(readFileSync(join(directory, artifact.path))) !== artifact.digest) throw new Error(`admitted artifact changed: ${artifact.path}`);
  const attempt = { format: 'aether.fresh-guest-attempt/1', startedAt: new Date().toISOString(), registrationDigest: sha256(registrationBytes), admissionDigest: sha256(admissionBytes), loadAverageBefore: loadavg() };
  writeFileSync(join(directory, 'attempt.json'), json(attempt), { flag: 'wx' });
  const execution = await executeController(directory, registration.profile);
  writeFileSync(join(directory, 'execution.json'), json(execution), { flag: 'wx' });
  const assessment = assessFreshGuestCampaign(registration.profile, execution);
  const report = { format: 'aether.fresh-guest-report/1', completedAt: new Date().toISOString(), registrationDigest: sha256(registrationBytes), admissionDigest: sha256(admissionBytes), rawDigest: sha256(readFileSync(join(directory, 'raw.jsonl'))), executionDigest: sha256(readFileSync(join(directory, 'execution.json'))), approvedProfileDigest: registration.approvedProfileDigest, environment: { os: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramBytes: totalmem(), node: process.version, loadAverageBefore: attempt.loadAverageBefore, loadAverageAfter: loadavg(), isolation: 'Ambient machine; no exclusive CPU/core reservation or controlled release-isolation claim.' }, assessment };
  writeFileSync(join(directory, 'report.json'), json(report), { flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output, ...extra] = process.argv.slice(2);
  if (!output || extra.length || !['register', 'run'].includes(command)) throw new Error('usage: initialized-guest-campaign.ts register|run OUTPUT_DIRECTORY');
  const directory = resolve(output);
  if (command === 'register') { registerFreshGuestCampaign(directory); prepareFreshGuestCampaign(directory); console.log(json({ registered: directory, guestExecutions: 0 })); }
  else { const report = await runFreshGuestCampaign(directory); console.log(json(report)); if (report.assessment.qualification !== 'bounded_campaign_pass') process.exitCode = 1; }
}
