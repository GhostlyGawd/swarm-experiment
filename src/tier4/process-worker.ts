/** Dedicated synchronous worker. Standard output is exclusively authenticated protocol frames. */
import { readSync, writeSync, closeSync } from 'node:fs';
import { Socket } from 'node:net';
import { decode as decodeIR } from '../tier1/agent-ir.ts';
import { CausalLineageLedger } from '../tier1/causal-lineage.ts';
import { GraphStore } from '../tier1/store.ts';
import { capability, type CapabilityName, type NodeRef, type SymbolId } from '../tier1/ids.ts';
import { CapabilityRegistry, type CapabilityDescriptor } from '../tier2/ocap.ts';
import { typecheck } from '../tier2/typecheck.ts';
import { ProductionRuntime } from '../tier3/compile.ts';
import { EffectInvocationError } from '../tier3/effects.ts';
import type { ExecutionResult } from '../tier3/runtime.ts';
import type { Value } from '../tier3/values.ts';
import { decodeCanonical, exactObject, identifier, type TaggedValueV1 } from '../fabric/encoding.ts';
import { executionManifestDigest, validateExecutionManifest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import type { RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { ProcessAuthenticator, processBoundaryId, validateProcessScope, fromWireSnapshot, toWireSnapshot, decodeProcessValue, encodeProcessValue, type ProcessScope, type ProcessSession } from './process-values.ts';
import { decodeProcessExecution, encodeProcessExecution } from './process-execution-wire.ts';
import { validateProcessVirtualArtifactV3, type ProcessVirtualArtifactV3 } from './process-virtual-artifact.ts';
import { type ProcessVirtualArtifactV4 } from './process-virtual-artifact-v4-core.ts';
import { assertProcessWorkerPipeCustodyV1, validatePackagedProcessVirtualArtifactV4 } from './process-virtual-worker-v4.ts';
import { assertProcessVirtualWorkerBundleV1, openProcessVirtualWorkerLineageV1 } from './process-virtual-worker-contract.ts';

const pause = new Int32Array(new SharedArrayBuffer(4));
function readExact(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let at = 0;
  while (at < size) {
    try {
      const read = readSync(fd, buffer, at, size - at, null);
      if (read === 0) throw new Error('process pipe EOF');
      at += read;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN' && (error as NodeJS.ErrnoException).code !== 'EINTR') throw error;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
  return buffer;
}
function readFrame(fd: number, max: number): Buffer {
  const length = readExact(fd, 4).readUInt32BE(0);
  if (length < 1 || length > max) throw new RangeError('process frame size rejected');
  return readExact(fd, length);
}
function writeAll(bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    try { offset += writeSync(1, bytes, offset, bytes.length - offset); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN' && (error as NodeJS.ErrnoException).code !== 'EINTR') throw error;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
}

function main(): void {
  const bootstrap = exactObject(decodeCanonical(readFrame(3, 4096), { maxFrameBytes: 4096, maxDecompressedBytes: 4096 }), ['key', 'session']);
  closeSync(3);
  if (typeof bootstrap.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(bootstrap.key)) throw new TypeError('invalid private bootstrap');
  const sessionObject = exactObject(bootstrap.session, ['sessionId', 'executionManifest', 'ownershipEpoch', 'maxFrameBytes']);
  const session = sessionObject as unknown as ProcessSession;
  const authenticator = new ProcessAuthenticator(Buffer.from(bootstrap.key, 'base64'), session, 'worker');
  // Wrapping the inherited socket puts it in nonblocking mode. Pause prevents
  // libuv consuming bytes/EOF while synchronous guards own reads on this FD.
  const livenessPipe = new Socket({ fd: 4, readable: true, writable: false });
  livenessPipe.pause(); livenessPipe.unref();
  const heartbeat = Buffer.alloc(1);
  let guardChecks = 0;
  const executionGuard = (): boolean => {
    if (guardChecks++ % 1024 !== 0) return true;
    if (livenessPipe.destroyed) process.exit(1);
    try {
      // No bytes are valid here. EOF means the owning parent pipe disappeared.
      readSync(4, heartbeat, 0, 1, null);
      process.exit(1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN' || (error as NodeJS.ErrnoException).code === 'EINTR') return true;
      process.exit(1);
    }
  };
  let runtime: ProductionRuntime | null = null;
  let virtualAdmission: { version: 3; artifact: ProcessVirtualArtifactV3; lineage: CausalLineageLedger }
    | { version: 4; artifact: ProcessVirtualArtifactV4; lineage: CausalLineageLedger } | null = null;
  let virtualGuardCount = 0;
  let scope: ProcessScope | null = null;
  let previous: RuntimeSnapshotV1 | undefined;
  let callbackSequence = 0;
  let boundaryDepth = 0;
  const waitingCallbacks = new Set<string>();
  const receivedCallbacks = new Map<string, unknown>();
  const executions: { operationId: string; nextBoundary: number }[] = [];
  const custodied = process.argv[3] === 'aether.process-worker-launch-custody/1';
  const launchedPath = custodied ? process.argv[2]! : process.argv[1]!;
  const read = () => authenticator.decode(readFrame(custodied ? 5 : 0, session.maxFrameBytes));
  const send = (body: unknown) => writeAll(authenticator.encode(body));
  const capture = (): RuntimeSnapshotV1 => {
    if (!runtime || !scope) throw new Error('worker is not initialized');
    const snapshot = boundaryDepth ? runtime.exportBoundarySnapshot() : runtime.exportSnapshot();
    previous = toWireSnapshot(snapshot, scope, previous);
    return previous;
  };
  const restore = (snapshot: RuntimeSnapshotV1): void => {
    if (!runtime || !scope) throw new Error('worker is not initialized');
    const local = fromWireSnapshot(snapshot, scope);
    if (boundaryDepth) runtime.importBoundarySnapshot(local); else runtime.importSnapshot(local);
    previous = snapshot;
  };
  const rpc = (method: 'call' | 'effect', payload: unknown): unknown => {
    if (waitingCallbacks.size >= 64) throw new RangeError('process callback nesting limit');
    const id = `callback-${++callbackSequence}`;
    waitingCallbacks.add(id);
    send({ kind: 'callback', id, method, payload });
    boundaryDepth++;
    try {
      for (;;) {
        const response = receivedCallbacks.has(id) ? receivedCallbacks.get(id) : read();
        receivedCallbacks.delete(id);
        if (!response || typeof response !== 'object' || !('kind' in response)) throw new TypeError('invalid RPC response');
        if (response.kind === 'request') { dispatch(response); continue; }
        const message = exactObject(response, ['kind', 'id', 'ok', 'value']);
        if (message.kind !== 'callback-response' || typeof message.id !== 'string' || !waitingCallbacks.has(message.id) || typeof message.ok !== 'boolean') throw new TypeError('unexpected callback response');
        if (message.id !== id) {
          if (receivedCallbacks.has(message.id)) throw new TypeError('duplicate callback response');
          receivedCallbacks.set(message.id, response); continue;
        }
        if (!message.ok) {
          const error = exactObject(message.value, ['message', 'outcome']);
          if (error.outcome !== null) {
            if (!error.outcome || typeof error.outcome !== 'object' || !('state' in error.outcome)) throw new TypeError('invalid effect failure');
            const outcome = exactObject(error.outcome, error.outcome.state === 'indeterminate' ? ['state', 'recoveryId'] : ['state', 'code']);
            if (outcome.state === 'indeterminate') { identifier(outcome.recoveryId); throw new EffectInvocationError({ state: 'indeterminate', recoveryId: outcome.recoveryId }); }
            if (outcome.state === 'aborted' || outcome.state === 'rejected') { identifier(outcome.code); throw new EffectInvocationError({ state: outcome.state, code: outcome.code }); }
            throw new TypeError('invalid effect failure state');
          }
          throw new Error(typeof error.message === 'string' ? error.message : 'remote callback failed');
        }
        return message.value;
      }
    } finally { boundaryDepth--; waitingCallbacks.delete(id); receivedCallbacks.delete(id); }
  };
  const boundarySnapshot = (): RuntimeSnapshotV1 => {
    if (!runtime || !scope) throw new Error('worker is not initialized');
    previous = toWireSnapshot(runtime.exportBoundarySnapshot(), scope, previous);
    return previous;
  };
  const importBoundary = (snapshot: RuntimeSnapshotV1): void => {
    runtime!.importBoundarySnapshot(fromWireSnapshot(snapshot, scope!)); previous = snapshot;
  };
  const remoteCall = (symbol: SymbolId, args: readonly Value[], from: SymbolId): ExecutionResult => {
    const snapshot = boundarySnapshot(), active = executions.at(-1)!;
    const operationId = processBoundaryId(active.operationId, 'call', active.nextBoundary++);
    identifier(operationId);
    const response = exactObject(rpc('call', { symbol, from, args: args.map(value => encodeProcessValue(value, scope!, snapshot)), snapshot, operationId }), ['execution', 'snapshot']);
    const final = response.snapshot as RuntimeSnapshotV1;
    fromWireSnapshot(final, scope!);
    const execution = decodeProcessExecution(response.execution, scope!, final);
    importBoundary(final); return execution;
  };
  const remoteEffect = (name: CapabilityName, args: readonly Value[], from: SymbolId | undefined): Value => {
    if (!from) throw new TypeError('effect boundary lacks declaring function identity');
    identifier(from);
    const snapshot = boundarySnapshot(), active = executions.at(-1)!;
    const effectIndex = active.nextBoundary++;
    const response = exactObject(rpc('effect', { capability: name, from, args: args.map(value => encodeProcessValue(value, scope!, snapshot)), snapshot, operationId: active.operationId, effectIndex }), ['value', 'snapshot']);
    const final = response.snapshot as RuntimeSnapshotV1;
    fromWireSnapshot(final, scope!);
    const value = decodeProcessValue(response.value as TaggedValueV1, scope!, final);
    importBoundary(final); return value;
  };
  const initialize = (payload: unknown): unknown => {
    if (runtime) throw new Error('worker is already initialized');
    const init = exactObject(payload, ['ir', 'manifest', 'unit', 'includeSymbols', 'capabilities', 'heapId', 'ownershipEpoch', 'snapshot']);
    if (typeof init.ir !== 'string' || !Array.isArray(init.includeSymbols) || new Set(init.includeSymbols).size !== init.includeSymbols.length || !Array.isArray(init.capabilities)) throw new TypeError('invalid worker initialization');
    validateExecutionManifest(init.manifest);
    const manifest = init.manifest as ExecutionManifestV1;
    if (executionManifestDigest(manifest) !== session.executionManifest || init.ownershipEpoch !== session.ownershipEpoch) throw new TypeError('worker root/epoch differs from session');
    const module = decodeIR(init.ir);
    if (module.kind !== 'Module' || new GraphStore().intern(module) !== manifest.astRoot) throw new TypeError('decoded code does not match manifest');
    const registry = new CapabilityRegistry();
    for (const value of init.capabilities) {
      const descriptor = exactObject(value, ['name', 'domain', 'operation', 'arity', 'description', 'effectful']);
      if (typeof descriptor.name !== 'string' || !Number.isSafeInteger(descriptor.arity) || (descriptor.arity as number) < 0 || typeof descriptor.description !== 'string' || typeof descriptor.effectful !== 'boolean') throw new TypeError('invalid capability descriptor');
      const name = capability(descriptor.name);
      if (descriptor.domain !== name.split(':')[1] || descriptor.operation !== name.split(':')[2]) throw new TypeError('capability descriptor identity mismatch');
      registry.define(descriptor as unknown as CapabilityDescriptor);
    }
    const declarations = new Set(module.members.filter(member => member.kind === 'FunctionDecl').map(member => member.symbol));
    for (const symbol of init.includeSymbols) { identifier(symbol); if (!declarations.has(symbol as SymbolId)) throw new TypeError('worker includes an undeclared function'); }
    const checked = typecheck(module, { registry });
    if (!checked.ok) throw new TypeError('worker module failed type/capability checking');
    scope = { executionManifest: session.executionManifest, astRoot: manifest.astRoot as NodeRef, heapId: init.heapId as string, ownershipEpoch: init.ownershipEpoch as string, unit: init.unit as string };
    validateProcessScope(scope);
    const effects = new Map(registry.names.map(name => [name, (args: readonly Value[], from?: SymbolId) => remoteEffect(name, args, from)]));
    runtime = ProductionRuntime.compile(module, { registry, includeSymbols: init.includeSymbols as SymbolId[], policy: 'enforce', callHandler: remoteCall, effects, executionGuard });
    if (init.snapshot !== null) restore(init.snapshot as RuntimeSnapshotV1);
    return { pid: process.pid };
  };
  const initializeVirtual = (payload: unknown): unknown => {
    if (runtime) throw new Error('worker is already initialized');
    const init = exactObject(payload, ['format', 'artifact', 'trust', 'unit', 'heapId',
      'ownershipEpoch', 'snapshot', 'maxGuardChecks']);
    if (init.format !== 'aether.process-worker-init/2'
      && init.format !== 'aether.process-worker-init/3')
      throw new TypeError('unsupported process worker init version');
    if (init.maxGuardChecks !== null && (!Number.isSafeInteger(init.maxGuardChecks)
      || (init.maxGuardChecks as number) < 0 || (init.maxGuardChecks as number) > 1_000_000))
      throw new RangeError('invalid virtual worker guard budget');
    const lineage = openProcessVirtualWorkerLineageV1(init.trust);
    const version = init.format === 'aether.process-worker-init/3' ? 4 : 3;
    if (version === 4)
      assertProcessWorkerPipeCustodyV1((init.artifact as ProcessVirtualArtifactV4).executableSubject.manifest.bundle);
    const artifact = version === 4
      ? validatePackagedProcessVirtualArtifactV4(init.artifact, lineage, launchedPath)
      : validateProcessVirtualArtifactV3(init.artifact, lineage);
    if (version === 3)
      assertProcessVirtualWorkerBundleV1(artifact as ProcessVirtualArtifactV3, launchedPath);
    const manifest = artifact.candidateEvidence.manifest;
    if (executionManifestDigest(manifest) !== session.executionManifest
      || init.ownershipEpoch !== session.ownershipEpoch)
      throw new TypeError('virtual worker manifest or ownership differs from session');
    const module = decodeIR(artifact.candidateIr), source = decodeIR(artifact.sourceIr);
    if (module.kind !== 'Module' || source.kind !== 'Module'
      || new GraphStore().intern(module) !== manifest.astRoot)
      throw new TypeError('virtual worker exact candidate root mismatch');
    const registry = new CapabilityRegistry();
    if (!typecheck(module, { registry }).ok) throw new TypeError('virtual worker module failed typechecking');
    const includeSymbols = module.members.filter(member => member.kind === 'FunctionDecl')
      .map(member => member.symbol);
    if (!includeSymbols.includes(artifact.descriptor.target))
      throw new TypeError('virtual worker target must compile locally');
    const nextScope: ProcessScope = { executionManifest: session.executionManifest,
      astRoot: manifest.astRoot as NodeRef, heapId: init.heapId as string,
      ownershipEpoch: init.ownershipEpoch as string, unit: init.unit as string };
    validateProcessScope(nextScope);
    const nextRuntime = ProductionRuntime.compile(module, { registry,
      includeSymbols, policy: 'enforce', executionGuard: () => {
        if (!executionGuard()) return false;
        return init.maxGuardChecks === null || virtualGuardCount++ < (init.maxGuardChecks as number);
      },
      virtualForward: { source, descriptor: artifact.descriptor } });
    scope = nextScope; runtime = nextRuntime;
    virtualAdmission = version === 4
      ? { version: 4, artifact: artifact as ProcessVirtualArtifactV4, lineage }
      : { version: 3, artifact: artifact as ProcessVirtualArtifactV3, lineage };
    try {
      if (init.snapshot !== null) restore(init.snapshot as RuntimeSnapshotV1);
    } catch (error) {
      runtime = null; scope = null; virtualAdmission = null;
      throw error;
    }
    return { pid: process.pid };
  };
  function dispatch(value: unknown): void {
    const message = exactObject(value, ['kind', 'id', 'method', 'payload']);
    if (message.kind !== 'request') throw new TypeError('expected parent request');
    identifier(message.id);
    try {
      let result: unknown;
      if (message.method === 'init') result = initialize(message.payload);
      else if (message.method === 'init-virtual') result = initializeVirtual(message.payload);
      else {
        if (!runtime || !scope) throw new Error('worker is not initialized');
        if (message.method === 'snapshot') {
          if (message.payload !== null) throw new TypeError('invalid snapshot request');
          result = capture();
        } else if (message.method === 'import') {
          restore(message.payload as RuntimeSnapshotV1); result = null;
        } else if (message.method === 'close') {
          if (message.payload !== null) throw new TypeError('invalid close request');
          send({ kind: 'response', id: message.id, ok: true, value: null }); process.exit(0);
        } else if (message.method === 'call') {
          if (virtualAdmission) {
            if (virtualAdmission.version === 3) {
              validateProcessVirtualArtifactV3(virtualAdmission.artifact, virtualAdmission.lineage);
              assertProcessVirtualWorkerBundleV1(virtualAdmission.artifact, launchedPath);
            } else {
              assertProcessWorkerPipeCustodyV1(virtualAdmission.artifact.executableSubject.manifest.bundle);
              validatePackagedProcessVirtualArtifactV4(virtualAdmission.artifact,
                virtualAdmission.lineage, launchedPath);
            }
          }
          const call = exactObject(message.payload, ['symbol', 'args', 'snapshot', 'operationId']);
          identifier(call.symbol); identifier(call.operationId);
          if (!Array.isArray(call.args)) throw new TypeError('invalid call arguments');
          const snapshot = call.snapshot as RuntimeSnapshotV1;
          fromWireSnapshot(snapshot, scope);
          const args = call.args.map(value => decodeProcessValue(value as TaggedValueV1, scope!, snapshot));
          restore(snapshot);
          executions.push({ operationId: call.operationId, nextBoundary: 0 });
          try {
            const execution = runtime.call(call.symbol as SymbolId, args);
            const final = capture();
            result = { execution: encodeProcessExecution(execution, scope, final), snapshot: final, pid: process.pid };
          } finally { executions.pop(); }
        } else throw new TypeError('unknown worker request');
      }
      send({ kind: 'response', id: message.id, ok: true, value: result });
    } catch (error) {
      send({ kind: 'response', id: message.id, ok: false, value: error instanceof Error ? error.message : 'worker request rejected' });
    }
  }
  for (;;) dispatch(read());
}

try { main(); }
catch { process.exit(1); } // EOF, malformed frames and bad MACs are terminal; never log session data.
