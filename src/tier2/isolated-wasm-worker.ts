/** Disposable worker for the import-free Wasm i32 profile. No broker, sink,
 * grant or credential is imported into this process. */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { decodeCanonical, encodeCanonical, exactObject } from '../fabric/encoding.ts';

const LIMITS = { maxFrameBytes: 256 * 1024, maxDecompressedBytes: 256 * 1024, maxObjects: 128, maxDepth: 8 };
const SHA256 = /^[0-9a-f]{64}$/;
// This package compiles without the DOM/ES WebAssembly TypeScript lib.
interface WasmModule {}
declare const WebAssembly: {
  Module: { new(bytes: Uint8Array): WasmModule;
    imports(module: WasmModule): readonly { module: string; name: string; kind: string }[];
    exports(module: WasmModule): readonly { name: string; kind: string }[] };
  Instance: new(module: WasmModule, imports: Record<string, never>) => { exports: Record<string, unknown> };
};

class Cursor {
  pos: number;
  readonly bytes: Uint8Array;
  readonly end: number;
  constructor(bytes: Uint8Array, end: number, start = 0) { this.bytes = bytes; this.end = end; this.pos = start; }
  byte(): number { if (this.pos >= this.end) throw new TypeError('truncated wasm'); return this.bytes[this.pos++]; }
  uint(): number {
    let result = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = this.byte();
      if (shift === 28 && (byte & 0xf0)) throw new TypeError('wasm varuint overflow');
      result += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return result;
    }
    throw new TypeError('wasm varuint too long');
  }
  name(): string {
    const length = this.uint();
    if (this.pos + length > this.end) throw new TypeError('truncated wasm name');
    const value = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length; return value;
  }
  done(): void { if (this.pos !== this.end) throw new TypeError('wasm section trailing bytes'); }
}

interface Signature { params: number[]; results: number[] }
/** Parse only the sections needed to prove the declared ABI and resource cap.
 * The engine validates all sections after these profile checks. */
function assertProfile(bytes: Uint8Array, maxMemoryPages: number): WasmModule {
  if (bytes.length < 8 || Buffer.compare(Buffer.from(bytes.subarray(0, 8)), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) !== 0) throw new TypeError('wasm header/version');
  const c = new Cursor(bytes, bytes.length, 8);
  const types: Signature[] = [], functions: number[] = [];
  let memory: { min: number; max: number } | null = null;
  const exports = new Map<string, { kind: number; index: number }>();
  let lastSection = 0;
  while (c.pos < c.end) {
    const id = c.byte(), length = c.uint(), end = c.pos + length;
    if (end > c.end) throw new TypeError('wasm section length');
    if (id !== 0 && (id <= lastSection || id > 13)) throw new TypeError('wasm section ordering');
    if (id !== 0) lastSection = id;
    const s = new Cursor(bytes, end, c.pos);
    if (id === 1) {
      const n = s.uint(); if (n > 1024) throw new RangeError('wasm type count');
      for (let i = 0; i < n; i++) {
        if (s.byte() !== 0x60) throw new TypeError('wasm function type');
        const params: number[] = [], results: number[] = [];
        const p = s.uint(); if (p > 32) throw new RangeError('wasm parameter count');
        for (let j = 0; j < p; j++) params.push(s.byte());
        const r = s.uint(); if (r > 32) throw new RangeError('wasm result count');
        for (let j = 0; j < r; j++) results.push(s.byte());
        types.push({ params, results });
      }
      s.done();
    } else if (id === 2) {
      if (s.uint() !== 0) throw new TypeError('wasm imports forbidden');
      s.done();
    } else if (id === 3) {
      const n = s.uint(); if (n > 1024) throw new RangeError('wasm function count');
      for (let i = 0; i < n; i++) functions.push(s.uint());
      s.done();
    } else if (id === 4) {
      if (s.uint() !== 0) throw new TypeError('wasm tables forbidden');
      s.done();
    } else if (id === 5) {
      if (s.uint() !== 1) throw new TypeError('exactly one wasm memory required');
      if (s.uint() !== 1) throw new TypeError('wasm memory maximum required; shared/memory64 forbidden');
      memory = { min: s.uint(), max: s.uint() };
      s.done();
    } else if (id === 7) {
      const n = s.uint(); if (n !== 2) throw new TypeError('exactly two wasm exports required');
      for (let i = 0; i < n; i++) {
        const name = s.name(), kind = s.byte(), index = s.uint();
        if (exports.has(name)) throw new TypeError('duplicate wasm export');
        exports.set(name, { kind, index });
      }
      s.done();
    } else if (id === 8) throw new TypeError('wasm start function forbidden');
    c.pos = end;
  }
  if (!memory || memory.min > memory.max || memory.max > maxMemoryPages) throw new RangeError('wasm linear memory exceeds declared bound');
  const run = exports.get('run');
  if (!run || run.kind !== 0 || !functions[run.index] && functions[run.index] !== 0) throw new TypeError('wasm run export missing');
  const signature = types[functions[run.index]];
  if (!signature || signature.params.length !== 1 || signature.params[0] !== 0x7f || signature.results.length !== 1 || signature.results[0] !== 0x7f) throw new TypeError('wasm run(i32)->i32 ABI required');
  const memoryExport = exports.get('memory');
  if (!memoryExport || memoryExport.kind !== 2 || memoryExport.index !== 0) throw new TypeError('wasm memory export missing');
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length !== 0) throw new TypeError('wasm imports forbidden');
  const engineExports = WebAssembly.Module.exports(module);
  if (engineExports.length !== 2 || !engineExports.some(e => e.name === 'run' && e.kind === 'function') || !engineExports.some(e => e.name === 'memory' && e.kind === 'memory')) throw new TypeError('wasm exports mismatch');
  return module;
}

async function main(): Promise<void> {
  const parts: Buffer[] = []; let length = 0;
  for await (const part of process.stdin) {
    const bytes = Buffer.from(part); length += bytes.length;
    if (length > LIMITS.maxFrameBytes) throw new RangeError('wasm IPC frame bound');
    parts.push(bytes);
  }
  const request = exactObject(decodeCanonical(Buffer.concat(parts), LIMITS),
    ['format', 'mode', 'wasmBase64', 'sha256', 'maxMemoryPages', 'requestDigest', 'input']);
  if (request.format !== 'aether.isolated-wasm-request/1' || !['probe', 'run'].includes(request.mode as string)) throw new TypeError('wasm IPC version/mode');
  if (typeof request.wasmBase64 !== 'string' || request.wasmBase64.length > 175_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.wasmBase64)) throw new TypeError('wasm base64 encoding');
  const bytes = Buffer.from(request.wasmBase64, 'base64');
  if (bytes.length < 8 || bytes.length > 128 * 1024 || bytes.toString('base64') !== request.wasmBase64) throw new RangeError('wasm byte bound');
  if (typeof request.sha256 !== 'string' || !SHA256.test(request.sha256) || createHash('sha256').update(bytes).digest('hex') !== request.sha256) throw new TypeError('wasm source hash mismatch');
  if (!Number.isSafeInteger(request.maxMemoryPages) || (request.maxMemoryPages as number) < 1 || (request.maxMemoryPages as number) > 256) throw new RangeError('wasm configured memory bound');
  const module = assertProfile(bytes, request.maxMemoryPages as number);
  let value: number | null = null;
  if (request.mode === 'run') {
    if (typeof request.requestDigest !== 'string' || !/^aether\.effect\/1:b3:[0-9a-f]{64}$/.test(request.requestDigest)) throw new TypeError('wasm request digest');
    if (typeof request.input !== 'number' || !Number.isInteger(request.input) || request.input < -2147483648 || request.input > 2147483647) throw new TypeError('wasm i32 input');
    const instance = new WebAssembly.Instance(module, {});
    const run = instance.exports.run;
    if (typeof run !== 'function') throw new TypeError('wasm run export');
    value = run(request.input) as number;
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new TypeError('wasm i32 output');
  } else if (request.requestDigest !== null || request.input !== null) throw new TypeError('wasm probe envelope');
  const response = { format: 'aether.isolated-wasm-response/1', status: 'ok', sha256: request.sha256,
    requestDigest: request.requestDigest, value };
  process.stdout.write(encodeCanonical(response, LIMITS));
}

main().catch(() => { process.stderr.write('isolated_wasm_worker_rejected\n'); process.exitCode = 1; });
