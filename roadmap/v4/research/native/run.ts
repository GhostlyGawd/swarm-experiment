import { execFileSync } from 'node:child_process';
import { cpus, totalmem, release, platform, arch, loadavg } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileNative, compileBoot, conformance, bootSample, summary, sha256, DIRECTORY } from './harness.ts';

const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--output')) throw new Error('usage: run.ts [--output directory]');
const output = resolve(args[1] ?? '.aether-store/research/native-r02');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const qualificationPath = 'docs/implementation/v4/decisions/D07-native-qualification-profile.json';
const qualificationBytes = readFileSync(join(root, qualificationPath));
const qualificationProfile = JSON.parse(qualificationBytes.toString('utf8'));
mkdirSync(output, { recursive: true });
const native = compileNative(output);
const correctness = conformance(native.driver);
writeFileSync(join(output, 'conformance.json'), JSON.stringify(correctness, null, 2) + '\n');
const fallback = JSON.parse(execFileSync(native.driver, [], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
writeFileSync(join(output, 'fallback-samples.json'), JSON.stringify(fallback, null, 2) + '\n');
let bootConfiguration: ReturnType<typeof compileBoot> | null = null, bootError: string | null = null;
const boots: Array<Record<string, number | string>> = [];
try {
  bootConfiguration = compileBoot(output);
  for (let trial = 0; trial < 20; trial++) boots.push({ trial, ...await bootSample(bootConfiguration.boot, bootConfiguration.image) });
} catch (error) { bootError = String(error); }
writeFileSync(join(output, 'boot-samples.json'), JSON.stringify({ samples: boots, error: bootError }, null, 2) + '\n');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourcePaths = [
  ...['lower.ts', 'harness.ts', 'run.ts', 'driver.c', 'boot.c', 'start.S', 'kernel.ld', 'hypervisor.entitlements'].map(path => `roadmap/v4/research/native/${path}`),
  ...git('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src').split('\0').filter(Boolean),
];
const sources = [...new Set(sourcePaths)].sort().map(path => ({ path, digest: sha256(readFileSync(join(root, path))) }));
const artifacts = readdirSync(output).filter(name => name !== 'manifest.json').sort().map(name => ({ path: name, bytes: readFileSync(join(output, name)).byteLength, digest: sha256(readFileSync(join(output, name))) }));
const individual = summary(fallback.fullFlowIndividualNs);
const mainBoot = boots.length ? summary(boots.map(sample => Number(sample.mainToResponseNs))) : null;
const processBoot = boots.length ? summary(boots.map(sample => Number(sample.processLaunchToResponseNs))) : null;
const footprint = boots.length ? summary(boots.map(sample => Number(sample.hostProcessPeakRssBytes))) : null;
const guestFootprint = boots.length ? summary(boots.map(sample => Number(sample.guestMappedBytes))) : null;
const manifest = {
  format: 'aether.native-feasibility/2', specificationVersion: '0.1.0', createdAt: new Date().toISOString(),
  qualificationProfile: { path: qualificationPath, digest: sha256(qualificationBytes), value: qualificationProfile },
  subjectCommit: git('rev-parse', 'HEAD'), workingTreeDirty: git('status', '--porcelain').length > 0,
  sourceDigest: sha256(JSON.stringify(sources)), sources,
  environment: { os: platform(), osRelease: release(), architecture: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramBytes: totalmem(), loadAverage: loadavg(), node: process.version, compiler: native.compiler, hypervisor: 'Apple Hypervisor.framework (EL1 AArch64 guest)', hypervisorSupported: bootConfiguration !== null, target: 'aarch64-none-elf (guest) / arm64-apple-darwin (host)', ...(bootConfiguration ? { linkerVersion: bootConfiguration.linkerVersion, hostSignature: bootConfiguration.hostSignature } : {}) },
  abi: native.abi, astRoots: native.astRoots,
  workload: { id: 'checked-i64-fee-and-fallback/1', conformanceCases: correctness.cases.length, seed: correctness.seed, bootInputs: ['1000', '7'], expectedBootResult: { value: '12', status: 0 }, requestedBootTrials: 20, completedBootTrials: boots.length, fallbackWarmup: fallback.warmup, fallbackBatchIterations: fallback.batchIterations, fallbackTrials: 30, fallbackIndividualTrials: 2000, bootWarmup: 0, cache: 'Fresh host process and VM per trial; OS file cache is uncontrolled. First launch retained.', drivers: ['HVC result mailbox'], guestCodePermissions: 'one read/execute page; remaining mapped memory read/write, nonexecutable', excludedFeatures: ['native mutable heap/alias migration', 'external-effect broker', 'asynchronous repair queue', 'proof-carrying native lowering', 'network/storage/device drivers', 'bare-metal deployment qualification'] },
  results: {
    conformance: { verdict: 'pass', cases: correctness.cases.length, fallback: correctness.fallback },
    dispatchBatchNsPerCall: { ...summary(fallback.dispatchBatchNsPerCall), scope: 'Warm amortized path-selection diagnostic; begins after a fault flag is supplied.' },
    fullFlowBatchNsPerCall: { ...summary(fallback.fullFlowBatchNsPerCall), scope: 'Warm amortized pure fixture including speculative calculation, status/invariant guard, frame restoration and conservative result.' },
    timerPairNs: summary(fallback.timerPairNs),
    fallback50ns: { unit: 'ns', threshold: 50, clockTickNs: fallback.tickNs, observedIndividual: individual, verdict: individual.max > 50 ? 'fail' : 'inconclusive', reason: 'Uncorrected individual timed brackets include observer overhead. Quantized zero-duration samples and this bounded fixture cannot establish the full runtime hard maximum; amortized means never qualify the 50 ns requirement.' },
    boot1ms: { unit: 'ns', threshold: 1000000, mainToResponse: mainBoot, processLaunchToFirstResponse: processBoot, verdict: bootError || !mainBoot ? 'not_measured' : mainBoot.max > 1000000 ? 'fail' : 'inconclusive', reason: 'Approved boundary excludes controller-process launch. Main-to-response includes fresh guest allocation/image load and VM/vCPU creation, but a repeated fresh-guest campaign on an already-running controller is still required; this fresh-process prototype cannot alone qualify that profile.' },
    footprint2mb: { unit: 'bytes', threshold: 2000000, hostProcessPeakRss: footprint, guestResidentUpperBound: guestFootprint, guestMappedBytes: boots[0]?.guestMappedBytes ?? null, guestImageBytes: boots[0]?.guestImageBytes ?? null, verdict: bootError || !guestFootprint ? 'not_measured' : guestFootprint.max <= 2000000 ? 'pass_bounded_profile' : 'fail', reason: 'User-approved scope is guest resident memory. The fully zero-initialized mapped allocation bounds resident guest memory for this fixed prototype; controller RSS and unmeasured hypervisor memory are separate diagnostics. Full runtime/driver qualification remains open.' },
  },
  bootError, artifacts,
  limitations: ['Finite samples do not establish universal latency guarantees.', 'No unbounded Int-to-i64 coercion; unsupported native AST features reject.', 'C/LLVM, linker, Darwin, firmware and Hypervisor.framework are in the trusted computing base.', 'This native feasibility prototype does not complete FR-3.5, FR-3.7, FR-3.10 or FR-4.5.'],
};
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, subjectCommit: manifest.subjectCommit, conformanceCases: correctness.cases.length, results: manifest.results, bootError }, null, 2));
