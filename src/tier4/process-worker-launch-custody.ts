/** Host-only Artifact/4 launch custody. Node reads verified ESM bytes from
 * anonymous stdin; it never opens the mutable bundle pathname to run JS. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { MeasuredFileV2 } from './process-virtual-artifact-v4-core.ts';

export const PROCESS_WORKER_LAUNCH_CUSTODY_V1 = 'aether.process-worker-launch-custody/1';
export const PROCESS_WORKER_PROTOCOL_FD = 5;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export interface PreparedProcessWorkerLaunchV1 {
  readonly format: typeof PROCESS_WORKER_LAUNCH_CUSTODY_V1;
  readonly measured: MeasuredFileV2;
  /** Executes the already measured memory bytes. This object is one-shot. */
  spawn(options: SpawnOptions): ChildProcess;
  close(): void;
}

/** After this returns, pathname mutation cannot alter the bytes delivered to
 * Node. A simultaneous mutation during acquisition either reproduces the
 * signed hash or fails before any child is spawned. */
export function prepareProcessWorkerLaunchV1(measured: MeasuredFileV2): PreparedProcessWorkerLaunchV1 {
  if (!measured || typeof measured.path !== 'string' || !measured.path.startsWith('/')
    || !Number.isSafeInteger(measured.bytes) || measured.bytes < 1
    || measured.bytes > MAX_BUNDLE_BYTES || !/^[a-f0-9]{64}$/.test(measured.sha256))
    throw new TypeError('invalid measured worker bundle');
  const expected = Object.freeze({ path: measured.path, bytes: measured.bytes,
    sha256: measured.sha256 });
  const fd = openSync(expected.path, 'r');
  let code: Buffer;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== expected.bytes)
      throw new TypeError('worker bundle changed before launch custody');
    code = Buffer.allocUnsafe(expected.bytes);
    let at = 0;
    while (at < code.length) {
      const count = readSync(fd, code, at, code.length - at, at);
      if (!count) throw new TypeError('worker bundle truncated during launch custody');
      at += count;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || createHash('sha256').update(code).digest('hex') !== expected.sha256)
      throw new TypeError('worker bundle bytes changed during launch custody');
  } finally { closeSync(fd); }
  let consumed = false;
  return {
    format: PROCESS_WORKER_LAUNCH_CUSTODY_V1, measured: expected,
    spawn(options: SpawnOptions): ChildProcess {
      if (consumed) throw new TypeError('worker launch custody is one-shot');
      consumed = true;
      const child = spawn(process.execPath,
        ['--input-type=module', '-',
          expected.path, PROCESS_WORKER_LAUNCH_CUSTODY_V1, expected.sha256],
        { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
      child.stdin!.on('error', () => { /* Spawn/EOF is handled by the channel. */ });
      child.stdin!.end(code);
      code = Buffer.alloc(0);
      return child;
    },
    close(): void { consumed = true; code = Buffer.alloc(0); },
  };
}
