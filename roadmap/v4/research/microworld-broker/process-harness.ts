/** Real loopback TCP, independent worker, and SIGKILL extension of the broker campaign. */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { domainDigest, type Digest } from '../../../../src/fabric/identity.ts';
import { LivingCampaign } from '../../../../src/tier3/living-campaign.ts';
import { livingFixture } from '../microworld/fixture.ts';
import type { BrokerCase, Candidate } from './harness.ts';

const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'process-worker.ts');
interface Worker { readonly child: ChildProcess; readonly port: number; readonly pid: number }
async function start(directory: string, candidate: Candidate, crash: boolean): Promise<Worker> {
  const child = spawn(process.execPath, ['--experimental-strip-types', workerPath, directory,
    candidate === 'stable-effect-id' ? 'stable' : 'attempt', crash ? 'crash' : 'normal'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const ready = await new Promise<{ ready: number; pid: number }>((resolve, reject) => {
    let data = ''; const timer = setTimeout(() => reject(new Error(`worker start timeout: ${stderr}`)), 10_000);
    child.stdout!.on('data', chunk => {
      data += String(chunk); const index = data.indexOf('\n');
      if (index < 0) return;
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
  const exited = new Promise<void>(resolve => worker.child.once('exit', () => resolve()));
  worker.child.kill('SIGTERM'); await exited;
}
async function waitForCrash(worker: Worker): Promise<void> {
  if (worker.child.signalCode === 'SIGKILL') return;
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SIGKILL timeout')), 10_000);
    worker.child.once('exit', (_code, value) => { clearTimeout(timer); resolve(value); });
  });
  if (signal !== 'SIGKILL') throw new Error(`expected independent worker SIGKILL, got ${signal}`);
}
async function frame(worker: Worker, payload: string, complete = true): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = connect(worker.port, '127.0.0.1'); let response = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TCP response timeout')); }, 10_000);
    const done = (error?: Error, result?: unknown): void => {
      clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(result);
    };
    socket.on('connect', () => {
      if (!complete) { socket.write(payload); socket.end(); return; }
      socket.write(payload + '\n');
    });
    socket.on('data', chunk => {
      response += String(chunk); const index = response.indexOf('\n');
      if (index >= 0) {
        try { const decoded = JSON.parse(response.slice(0, index)); if (decoded.error) done(new Error(decoded.error)); else done(undefined, decoded.result); }
        catch (error) { done(error as Error); }
      }
    });
    socket.once('error', error => done(error));
    socket.once('close', () => { if (complete && !response.includes('\n')) done(new Error('TCP connection closed without response')); else if (!complete) done(undefined, null); });
  });
}
export interface ProcessCaseResult {
  readonly format: 'aether.living-process-broker-result/1';
  readonly candidate: Candidate; readonly seed: string; readonly sourcePassed: boolean;
  readonly passed: boolean; readonly failure: string | null; readonly filtered: false;
  readonly coverage: readonly string[]; readonly workerPids: readonly number[];
  readonly sinkWrites: number; readonly journalEvents: number; readonly replayConsumed: number;
  readonly journalDigest: Digest; readonly sinkDigest: Digest;
}
export async function runProcessCase(input: BrokerCase, candidate: Candidate, directory: string): Promise<ProcessCaseResult> {
  mkdirSync(directory, { recursive: true });
  const fixture = livingFixture();
  const source = new LivingCampaign({ ...fixture, directory: join(directory, 'source') });
  const sourceResult = source.execute(input.sourceCase);
  const coverage = new Set<string>();
  let first = await start(directory, candidate, true);
  const pids = [first.pid]; let second: Worker | null = null;
  try {
    // Incomplete and malformed socket frames must never dispatch an effect.
    await frame(first, '{"op":"invoke","attempt":0', false); coverage.add('tcp:truncated-frame');
    try { await frame(first, '{broken'); throw new Error('malformed frame unexpectedly accepted'); }
    catch (error) { if (!String(error).includes('SyntaxError')) throw error; coverage.add('tcp:malformed-frame'); }
    const empty = await frame(first, JSON.stringify({ op: 'status' })) as { sinkWrites: number };
    if (empty.sinkWrites !== 0) throw new Error('socket fault dispatched effect');
    // Crash the actual worker after the durable sink write and before broker receipt.
    try { await frame(first, JSON.stringify({ op: 'invoke', attempt: 0 })); throw new Error('crash injection did not fire'); }
    catch (error) { if (!String(error).includes('TCP connection closed')) throw error; }
    await waitForCrash(first); coverage.add('process:sigkill-after-sink');
    second = await start(directory, candidate, false); pids.push(second.pid);
    if (second.pid === first.pid) throw new Error('worker was not replaced');
    const recovery = await frame(second, JSON.stringify({ op: 'reconcile' })) as { recovered: number };
    if (recovery.recovered !== 1) throw new Error('uncertain effect was not reconciled');
    coverage.add('broker:reconciled-after-process-restart');
    const retry = await frame(second, JSON.stringify({ op: 'invoke', attempt: 1 })) as { ok: boolean };
    if (!retry.ok) throw new Error('retry failed');
    coverage.add('tcp:duplicate-delivery');
    const replay = await frame(second, JSON.stringify({ op: 'replay' })) as { consumed: number };
    coverage.add('broker:isolated-replay');
    const status = await frame(second, JSON.stringify({ op: 'status' })) as { sinkWrites: number; journalEvents: number };
    const journal = JSON.parse(readFileSync(join(directory, 'broker', 'effects.json'), 'utf8'));
    const sinkDirectory = join(directory, 'sink');
    const sinkFiles = readdirSync(sinkDirectory).filter(name => name.endsWith('.json')).sort();
    const journalDigest = domainDigest('aether.living-process-broker-journal/1', journal.records);
    const sinkDigest = domainDigest('aether.living-process-broker-sink/1', sinkFiles.map(name => ({ name, content: readFileSync(join(sinkDirectory, name), 'utf8') })));
    const failure = !sourceResult.passed ? 'source-campaign-failed'
      : status.sinkWrites > 1 ? 'duplicate-effect'
      : status.sinkWrites !== 1 ? 'missing-effect'
      : status.journalEvents !== 1 ? 'unexpected-journal-count'
      : replay.consumed !== status.journalEvents ? 'replay-incomplete' : null;
    return { format: 'aether.living-process-broker-result/1', candidate, seed: input.seed,
      sourcePassed: sourceResult.passed, passed: failure === null, failure, filtered: false,
      coverage: [...coverage].sort(), workerPids: pids, sinkWrites: status.sinkWrites,
      journalEvents: status.journalEvents, replayConsumed: replay.consumed, journalDigest, sinkDigest };
  } finally { if (second) await stop(second); await stop(first); }
}
