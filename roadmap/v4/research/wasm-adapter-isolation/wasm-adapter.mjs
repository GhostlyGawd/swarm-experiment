import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { effectRequestDigest } from '../../../../src/fabric/effects.ts';

// Research ABI: one i32 -> i32 export and no imports. Internal memory, start
// code, and loops are not ruled out, so resource isolation remains open.
const EXPECTED_EXPORTS = [{ name: 'run', kind: 'function' }];
const SHA256 = /^[0-9a-f]{64}$/;
const ADMITTED_GUESTS = new WeakSet();
const SEMANTICS = Object.freeze({
  readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true,
});

export function wasmSha256(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Wasm bytes required');
  return createHash('sha256').update(bytes).digest('hex');
}

export function admitPureWasmGuest(inputBytes, expectedSha256) {
  if (!(inputBytes instanceof Uint8Array) || !inputBytes.byteLength || inputBytes.byteLength > 65_536 || !SHA256.test(expectedSha256)) {
    throw new TypeError('Wasm bytes and exact SHA-256 required');
  }
  // Copy caller-owned memory before hashing or compiling. There is no await
  // between these operations and no later read from the original buffer.
  const bytes = Buffer.from(inputBytes);
  if (wasmSha256(bytes) !== expectedSha256) throw new Error('Wasm artifact digest mismatch');
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error('Wasm guest imports are forbidden');
  if (JSON.stringify(WebAssembly.Module.exports(module)) !== JSON.stringify(EXPECTED_EXPORTS)) {
    throw new Error('Wasm guest export ABI mismatch');
  }
  const guest = Object.freeze({
    sha256: expectedSha256,
    // Instantiation and execution happen only inside EffectAdapter.execute,
    // after DurableEffectBroker has recorded its dispatch-started marker.
    run(value) {
      if (!Number.isInteger(value) || value < 0 || value > 0x7ffffffe) throw new RangeError('guest input outside nonoverflowing i32 range');
      const instance = new WebAssembly.Instance(module, {});
      const output = instance.exports.run(value);
      if (!Number.isInteger(output) || output < 0 || output > 0x7fffffff) throw new TypeError('invalid guest output');
      return output;
    },
  });
  ADMITTED_GUESTS.add(guest);
  return guest;
}

export function hostFileSink(path, artifactSha256, afterDurableWrite = () => {}) {
  if (!SHA256.test(artifactSha256)) throw new TypeError('invalid artifact SHA-256');
  return Object.freeze({
    artifactSha256,
    write(request, value) {
      const record = {
        format: 'aether.wasm-adapter-sink/1',
        requestDigest: effectRequestDigest(request), artifactSha256, value,
      };
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); }
      finally { closeSync(fd); }
      const dir = openSync(dirname(path), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
      afterDurableWrite();
      return value;
    },
    reconcile(request) {
      if (!existsSync(path)) return { state: 'unknown' };
      try {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (record.format !== 'aether.wasm-adapter-sink/1'
          || record.requestDigest !== effectRequestDigest(request)
          || record.artifactSha256 !== artifactSha256
          || record.value?.tag !== 'int'
          || !/^(0|[1-9][0-9]*)$/.test(record.value.value)) return { state: 'unknown' };
        return { state: 'committed', value: record.value };
      } catch { return { state: 'unknown' }; }
    },
  });
}

export function wasmEffectAdapter(guest, sink) {
  if (!guest || !ADMITTED_GUESTS.has(guest)) throw new TypeError('admitted Wasm guest required');
  if (!sink || typeof sink.write !== 'function' || typeof sink.reconcile !== 'function') throw new TypeError('trusted host sink required');
  if (sink.artifactSha256 !== guest.sha256) throw new Error('host sink artifact identity mismatch');
  return Object.freeze({
    id: `adapter:wasm-pure/${guest.sha256}`,
    semantics: SEMANTICS,
    execute(request) {
      if (request.payload.tag !== 'int' || !/^(0|[1-9][0-9]*)$/.test(request.payload.value)) throw new TypeError('i32 payload required');
      const output = guest.run(Number(request.payload.value));
      return sink.write(request, { tag: 'int', value: String(output) });
    },
    reconcile(request) { return sink.reconcile(request); },
  });
}
