/** Import-free, process-separated i32 effect computation. This is a narrow
 * read-only adapter profile: the child receives neither grants nor sinks. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeCanonical, encodeCanonical, exactObject, identifier, validateTaggedValue, type TaggedValueV1 } from '../fabric/encoding.ts';
import { effectRequestDigest, validateEffectRequest, type EffectAdapter, type EffectRequestV1 } from '../fabric/effects.ts';
import { capability, type CapabilityName } from '../tier1/ids.ts';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_WASM_BYTES = 64 * 1024;
const MAX_MEMORY_PAGES = 256;
const MAX_TIMEOUT_MS = 5_000;
const IPC_LIMITS = { maxFrameBytes: 256 * 1024, maxDecompressedBytes: 256 * 1024, maxObjects: 128, maxDepth: 8 };

export const ISOLATED_WASM_I32_SEMANTICS = Object.freeze({
  readOnly: true, atomicIdempotency: true, transactional: false, reconciliation: true,
} as const);

export interface IsolatedWasmAdapterOptions {
  /** Exact approved bytes; admission must obtain expectedSha256 independently. */
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
  readonly id: string;
  readonly capability: CapabilityName;
  readonly timeoutMs: number;
  /** Wasm linear-memory maximum in 64 KiB pages, at most 256. */
  readonly maxMemoryPages: number;
}

function workerPath(): string {
  const source = import.meta.url.endsWith('.ts');
  return fileURLToPath(new URL(source ? './isolated-wasm-worker.ts' : './isolated-wasm-worker.js', import.meta.url));
}

function runWorker(input: unknown, timeoutMs: number): Record<string, unknown> {
  const payload = encodeCanonical(input, IPC_LIMITS);
  const worker = workerPath();
  const child = spawnSync(process.execPath,
    [...(worker.endsWith('.ts') ? ['--experimental-strip-types'] : []), '--max-old-space-size=32', worker],
    { input: payload, encoding: 'buffer', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env: {}, cwd: '/', windowsHide: true });
  if (child.error) {
    if ((child.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw new Error('isolated_wasm_timeout');
    throw new Error('isolated_wasm_worker_failed');
  }
  if (child.signal || child.status !== 0) throw new Error('isolated_wasm_worker_failed');
  const output = exactObject(decodeCanonical(child.stdout, IPC_LIMITS), ['format', 'status', 'sha256', 'requestDigest', 'value']);
  if (output.format !== 'aether.isolated-wasm-response/1' || output.status !== 'ok') throw new Error('isolated_wasm_worker_failed');
  return output;
}

function i32(value: TaggedValueV1, expectedCapability: CapabilityName): number {
  validateTaggedValue(value);
  if (value.tag !== 'sequence' || value.items.length !== 2 || value.items[0].tag !== 'string'
    || value.items[0].value !== expectedCapability || value.items[1].tag !== 'int'
    || !/^(0|-?[1-9][0-9]*)$/.test(value.items[1].value)) throw new TypeError('isolated_wasm_i32_payload_required');
  const number = Number(value.items[1].value);
  if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) throw new RangeError('isolated_wasm_i32_payload_required');
  return number;
}

/** Admission parses/compiles exact bytes in a bounded disposable child. Each
 * invocation rechecks the same bytes there, then runs guest code with a hard
 * wall-clock timeout. This does not claim an OS-level sandbox against V8 bugs. */
export function createIsolatedWasmAdapter(options: IsolatedWasmAdapterOptions): EffectAdapter {
  identifier(options.id);
  capability(options.capability);
  if (!(options.bytes instanceof Uint8Array) || options.bytes.byteLength < 8 || options.bytes.byteLength > MAX_WASM_BYTES) throw new RangeError('isolated_wasm_byte_bound');
  if (!SHA256.test(options.expectedSha256)) throw new TypeError('isolated_wasm_expected_hash');
  if (!Number.isSafeInteger(options.maxMemoryPages) || options.maxMemoryPages < 1 || options.maxMemoryPages > MAX_MEMORY_PAGES) throw new RangeError('isolated_wasm_memory_bound');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) throw new RangeError('isolated_wasm_timeout_bound');
  const id = options.id, expectedCapability = options.capability;
  const timeoutMs = options.timeoutMs, maxMemoryPages = options.maxMemoryPages;
  const bytes = Buffer.from(options.bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== options.expectedSha256) throw new TypeError('isolated_wasm_source_mismatch');
  const base64 = bytes.toString('base64');
  const inputBase = { format: 'aether.isolated-wasm-request/1', wasmBase64: base64, sha256,
    maxMemoryPages } as const;
  const probe = runWorker({ ...inputBase, mode: 'probe', requestDigest: null, input: null }, timeoutMs);
  if (probe.sha256 !== sha256 || probe.requestDigest !== null || probe.value !== null) throw new Error('isolated_wasm_probe_mismatch');
  const adapter: EffectAdapter = {
    id,
    semantics: ISOLATED_WASM_I32_SEMANTICS,
    preflight(request: EffectRequestV1): void {
      validateEffectRequest(request);
      i32(request.payload, expectedCapability);
    },
    execute(request: EffectRequestV1): TaggedValueV1 {
      validateEffectRequest(request);
      const input = i32(request.payload, expectedCapability);
      const requestDigest = effectRequestDigest(request);
      const result = runWorker({ ...inputBase, mode: 'run', requestDigest, input }, timeoutMs);
      if (result.sha256 !== sha256 || result.requestDigest !== requestDigest
        || typeof result.value !== 'number' || !Number.isInteger(result.value)
        || result.value < -2147483648 || result.value > 2147483647) throw new Error('isolated_wasm_response_mismatch');
      return { tag: 'int', value: String(result.value) };
    },
    // No external work can occur through this import-free guest. A process
    // failure may lose a result, but never commits an external effect.
    reconcile(): { readonly state: 'not_committed' } { return { state: 'not_committed' }; },
  };
  return Object.freeze(adapter);
}
