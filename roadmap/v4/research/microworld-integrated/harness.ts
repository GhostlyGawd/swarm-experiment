/** Runs one signed Aether candidate across real TCP and worker-crash boundaries. */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { domainDigest, type Digest } from '../../../../src/fabric/identity.ts';
import type { LivingCase, LivingEffectCaseResultV2 } from '../../../../src/tier3/living-campaign.ts';

const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'worker.ts');
interface Worker { readonly child: ChildProcess; readonly port: number; readonly pid: number }
async function start(registrationPath: string, directory: string): Promise<Worker> {
  const child = spawn(process.execPath, ['--experimental-strip-types', workerPath, registrationPath, directory],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AETHER_LIVING_CRASH_WORKER: '1' } });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const ready = await new Promise<{ ready: number; pid: number }>((resolve, reject) => {
    let data = ''; const timer = setTimeout(() => reject(new Error(`worker ready timeout: ${stderr}`)), 10_000);
    child.stdout!.on('data', chunk => {
      data += String(chunk); const index = data.indexOf('\n'); if (index < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(data.slice(0, index))); } catch (error) { reject(error); }
    });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`worker exited before ready: ${code}/${signal}: ${stderr}`)); });
  });
  if (!Number.isSafeInteger(ready.ready) || ready.ready < 1 || ready.pid !== child.pid) throw new Error('invalid worker ready frame');
  return { child, port: ready.ready, pid: ready.pid };
}
async function stop(worker: Worker): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => worker.child.once('exit', () => resolve()));
  worker.child.kill('SIGTERM'); await exit;
}
async function killed(worker: Worker): Promise<void> {
  if (worker.child.signalCode === 'SIGKILL') return;
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SIGKILL timeout')), 10_000);
    worker.child.once('exit', (_code, value) => { clearTimeout(timer); resolve(value); });
  });
  if (signal !== 'SIGKILL') throw new Error(`expected independent worker SIGKILL, observed ${signal}`);
}
async function frame(worker: Worker, payload: string, complete = true): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = connect(worker.port, '127.0.0.1'); let response = '', settled = false;
    const timer = setTimeout(() => finish(new Error('TCP response timeout')), 10_000);
    function finish(error?: Error, value?: unknown): void {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    }
    socket.once('connect', () => { socket.write(payload + (complete ? '\n' : '')); if (!complete) socket.end(); });
    socket.on('data', chunk => {
      response += String(chunk); const index = response.indexOf('\n'); if (index < 0) return;
      try { const decoded = JSON.parse(response.slice(0, index)); if (decoded.error) finish(new Error(decoded.error)); else finish(undefined, decoded.result); }
      catch (error) { finish(error as Error); }
    });
    socket.once('error', error => finish(error));
    socket.once('close', () => {
      if (!complete) finish(undefined, null);
      else if (!response.includes('\n')) finish(new Error('TCP connection closed without response'));
    });
  });
}
function caseId(input: LivingCase): Digest { return domainDigest('aether.living-case/1', input); }
function rawEffects(directory: string, input: LivingCase): { journalDigest: Digest; sinkDigest: Digest; eventCount: number; sinkWrites: number } {
  const suffix = caseId(input).split(':').at(-1)!;
  const journalPath = join(directory, 'effect-journals', suffix, 'effects.json');
  const records = existsSync(journalPath) ? (JSON.parse(readFileSync(journalPath, 'utf8')) as { records: unknown[] }).records : [];
  const sink = join(directory, 'effect-sinks', suffix);
  const files = existsSync(sink) ? readdirSync(sink).filter(name => name.endsWith('.json')).sort() : [];
  return { journalDigest: domainDigest('aether.living-effect-journal/2', records),
    sinkDigest: domainDigest('aether.living-effect-sink-set/2', files.map(file => ({ file, bytes: readFileSync(join(sink, file), 'utf8') }))),
    eventCount: records.length, sinkWrites: files.length };
}
export interface CombinedCaseObservation { readonly input: LivingCase; readonly result: LivingEffectCaseResultV2 }
export interface CombinedProcessResult {
  readonly format: 'aether.living-integrated-process-result/1';
  readonly generated: number; readonly executed: number; readonly filtered: number;
  readonly passed: number; readonly failed: number; readonly attemptedCaseExecutions: number;
  readonly malformedTcpFrames: number; readonly truncatedTcpFrames: number; readonly workerPids: readonly number[];
  readonly recovered: number; readonly unknown: number; readonly duplicateCaseDigest: Digest;
  readonly coverage: readonly string[]; readonly seeds: readonly string[];
  readonly cases: readonly CombinedCaseObservation[];
}
export async function runCombinedProcess(registrationPath: string, directory: string,
  generated: readonly LivingCase[]): Promise<CombinedProcessResult> {
  mkdirSync(directory, { recursive: true });
  const crashCase = generated.find(item => item.scenario === 'faulted-json-network' && item.ordinal === 0);
  if (!crashCase || generated.length !== 15) throw new Error('registered integrated campaign must cover all 15 cases');
  let first = await start(registrationPath, directory), second: Worker | null = null;
  const workerPids = [first.pid], observations = new Map<Digest, CombinedCaseObservation>();
  let attempted = 0;
  try {
    const command = (op: string, input: LivingCase) => JSON.stringify({ op, input });
    await frame(first, command('run-case', crashCase).slice(0, 24), false);
    try { await frame(first, '{malformed'); throw new Error('malformed TCP frame unexpectedly accepted'); }
    catch (error) { if (!String(error).includes('SyntaxError')) throw error; }
    if (existsSync(join(directory, 'effect-journals'))) throw new Error('malformed/truncated frame dispatched a candidate');
    attempted++;
    try { await frame(first, command('run-case', crashCase)); throw new Error('signed post-sink crash did not fire'); }
    catch (error) { if (!String(error).includes('TCP connection closed')) throw error; }
    await killed(first);
    const beforeRecovery = rawEffects(directory, crashCase);
    if (beforeRecovery.sinkWrites !== 1 || beforeRecovery.eventCount !== 1)
      throw new Error('SIGKILL did not occur after one durable sink write and broker intent');
    second = await start(registrationPath, directory); workerPids.push(second.pid);
    if (second.pid === first.pid) throw new Error('worker was not replaced');
    const recovery = await frame(second, command('recover-case', crashCase)) as { reconciled: number; unknown: number };
    if (recovery.reconciled !== 1 || recovery.unknown !== 0) throw new Error('crashed effect was not definitively reconciled');
    attempted++;
    const crashResult = await frame(second, command('run-case', crashCase)) as LivingEffectCaseResultV2;
    if (!crashResult.passed || crashResult.filtered || crashResult.effects.indeterminate) throw new Error('recovered signed candidate failed');
    observations.set(caseId(crashCase), { input: crashCase, result: crashResult });
    attempted++;
    const duplicate = await frame(second, command('run-case', crashCase)) as LivingEffectCaseResultV2;
    if (domainDigest('aether.living-effect-case-result/2', duplicate)
      !== domainDigest('aether.living-effect-case-result/2', crashResult)) throw new Error('duplicate delivery changed candidate result');
    const afterDuplicate = rawEffects(directory, crashCase);
    if (afterDuplicate.sinkWrites !== crashResult.effects.sinkWrites || afterDuplicate.eventCount !== crashResult.effects.eventCount)
      throw new Error('duplicate delivery appended effects');
    for (const input of generated) {
      if (caseId(input) === caseId(crashCase)) continue;
      attempted++;
      const result = await frame(second, command('run-case', input)) as LivingEffectCaseResultV2;
      if (!result.passed || result.filtered || result.effects.indeterminate) throw new Error(`signed candidate case failed: ${input.seed}`);
      observations.set(caseId(input), { input, result });
    }
    const cases = generated.map(input => {
      const observed = observations.get(caseId(input)); if (!observed) throw new Error('generated case omitted'); return observed;
    });
    const coverage = [...new Set(cases.flatMap(item => item.result.coverage))].sort();
    for (const label of ['scheduler:switched', 'resource:exhausted', 'network:malformed', 'network:checksum',
      'network:drop', 'event:reordered', 'effect:committed'])
      if (!coverage.includes(label)) throw new Error(`integrated coverage missing ${label}`);
    return { format: 'aether.living-integrated-process-result/1', generated: generated.length, executed: cases.length,
      filtered: cases.filter(item => item.result.filtered).length, passed: cases.filter(item => item.result.passed).length,
      failed: cases.filter(item => !item.result.passed).length, attemptedCaseExecutions: attempted,
      malformedTcpFrames: 1, truncatedTcpFrames: 1, workerPids, recovered: recovery.reconciled,
      unknown: recovery.unknown, duplicateCaseDigest: caseId(crashCase), coverage,
      seeds: cases.map(item => item.input.seed), cases };
  } finally { if (second) await stop(second); await stop(first); }
}
export function auditCombinedRaw(directory: string, result: CombinedProcessResult): void {
  for (const item of result.cases) {
    const current = rawEffects(directory, item.input);
    if (current.journalDigest !== item.result.effects.journalDigest
      || current.sinkDigest !== item.result.effects.sinkDigest
      || current.eventCount !== item.result.effects.eventCount
      || current.sinkWrites !== item.result.effects.sinkWrites)
      throw new Error(`raw broker/sink evidence changed for ${item.input.seed}`);
  }
}
