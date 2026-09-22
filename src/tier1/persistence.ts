import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const BIGINT_TAG = '$aether_bigint';

export function encodeStored(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? { [BIGINT_TAG]: item.toString() } : item,
  );
}

export function decodeStored<T>(text: string): T {
  return JSON.parse(text, (_key, item) => {
    if (item && typeof item === 'object' && Object.keys(item).length === 1 && BIGINT_TAG in item) {
      return BigInt(item[BIGINT_TAG]);
    }
    return item;
  }) as T;
}

export function readStored<T>(path: string): T {
  return decodeStored<T>(readFileSync(path, 'utf8'));
}

/** Atomic replacement in one directory, with the bytes flushed before rename. */
export function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${path.split('/').at(-1)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/** Write-once variant used for content-addressed objects. */
export function atomicWriteOnce(path: string, contents: string): void {
  withFileLock(`${path}.lock`, () => {
    if (!existsSync(path)) atomicWrite(path, contents);
  });
}

export function withFileLock<T>(lockPath: string, operation: () => T, timeoutMs = 5_000): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return operation();
  } finally {
    closeSync(fd);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}
