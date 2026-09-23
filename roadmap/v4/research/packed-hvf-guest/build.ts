import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const sha256 = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function compilePackedGuest(output: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple silicon Hypervisor.framework target required');
  mkdirSync(output, { recursive: true });
  const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
  const linker = join(sysroot, 'lib/rustlib/aarch64-apple-darwin/bin/gcc-ld/ld.lld');
  const freestanding = ['-target', 'aarch64-none-elf', '-ffreestanding', '-fno-stack-protector', '-fno-builtin', '-nostdlib', '-Wall', '-Wextra', '-Werror'];
  execFileSync('clang', [...freestanding, '-O2', '-c', join(here, 'guest.c'), '-o', join(output, 'guest.o')]);
  execFileSync('clang', [...freestanding, '-c', join(here, 'start.S'), '-o', join(output, 'start.o')]);
  const objects = [join(output, 'start.o'), join(output, 'guest.o')];
  const image = join(output, 'guest.bin'), elfPath = join(output, 'guest.elf');
  execFileSync(linker, ['-T', join(here, 'kernel.ld'), ...objects, '-o', elfPath]);
  execFileSync(linker, ['-T', join(here, 'kernel.ld'), '--oformat=binary', ...objects, '-o', image]);
  const elf = readFileSync(elfPath), guest = readFileSync(image);
  if (elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 2 || elf[5] !== 1 ||
      elf.readBigUInt64LE(24) !== 0x40000000n || guest.length === 0 || guest.length > 16384)
    throw new TypeError('unexpected packed guest ABI/size');
  const driver = join(output, 'driver');
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', join(here, 'driver.c'), '-framework', 'Hypervisor', '-o', driver]);
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', join(here, '../native/hypervisor.entitlements'), driver]);
  return {
    driver, image, elfPath, guestSha256: sha256(guest), driverSha256: sha256(readFileSync(driver)),
    compiler: execFileSync('clang', ['--version'], { encoding: 'utf8' }).split('\n')[0],
    linker: execFileSync(linker, ['--version'], { encoding: 'utf8' }).trim(),
  };
}
