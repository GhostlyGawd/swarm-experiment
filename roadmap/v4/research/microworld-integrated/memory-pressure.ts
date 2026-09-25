/** Independent OS RSS observation around one signed living-campaign case. */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LivingEffectCaseResultV2 } from '../../../../src/tier3/living-campaign.ts';
import type { Digest } from '../../../../src/fabric/identity.ts';

const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'memory-worker.ts');
export interface PhysicalMemoryPressureObservationV1 {
  readonly format: 'aether.living-physical-memory-pressure/1';
  readonly workerPid: number;
  readonly caseDigest: Digest;
  readonly requestedBytes: number;
  readonly touchStrideBytes: number;
  readonly minimumOsRssDeltaBytes: number;
  readonly osRssBaselineBytes: number;
  readonly osRssPressuredBytes: number;
  readonly osRssAfterCaseBytes: number;
  readonly workerRssBaselineBytes: number;
  readonly workerRssPressuredBytes: number;
  readonly workerRssAfterCaseBytes: number;
  readonly touchedPages: number;
  readonly checksum: number;
  readonly result: LivingEffectCaseResultV2;
}
interface WorkerRow {
  phase: 'ready' | 'pressurized' | 'done'; pid: number; caseDigest: Digest;
  rssBytes: number; touchedPages?: number; checksum?: number;
  retainedChecksum?: number; result?: LivingEffectCaseResultV2;
}
function osRss(pid: number): number {
  const kib = process.platform === 'linux'
    ? Number(/^VmRSS:\s+([0-9]+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1])
    : Number(execFileSync('ps', ['-p', String(pid), '-o', 'rss='],
      { encoding: 'utf8', timeout: 5000 }).trim());
  if (!Number.isSafeInteger(kib) || kib < 1) throw new Error('OS RSS sample unavailable');
  return kib * 1024;
}
export async function runPhysicalMemoryPressure(registrationPath: string, directory: string,
  profile: { readonly residentBytes: number; readonly touchStrideBytes: number;
    readonly minimumOsRssDeltaBytes: number; readonly caseScenario: string }):
  Promise<PhysicalMemoryPressureObservationV1> {
  if (profile.caseScenario !== 'bounded-allocation'
    || !Number.isSafeInteger(profile.residentBytes) || profile.residentBytes < 4096
    || profile.residentBytes > 128 * 1024 * 1024
    || !Number.isSafeInteger(profile.touchStrideBytes) || profile.touchStrideBytes < 1
    || profile.touchStrideBytes > 4096
    || !Number.isSafeInteger(profile.minimumOsRssDeltaBytes)
    || profile.minimumOsRssDeltaBytes < 1
    || profile.minimumOsRssDeltaBytes > profile.residentBytes)
    throw new TypeError('invalid physical memory pressure profile');
  const child = spawn(process.execPath, ['--experimental-strip-types', workerPath,
    registrationPath, directory, profile.caseScenario],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AETHER_LIVING_MEMORY_WORKER: '1' } });
  let stderr = '', output = '', waiter: ((row: WorkerRow) => void) | null = null;
  const queued: WorkerRow[] = [];
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  child.stdout!.on('data', chunk => {
    output += String(chunk);
    if (output.length > 1024 * 1024) { child.kill('SIGKILL'); return; }
    for (;;) {
      const newline = output.indexOf('\n'); if (newline < 0) return;
      const row = JSON.parse(output.slice(0, newline)) as WorkerRow;
      output = output.slice(newline + 1);
      if (waiter) { const resolve = waiter; waiter = null; resolve(row); }
      else queued.push(row);
    }
  });
  const next = async (phase: WorkerRow['phase']): Promise<WorkerRow> => {
    const row = queued.shift() ?? await new Promise<WorkerRow>((resolve, reject) => {
      const timer = setTimeout(() => { waiter = null; reject(new Error(`physical pressure worker timeout: ${stderr}`)); }, 20_000);
      waiter = value => { clearTimeout(timer); resolve(value); };
      child.once('exit', (code, signal) => {
        if (waiter) { clearTimeout(timer); waiter = null;
          reject(new Error(`physical pressure worker exited: ${code}/${signal}: ${stderr}`)); }
      });
    });
    if (row.phase !== phase || row.pid !== child.pid || typeof row.caseDigest !== 'string'
      || !Number.isSafeInteger(row.rssBytes) || row.rssBytes < 1)
      throw new Error('physical pressure worker phase/identity changed');
    return row;
  };
  try {
    const ready = await next('ready');
    const baseline = osRss(child.pid!);
    child.stdin!.write(JSON.stringify({ op: 'pressure', bytes: profile.residentBytes,
      stride: profile.touchStrideBytes }) + '\n');
    const pressured = await next('pressurized');
    const pressuredRss = osRss(child.pid!);
    if (pressured.caseDigest !== ready.caseDigest
      || pressured.touchedPages !== Math.ceil(profile.residentBytes / profile.touchStrideBytes)
      || pressuredRss - baseline < profile.minimumOsRssDeltaBytes
      || pressured.rssBytes - ready.rssBytes < profile.minimumOsRssDeltaBytes)
      throw new Error('requested pages did not become independently observed resident pressure');
    child.stdin!.write(JSON.stringify({ op: 'run' }) + '\n');
    const done = await next('done');
    const after = osRss(child.pid!);
    if (done.caseDigest !== ready.caseDigest || done.touchedPages !== pressured.touchedPages
      || done.checksum !== pressured.checksum || done.retainedChecksum !== pressured.checksum
      || after - baseline < profile.minimumOsRssDeltaBytes
      || !done.result?.passed || done.result.filtered
      || !done.result.coverage.includes('resource:exhausted'))
      throw new Error('signed case did not survive while OS pages remained resident');
    return { format: 'aether.living-physical-memory-pressure/1', workerPid: child.pid!,
      caseDigest: ready.caseDigest, requestedBytes: profile.residentBytes,
      touchStrideBytes: profile.touchStrideBytes,
      minimumOsRssDeltaBytes: profile.minimumOsRssDeltaBytes,
      osRssBaselineBytes: baseline, osRssPressuredBytes: pressuredRss,
      osRssAfterCaseBytes: after, workerRssBaselineBytes: ready.rssBytes,
      workerRssPressuredBytes: pressured.rssBytes,
      workerRssAfterCaseBytes: done.rssBytes, touchedPages: done.touchedPages!,
      checksum: done.checksum!, result: done.result };
  } finally {
    child.stdin?.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('physical pressure worker did not exit')), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      child.kill('SIGTERM');
      await exited;
    }
  }
}
