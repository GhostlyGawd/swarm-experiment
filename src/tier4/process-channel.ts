import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Term } from '../tier1/ast.ts';
import type { CapabilityName, NodeRef, SymbolId } from '../tier1/ids.ts';
import { encode as encodeIR } from '../tier1/agent-ir.ts';
import { GraphStore } from '../tier1/store.ts';
import type { CapabilityDescriptor } from '../tier2/ocap.ts';
import type { ExecutionResult } from '../tier3/runtime.ts';
import { EffectInvocationError } from '../tier3/effects.ts';
import type { Value } from '../tier3/values.ts';
import { encodeCanonical, exactObject, identifier, type TaggedValueV1 } from '../fabric/encoding.ts';
import { executionManifestDigest, validateExecutionManifest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import type { RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { ProcessAuthenticator, fromWireSnapshot, encodeProcessValue, decodeProcessValue, type ProcessScope } from './process-values.ts';

export interface ProcessChannelInit {
  readonly module: Term;
  readonly manifest: ExecutionManifestV1;
  readonly unit: string;
  readonly includeSymbols: readonly SymbolId[];
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly heapId: string;
  /** Fixed for this channel's lifetime. Advancing ownership requires a fresh channel. */
  readonly ownershipEpoch: string;
  readonly snapshot?: RuntimeSnapshotV1;
}
export interface ProcessCallResult {
  readonly execution: ExecutionResult;
  readonly snapshot: RuntimeSnapshotV1;
  readonly pid?: number;
}
export interface ProcessCallRequest {
  readonly symbol: SymbolId;
  readonly from: SymbolId;
  readonly args: readonly Value[];
  readonly snapshot: RuntimeSnapshotV1;
  /** Deterministic child operation identity derived from the caller's supplied operationId. */
  readonly operationId: string;
}
export interface ProcessEffectRequest {
  readonly capability: CapabilityName;
  /** Actual declaring function at Invoke, including direct calls within the same unit. */
  readonly from: SymbolId;
  readonly args: readonly Value[];
  readonly snapshot: RuntimeSnapshotV1;
  readonly operationId: string;
  readonly effectIndex: number;
}
export interface ProcessChannelOptions {
  readonly onCall?: (request: ProcessCallRequest) => Promise<ProcessCallResult> | ProcessCallResult;
  readonly onEffect?: (request: ProcessEffectRequest) => Promise<{ value: Value; snapshot: RuntimeSnapshotV1 }> | { value: Value; snapshot: RuntimeSnapshotV1 };
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
}
export class ProcessChannelError extends Error {
  readonly code: 'timeout' | 'eof' | 'protocol' | 'remote' | 'closed';
  readonly outcomeUnknown: boolean;
  constructor(code: ProcessChannelError['code'], message: string, outcomeUnknown: boolean) {
    super(message); this.name = 'ProcessChannelError'; this.code = code; this.outcomeUnknown = outcomeUnknown;
  }
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  outcomeUnknown: boolean;
}
export interface ProcessInitWire {
  readonly ir: string;
  readonly manifest: ExecutionManifestV1;
  readonly unit: string;
  readonly includeSymbols: readonly SymbolId[];
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly heapId: string;
  readonly ownershipEpoch: string;
  readonly snapshot: RuntimeSnapshotV1 | null;
}
type WireExecution = { ok: true; value: TaggedValueV1; steps: number } | Extract<ExecutionResult, { ok: false }>;
export function encodeProcessExecution(execution: ExecutionResult, scope: ProcessScope, snapshot: RuntimeSnapshotV1): WireExecution {
  return execution.ok ? { ok: true, value: encodeProcessValue(execution.value, scope, snapshot), steps: execution.steps } : execution;
}
export function decodeProcessExecution(value: unknown, scope: ProcessScope, snapshot: RuntimeSnapshotV1): ExecutionResult {
  if (!value || typeof value !== 'object' || !('ok' in value)) throw new TypeError('invalid process execution result');
  const execution = exactObject(value, value.ok === true ? ['ok', 'value', 'steps'] : ['ok', 'fault', 'steps']);
  if (!Number.isSafeInteger(execution.steps) || (execution.steps as number) < 0) throw new TypeError('invalid execution steps');
  if (execution.ok === true) return { ok: true, value: decodeProcessValue(execution.value as TaggedValueV1, scope, snapshot), steps: execution.steps as number };
  if (execution.ok !== false || !execution.fault || typeof execution.fault !== 'object') throw new TypeError('invalid process execution fault');
  const fields = ['kind', 'message', 'label', 'step', 'bindings', ...('recoveryId' in execution.fault ? ['recoveryId'] : [])];
  const fault = exactObject(execution.fault, fields);
  if (!['precondition', 'postcondition', 'assertion', 'capability_denied', 'capability_revoked', 'division_by_zero', 'step_budget', 'unbound', 'type_error', 'effect_failed', 'effect_indeterminate'].includes(fault.kind as string)
    || typeof fault.message !== 'string' || (fault.label !== null && typeof fault.label !== 'string') || !Number.isSafeInteger(fault.step) || (fault.step as number) < 0
    || (fault.recoveryId !== undefined && typeof fault.recoveryId !== 'string')) throw new TypeError('invalid process fault fields');
  if (!fault.bindings || typeof fault.bindings !== 'object' || Array.isArray(fault.bindings) || Object.values(fault.bindings).some(item => typeof item !== 'string')) throw new TypeError('invalid fault bindings');
  return value as ExecutionResult;
}

/**
 * Async parent transport; each worker executes synchronous runtime code in its own OS process.
 * Only heaps cross suspended boundaries, never live frames or opaque continuations.
 * The coordinator must serialize top-level state transitions, supply durable operation IDs,
 * and persist/reconcile returned snapshots and unknown outcomes. This class owns no durable log.
 */
export class ProcessChannel {
  private readonly child: ChildProcess;
  private readonly authenticator: ProcessAuthenticator;
  private readonly pending = new Map<string, Pending>();
  private readonly options: ProcessChannelOptions;
  readonly scope: ProcessScope;
  private buffer: Buffer = Buffer.alloc(0);
  private requestSequence = 0;
  private closed = false;
  private exited = false;
  private readonly exitPromise: Promise<void>;
  private readonly callbacks = new Set<string>();
  readonly pid: number;
  get isClosed(): boolean { return this.closed || this.exited || this.child.exitCode !== null || this.child.signalCode !== null; }
  get alive(): boolean { return !this.isClosed && !this.child.killed; }

  private constructor(init: ProcessChannelInit, options: ProcessChannelOptions) {
    validateExecutionManifest(init.manifest);
    if (new GraphStore().intern(init.module) !== init.manifest.astRoot) throw new TypeError('worker module does not match execution manifest');
    this.options = options;
    const timeout = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) throw new RangeError('invalid process timeout');
    this.scope = Object.freeze({ executionManifest: executionManifestDigest(init.manifest), astRoot: init.manifest.astRoot as NodeRef, heapId: init.heapId, ownershipEpoch: init.ownershipEpoch, unit: init.unit });
    const key = randomBytes(32);
    const session = { sessionId: randomBytes(24).toString('hex'), executionManifest: this.scope.executionManifest, ownershipEpoch: init.ownershipEpoch, maxFrameBytes: options.maxFrameBytes ?? 8 * 1024 * 1024 };
    this.authenticator = new ProcessAuthenticator(key, session, 'parent');
    const worker = new URL(import.meta.url.endsWith('.ts') ? './process-worker.ts' : './process-worker.js', import.meta.url);
    this.child = spawn(process.execPath, [...(worker.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : []), fileURLToPath(worker)], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
    if (!this.child.pid) throw new ProcessChannelError('closed', 'worker could not start', false);
    this.pid = this.child.pid;
    this.exitPromise = new Promise(resolve => this.child.once('exit', () => { this.exited = true; this.fail(new ProcessChannelError('eof', 'worker exited before completing pending operations', this.pending.size > 0)); resolve(); }));
    this.child.once('error', () => this.fail(new ProcessChannelError('eof', 'worker process failed', this.pending.size > 0)));
    this.child.stdin!.on('error', () => this.fail(new ProcessChannelError('eof', 'worker input closed', this.pending.size > 0)));
    this.child.stdout!.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stdout!.on('end', () => this.fail(new ProcessChannelError('eof', 'worker output closed', this.pending.size > 0)));
    // Never accumulate or print worker data on stderr; diagnostics travel in signed responses.
    this.child.stderr!.resume();
    // FD4 is an otherwise empty parent-liveness pipe; no PID-reuse assumption.
    this.child.stdio[4]!.on('error', () => this.fail(new ProcessChannelError('eof', 'worker liveness pipe closed', this.pending.size > 0)));
    const bootstrap = encodeCanonical({ key: key.toString('base64'), session }, { maxFrameBytes: 4096, maxDecompressedBytes: 4096 });
    const length = Buffer.alloc(4); length.writeUInt32BE(bootstrap.length);
    const secretPipe = this.child.stdio[3] as Writable;
    secretPipe.on('error', () => this.fail(new ProcessChannelError('eof', 'worker bootstrap pipe failed', false)));
    secretPipe.end(Buffer.concat([length, bootstrap]));
  }
  static async start(init: ProcessChannelInit, options: ProcessChannelOptions = {}): Promise<ProcessChannel> {
    const channel = new ProcessChannel(init, options);
    try {
      if (init.snapshot) fromWireSnapshot(init.snapshot, channel.scope);
      const payload: ProcessInitWire = { ir: encodeIR(init.module).text, manifest: init.manifest, unit: init.unit, includeSymbols: init.includeSymbols, capabilities: init.capabilities, heapId: init.heapId, ownershipEpoch: init.ownershipEpoch, snapshot: init.snapshot ?? null };
      const ready = await channel.request('init', payload);
      const message = exactObject(ready, ['pid']);
      if (message.pid !== channel.pid) throw new TypeError('worker PID handshake mismatch');
      return channel;
    } catch (error) { await channel.kill(); throw error; }
  }
  async call(symbol: SymbolId, args: readonly Value[], snapshot: RuntimeSnapshotV1, options: { operationId?: string; timeoutMs?: number } = {}): Promise<ProcessCallResult> {
    fromWireSnapshot(snapshot, this.scope);
    const operationId = options.operationId ?? `${this.authenticator.session.sessionId}/call-${this.requestSequence + 1}`;
    identifier(operationId);
    const result = await this.request('call', { symbol, args: args.map(value => encodeProcessValue(value, this.scope, snapshot)), snapshot, operationId }, options.timeoutMs);
    const response = exactObject(result, ['execution', 'snapshot', 'pid']);
    fromWireSnapshot(response.snapshot as RuntimeSnapshotV1, this.scope);
    if (response.pid !== this.pid) throw new TypeError('call came from wrong worker');
    return { execution: decodeProcessExecution(response.execution, this.scope, response.snapshot as RuntimeSnapshotV1), snapshot: response.snapshot as RuntimeSnapshotV1, pid: this.pid };
  }
  async snapshot(): Promise<RuntimeSnapshotV1> {
    const result = await this.request('snapshot', null) as RuntimeSnapshotV1;
    fromWireSnapshot(result, this.scope); return result;
  }
  async importSnapshot(snapshot: RuntimeSnapshotV1): Promise<void> {
    fromWireSnapshot(snapshot, this.scope); await this.request('import', snapshot);
  }
  async close(): Promise<void> {
    if (!this.closed) { try { await this.request('close', null); } catch { /* EOF/timeout already fails pending operations. */ } }
    await this.kill();
  }
  async kill(): Promise<void> {
    this.fail(new ProcessChannelError('closed', 'worker channel closed', this.pending.size > 0));
    if (!this.exited) this.child.kill('SIGKILL');
    await this.exitPromise;
  }
  private request(method: string, payload: unknown, timeoutMs = this.options.timeoutMs ?? 5_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new ProcessChannelError('closed', 'worker channel is closed', false));
    if (this.pending.size >= 64) return Promise.reject(new RangeError('process outstanding request limit'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) return Promise.reject(new RangeError('invalid process timeout'));
    const id = `request-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new ProcessChannelError('timeout', `worker request ${method} timed out; execution outcome may be unknown`, true));
        this.child.kill('SIGKILL');
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, outcomeUnknown: method === 'call' });
      try { this.send({ kind: 'request', id, method, payload }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error as Error); }
    });
  }
  private send(body: unknown): void {
    if (this.closed) throw new ProcessChannelError('closed', 'worker channel is closed', true);
    this.child.stdin!.write(this.authenticator.encode(body));
  }
  private receive(chunk: Buffer): void {
    if (this.closed) return;
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32BE(0);
        if (size < 1 || size > this.authenticator.session.maxFrameBytes) throw new RangeError('oversized process frame');
        if (this.buffer.length < size + 4) break;
        const body = this.authenticator.decode(this.buffer.subarray(4, size + 4));
        this.buffer = this.buffer.subarray(size + 4);
        this.handle(body);
      }
    } catch {
      this.fail(new ProcessChannelError('protocol', 'worker authentication/framing failed', this.pending.size > 0));
      this.child.kill('SIGKILL');
    }
  }
  private handle(value: unknown): void {
    if (!value || typeof value !== 'object' || !('kind' in value)) throw new TypeError('invalid process message');
    if (value.kind === 'response') {
      const message = exactObject(value, ['kind', 'id', 'ok', 'value']); identifier(message.id);
      const pending = this.pending.get(message.id);
      if (!pending || typeof message.ok !== 'boolean') throw new TypeError('unsolicited process response');
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new ProcessChannelError('remote', typeof message.value === 'string' ? message.value : 'worker rejected request', pending.outcomeUnknown));
      return;
    }
    const message = exactObject(value, ['kind', 'id', 'method', 'payload']);
    identifier(message.id);
    if (message.kind !== 'callback' || !['call', 'effect'].includes(message.method as string) || this.callbacks.has(message.id) || !this.pending.size || this.callbacks.size >= 64) throw new TypeError('invalid/replayed or excessive process callback');
    this.callbacks.add(message.id);
    void this.callback(message.id, message.method as 'call' | 'effect', message.payload);
  }
  private async callback(id: string, method: 'call' | 'effect', value: unknown): Promise<void> {
    try {
      const payload = exactObject(value, method === 'call' ? ['symbol', 'from', 'args', 'snapshot', 'operationId'] : ['capability', 'from', 'args', 'snapshot', 'operationId', 'effectIndex']);
      identifier(payload.operationId);
      const snapshot = payload.snapshot as RuntimeSnapshotV1;
      fromWireSnapshot(snapshot, this.scope);
      if (!Array.isArray(payload.args)) throw new TypeError('invalid callback arguments');
      const args = payload.args.map(value => decodeProcessValue(value as TaggedValueV1, this.scope, snapshot));
      let result: unknown;
      if (method === 'call') {
        identifier(payload.symbol); identifier(payload.from);
        if (!this.options.onCall) throw new Error('no process call handler');
        const response = await this.options.onCall({ symbol: payload.symbol as SymbolId, from: payload.from as SymbolId, args, snapshot, operationId: payload.operationId });
        fromWireSnapshot(response.snapshot, this.scope);
        result = { execution: encodeProcessExecution(response.execution, this.scope, response.snapshot), snapshot: response.snapshot };
      } else {
        identifier(payload.capability); identifier(payload.from);
        if (!Number.isSafeInteger(payload.effectIndex) || (payload.effectIndex as number) < 0) throw new TypeError('invalid effect sequence');
        if (!this.options.onEffect) throw new Error('no process effect handler');
        const response = await this.options.onEffect({ capability: payload.capability as CapabilityName, from: payload.from as SymbolId, args, snapshot, operationId: payload.operationId, effectIndex: payload.effectIndex as number });
        fromWireSnapshot(response.snapshot, this.scope);
        result = { value: encodeProcessValue(response.value, this.scope, response.snapshot), snapshot: response.snapshot };
      }
      if (!this.closed) this.send({ kind: 'callback-response', id, ok: true, value: result });
    } catch (error) {
      const outcome = error instanceof EffectInvocationError ? error.outcome : null;
      if (!this.closed) {
        try { this.send({ kind: 'callback-response', id, ok: false, value: { message: error instanceof Error ? error.message : 'callback failed', outcome } }); }
        catch { this.fail(new ProcessChannelError('protocol', 'callback response could not be sent', true)); this.child.kill('SIGKILL'); }
      }
    } finally { this.callbacks.delete(id); }
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (!this.exited) this.child.kill('SIGKILL');
  }
}
