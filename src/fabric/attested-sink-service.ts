/** A bounded, separately launched append-once effect sink fixture.
 *
 * It exposes signed decisions only after the decision, value and receipt
 * have been atomically replaced and fsynced in the sink's own store.
 * This is a real external append to that store, not proof about another system.
 */
import { createHmac, createPublicKey, randomBytes, randomUUID, timingSafeEqual, type KeyObject } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { decodeCanonical, encodeCanonical, exactObject, identifier, type EncodingLimits, type TaggedValueV1 } from './encoding.ts';
import { effectRequestDigest, validateEffectRequest, type EffectRequestV1 } from './effects.ts';
import { validateDigest } from './identity.ts';
import { JournalLock } from './journal-lock.ts';
import { signSinkReceipt, validateSinkPublicAnchor, validateSignedSinkReceipt, verifySinkReceipt, sinkValueDigest,
  type SignedSinkReceiptV1, type SinkPublicAnchorV1, type SinkReceiptBodyV1 } from './sink-receipt.ts';

const FORMAT = 'aether.attested-sink-service/1';
const STATE_FORMAT = 'aether.attested-sink-state/1';
const MAX_FRAME = 64 * 1024;
const MAX_STATE = 8 * 1024 * 1024;
const MAX_DECISIONS = 1024;
const LIMITS = { maxFrameBytes: MAX_FRAME, maxDecompressedBytes: MAX_FRAME, maxObjects: 1024, maxDepth: 24, maxIntegerDigits: 40 } as const;
const STATE_LIMITS = { ...LIMITS, maxFrameBytes: MAX_STATE, maxDecompressedBytes: MAX_STATE, maxObjects: 200_000 };
const HEX = /^[0-9a-f]{64}$/;
const WIRE_WORKER = `import net from 'node:net';
const s=net.createConnection(process.argv[1]);
s.on('connect',()=>process.stdin.pipe(s));
s.on('data',c=>{if(!process.stdout.write(c))s.pause()});
process.stdout.on('drain',()=>s.resume());
s.on('error',()=>process.exitCode=3);
s.on('end',()=>{if(!s.destroyed)s.destroy()});
`;

export interface AttestedSinkServiceOptions {
  readonly socketPath: string;
  readonly storageDir: string;
  readonly authKey: Uint8Array;
  readonly privateKey: KeyObject;
  readonly anchor: SinkPublicAnchorV1;
  readonly adapterArtifactDigest: string;
}
export interface AttestedSinkService { readonly socketPath: string; close(): Promise<void> }
export interface AttestedSinkClientOptions {
  readonly socketPath: string;
  readonly authKey: Uint8Array;
  /** Operator-provisioned public anchor, independent of response bytes. */
  readonly anchor: SinkPublicAnchorV1;
  readonly adapterArtifactDigest: string;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly timeoutMs?: number;
}
export type AttestedSinkDecision =
  | Readonly<{ state: 'committed'; value: TaggedValueV1; receipt: SignedSinkReceiptV1 }>
  | Readonly<{ state: 'not_committed'; receipt: SignedSinkReceiptV1 }>
  | Readonly<{ state: 'unknown' }>;

interface DecisionRow {
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly request: EffectRequestV1;
  readonly value: TaggedValueV1 | null;
  readonly receipt: SignedSinkReceiptV1;
}
interface SinkState { readonly format: typeof STATE_FORMAT; readonly anchor: SinkPublicAnchorV1; readonly decisions: readonly DecisionRow[] }

function canonical(value: unknown, limits: Partial<EncodingLimits> = LIMITS): Buffer { return Buffer.from(encodeCanonical(value, limits)); }
function parse(bytes: Buffer, limits: Partial<EncodingLimits> = LIMITS): unknown {
  const value = decodeCanonical(bytes, limits);
  if (!canonical(value, limits).equals(bytes)) throw new TypeError('noncanonical sink data');
  return value;
}
function wire(value: unknown): Buffer {
  const bytes = canonical(value);
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}
function unwire(bytes: Buffer): unknown {
  if (bytes.length < 4) throw new TypeError('incomplete sink frame');
  const length = bytes.readUInt32BE(0);
  if (!length || length > MAX_FRAME || bytes.length !== length + 4) throw new TypeError('invalid sink frame');
  return parse(bytes.subarray(4));
}
function keyBytes(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 32) throw new TypeError('sink auth key requires 32 bytes');
  return Buffer.from(value);
}
function mac(key: Buffer, body: unknown): string { return createHmac('sha256', key).update(canonical(body)).digest('hex'); }
function matchMac(key: Buffer, body: unknown, value: unknown): boolean {
  return typeof value === 'string' && HEX.test(value)
    && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(mac(key, body), 'hex'));
}
function same(left: unknown, right: unknown): boolean { return canonical(left).equals(canonical(right)); }
function decisionKey(repositoryId: string, deploymentId: string, request: EffectRequestV1): string {
  return JSON.stringify([repositoryId, deploymentId, request.executionId, request.effectId]);
}
function assertPaths(socketPath: string, storageDir: string): void {
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(storageDir)) throw new TypeError('sink paths must be absolute');
  const parent = fs.lstatSync(path.dirname(socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o022))
    throw new Error('sink socket parent must be private to service user');
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(storageDir);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077))
    throw new Error('sink storage directory must be private');
}
function stateFile(dir: string): string { return path.join(dir, 'sink-state.json'); }
function readState(dir: string, anchor: SinkPublicAnchorV1, adapterArtifactDigest: string): SinkState {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(stateFile(dir)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: STATE_FORMAT, anchor, decisions: [] };
    throw error;
  }
  const state = exactObject(parse(bytes, STATE_LIMITS), ['format', 'anchor', 'decisions']);
  if (state.format !== STATE_FORMAT || !same(state.anchor, anchor) || !Array.isArray(state.decisions)
    || state.decisions.length > MAX_DECISIONS) throw new Error('sink state identity or capacity mismatch');
  const seen = new Set<string>();
  for (let index = 0; index < state.decisions.length; index++) {
    const row = exactObject(state.decisions[index], ['repositoryId', 'deploymentId', 'request', 'value', 'receipt']);
    identifier(row.repositoryId); identifier(row.deploymentId);
    validateEffectRequest(row.request, LIMITS); validateSignedSinkReceipt(row.receipt);
    const request = row.request as EffectRequestV1;
    const receipt = row.receipt as SignedSinkReceiptV1;
    const id = decisionKey(row.repositoryId as string, row.deploymentId as string, request);
    if (seen.has(id)) throw new Error('duplicate sink decision');
    seen.add(id);
    if (receipt.body.sinkSequence !== String(index + 1) || row.repositoryId !== anchor.repositoryId
      || !verifySinkReceipt(receipt, anchor, { repositoryId: row.repositoryId as string,
        deploymentId: row.deploymentId as string, request, sinkAuthorityId: anchor.sinkAuthorityId,
        sinkId: anchor.sinkId, adapterArtifactDigest, disposition: receipt.body.disposition,
        value: row.value as TaggedValueV1 | null })) throw new Error('invalid stored sink decision');
  }
  return state as unknown as SinkState;
}
function writeState(dir: string, state: SinkState): void {
  const dest = stateFile(dir), tmp = path.join(dir, `.sink-${randomBytes(16).toString('hex')}.tmp`);
  const bytes = canonical(state, STATE_LIMITS);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, dest);
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function decide(dir: string, options: AttestedSinkServiceOptions, op: 'execute' | 'status',
  repositoryId: string, deploymentId: string, request: EffectRequestV1): AttestedSinkDecision {
  if (repositoryId !== options.anchor.repositoryId) throw new Error('DENIED');
  const state = readState(dir, options.anchor, options.adapterArtifactDigest);
  const id = decisionKey(repositoryId, deploymentId, request);
  const prior = state.decisions.find(row => decisionKey(row.repositoryId, row.deploymentId, row.request) === id);
  if (prior) {
    if (effectRequestDigest(prior.request, LIMITS) !== effectRequestDigest(request, LIMITS)) throw new Error('CONFLICT');
    if (prior.receipt.body.disposition === 'not_committed') {
      if (op === 'execute') throw new Error('FENCED');
      return { state: 'not_committed', receipt: prior.receipt };
    }
    return { state: 'committed', value: prior.value!, receipt: prior.receipt };
  }
  if (state.decisions.length >= MAX_DECISIONS) throw new Error('CAPACITY');
  const committed = op === 'execute';
  const value = committed ? request.payload : null;
  const body: SinkReceiptBodyV1 = {
    format: 'aether.sink-receipt-body/1', repositoryId, deploymentId, executionId: request.executionId,
    effectId: request.effectId, requestDigest: effectRequestDigest(request, LIMITS), payloadDigest: request.payloadDigest,
    sinkAuthorityId: options.anchor.sinkAuthorityId, sinkId: options.anchor.sinkId,
    adapterArtifactDigest: options.adapterArtifactDigest, policyEpoch: request.policyEpoch,
    capabilityGrantRef: request.capabilityGrantRef, keyId: options.anchor.keyId,
    keyEpoch: options.anchor.keyEpoch, disposition: committed ? 'committed' : 'not_committed',
    valueDigest: value === null ? null : sinkValueDigest(value), decisionId: randomUUID(),
    commitId: committed ? randomUUID() : null, sinkSequence: String(state.decisions.length + 1),
  };
  const receipt = signSinkReceipt(body, options.privateKey, options.anchor);
  const row: DecisionRow = { repositoryId, deploymentId, request, value, receipt };
  // A single replacement makes effect, result and signed receipt one decision.
  writeState(dir, { ...state, decisions: [...state.decisions, row] });
  return committed ? { state: 'committed', value: value!, receipt } : { state: 'not_committed', receipt };
}
function response(key: Buffer, nonce: string, decision: AttestedSinkDecision | null, code: string | null): Buffer {
  const body = { format: FORMAT, nonce, decision, code };
  return wire({ ...body, mac: mac(key, body) });
}
function processRequest(bytes: Buffer, key: Buffer, options: AttestedSinkServiceOptions): Buffer | null {
  let request: Record<string, unknown>;
  try {
    request = exactObject(unwire(bytes), ['format', 'nonce', 'op', 'repositoryId', 'deploymentId', 'request', 'mac']);
    if (request.format !== FORMAT || typeof request.nonce !== 'string' || !HEX.test(request.nonce)
      || (request.op !== 'execute' && request.op !== 'status')) return null;
    const body = { format: request.format, nonce: request.nonce, op: request.op,
      repositoryId: request.repositoryId, deploymentId: request.deploymentId, request: request.request };
    if (!matchMac(key, body, request.mac)) return null;
  } catch { return null; }
  const nonce = request.nonce as string;
  try {
    identifier(request.repositoryId); identifier(request.deploymentId);
    validateEffectRequest(request.request, LIMITS);
    const result = decide(options.storageDir, options, request.op as 'execute' | 'status',
      request.repositoryId as string, request.deploymentId as string, request.request as EffectRequestV1);
    return response(key, nonce, result, null);
  } catch (error) {
    const code = error instanceof Error && ['DENIED', 'CONFLICT', 'FENCED', 'CAPACITY'].includes(error.message)
      ? error.message : 'UNCERTAIN';
    return response(key, nonce, null, code);
  }
}

export async function startAttestedSinkService(options: AttestedSinkServiceOptions): Promise<AttestedSinkService> {
  const key = keyBytes(options.authKey);
  validateSinkPublicAnchor(options.anchor); validateDigest(options.adapterArtifactDigest, 'aether.effect-adapter-artifact/1');
  if (options.privateKey.type !== 'private' || options.privateKey.asymmetricKeyType !== 'ed25519'
    || createPublicKey(options.privateKey).export({ format: 'der', type: 'spki' }).toString('base64') !== options.anchor.publicKey)
    throw new TypeError('sink private key does not match anchor');
  assertPaths(options.socketPath, options.storageDir);
  readState(options.storageDir, options.anchor, options.adapterArtifactDigest);
  const lock = new JournalLock({ directory: path.join(options.storageDir, '.service-lock'), domain: FORMAT,
    maxTickets: 10_000, busyError: 'sink storage already served' });
  lock.recoverDeadWriter(false);
  let release!: () => void;
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  let ready!: (service: AttestedSinkService) => void, failed!: (error: unknown) => void;
  const started = new Promise<AttestedSinkService>((resolve, reject) => { ready = resolve; failed = reject; });
  const serving = lock.runAsync(async () => {
    try {
      try {
        const prior = fs.lstatSync(options.socketPath);
        if (!prior.isSocket()) throw new Error('sink socket path occupied');
        await new Promise<void>((resolve, reject) => {
          const probe = net.createConnection(options.socketPath);
          probe.once('connect', () => { probe.destroy(); reject(new Error('sink socket already live')); });
          probe.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
        });
        fs.unlinkSync(options.socketPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const server = net.createServer({ allowHalfOpen: true }, socket => {
        const chunks: Buffer[] = []; let size = 0;
        socket.setTimeout(5000, () => socket.destroy());
        socket.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_FRAME + 4 || (size >= 4 && Buffer.concat([...chunks, chunk], Math.min(size, 4)).readUInt32BE(0) > MAX_FRAME)) {
            socket.destroy(); return;
          }
          chunks.push(chunk);
        });
        socket.on('end', () => {
          const reply = processRequest(Buffer.concat(chunks, size), key, options);
          if (reply) socket.end(reply); else socket.destroy();
        });
        socket.on('error', () => socket.destroy());
      });
      server.maxConnections = 4;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.socketPath, () => { server.off('error', reject); resolve(); });
      });
      fs.chmodSync(options.socketPath, 0o600);
      ready({ socketPath: options.socketPath, close: async () => {
        try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { release(); await serving; }
      } });
      await lifetime;
    } catch (error) { failed(error); throw error; }
  }, 250);
  serving.catch(failed);
  return started;
}

export function createAttestedSinkClient(options: AttestedSinkClientOptions): {
  execute(request: EffectRequestV1): Extract<AttestedSinkDecision, { state: 'committed' }>;
  status(request: EffectRequestV1): AttestedSinkDecision;
} {
  const key = keyBytes(options.authKey);
  validateSinkPublicAnchor(options.anchor); validateDigest(options.adapterArtifactDigest, 'aether.effect-adapter-artifact/1');
  identifier(options.repositoryId); identifier(options.deploymentId);
  if (options.repositoryId !== options.anchor.repositoryId || !path.isAbsolute(options.socketPath))
    throw new TypeError('sink client context mismatch');
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new TypeError('invalid sink timeout');
  const call = (op: 'execute' | 'status', request: EffectRequestV1): AttestedSinkDecision => {
    validateEffectRequest(request, LIMITS);
    const nonce = randomBytes(32).toString('hex');
    const body = { format: FORMAT, nonce, op, repositoryId: options.repositoryId,
      deploymentId: options.deploymentId, request };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', WIRE_WORKER, options.socketPath],
      { input: wire({ ...body, mac: mac(key, body) }), encoding: 'buffer', maxBuffer: MAX_FRAME + 4, timeout });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error('uncertain sink response');
    const parsed = exactObject(unwire(result.stdout), ['format', 'nonce', 'decision', 'code', 'mac']);
    const signed = { format: parsed.format, nonce: parsed.nonce, decision: parsed.decision, code: parsed.code };
    if (parsed.format !== FORMAT || parsed.nonce !== nonce || !matchMac(key, signed, parsed.mac))
      throw new Error('uncertain sink response');
    if (parsed.code !== null) {
      if (!['DENIED', 'CONFLICT', 'FENCED', 'CAPACITY', 'UNCERTAIN'].includes(parsed.code as string))
        throw new Error('uncertain sink response');
      throw new Error(`sink ${parsed.code}`);
    }
    const d = exactObject(parsed.decision, ['state', ...( (parsed.decision as { state?: unknown })?.state === 'committed'
      ? ['value', 'receipt'] : ['receipt'])]);
    if (d.state !== 'committed' && d.state !== 'not_committed') throw new Error('uncertain sink response');
    const value = d.state === 'committed' ? d.value as TaggedValueV1 : null;
    if (!verifySinkReceipt(d.receipt, options.anchor, {
      repositoryId: options.repositoryId, deploymentId: options.deploymentId, request,
      sinkAuthorityId: options.anchor.sinkAuthorityId, sinkId: options.anchor.sinkId,
      adapterArtifactDigest: options.adapterArtifactDigest, disposition: d.state, value,
    })) throw new Error('uncertain sink response');
    return d as unknown as AttestedSinkDecision;
  };
  return {
    execute: request => {
      const result = call('execute', request);
      if (result.state !== 'committed') throw new Error('sink did not commit');
      return result;
    },
    status: request => { try { return call('status', request); } catch { return { state: 'unknown' }; } },
  };
}
