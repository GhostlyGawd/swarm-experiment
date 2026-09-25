/** Root-controller-only volume provisioning; key bytes arrive on stdin. */
import { closeSync, existsSync, fchmodSync, fchownSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface Directory { path: string; uid: number; gid: number; mode: number }
interface File extends Directory { base64: string }
const input = JSON.parse(readFileSync(0, 'utf8')) as { directories: Directory[]; files: File[] };
function path(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('/run/aether/')
    || resolve(value) !== value || value.includes('/../')) throw new TypeError('volume path outside custody root');
  return value;
}
function identity(value: Directory): void {
  if (!Number.isSafeInteger(value.uid) || value.uid < 0 || !Number.isSafeInteger(value.gid) || value.gid < 0
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777)
    throw new TypeError('invalid custody owner/mode');
}
if (!Array.isArray(input.directories) || !Array.isArray(input.files)) throw new TypeError('custody setup lists');
for (const row of input.directories) {
  identity(row); const target = path(row.path);
  mkdirSync(target, { recursive: true, mode: row.mode });
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('custody directory symlink');
  const fd = openSync(target, 'r');
  try { fchownSync(fd, row.uid, row.gid); fchmodSync(fd, row.mode); fsyncSync(fd); }
  finally { closeSync(fd); }
}
for (const row of input.files) {
  identity(row); const target = path(row.path), parent = path(dirname(target));
  if (!existsSync(parent)) throw new TypeError('custody file parent missing');
  if (typeof row.base64 !== 'string' || Buffer.from(row.base64, 'base64').toString('base64') !== row.base64)
    throw new TypeError('noncanonical custody file bytes');
  const fd = openSync(target, 'wx', row.mode);
  try { writeFileSync(fd, Buffer.from(row.base64, 'base64'));
    fchownSync(fd, row.uid, row.gid); fchmodSync(fd, row.mode); fsyncSync(fd); }
  finally { closeSync(fd); }
  const dirFd = openSync(parent, 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}
process.stdout.write(JSON.stringify({ directories: input.directories.length, files: input.files.length }) + '\n');
