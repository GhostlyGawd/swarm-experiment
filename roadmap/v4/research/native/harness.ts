import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../../../../src/tier3/runtime.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import * as b from '../../../../src/tier1/build.ts';
import { lowerI64, nativeFixtures, NATIVE_HEADER, NATIVE_ABI } from './lower.ts';

export const DIRECTORY = dirname(fileURLToPath(import.meta.url));
export function sha256(bytes: Uint8Array | string): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
export function compileNative(output: string) {
  mkdirSync(output, { recursive: true });
  const fixture = nativeFixtures(), functions = fixture.operations.map(operation => lowerI64(operation.fn, operation.name)), fee = lowerI64(fixture.fee);
  writeFileSync(join(output, 'generated.h'), NATIVE_HEADER + functions.map(fn => fn.source).join('\n') + fee.source);
  writeFileSync(join(output, 'kernel.c'), NATIVE_HEADER + fee.source);
  const driver = join(output, 'native-driver');
  execFileSync('cc', ['-std=c11', '-O3', '-Wall', '-Wextra', '-Werror', '-I', output, join(DIRECTORY, 'driver.c'), '-o', driver]);
  execFileSync('cc', ['-std=c11', '-O3', '-S', '-I', output, join(DIRECTORY, 'driver.c'), '-o', join(output, 'native-driver.s')]);
  return { driver, abi: NATIVE_ABI, astRoots: { fee: fee.astRoot, arithmetic: functions.map(fn => fn.astRoot) }, compiler: execFileSync('cc', ['--version'], { encoding: 'utf8' }).trim() };
}
export function compileBoot(output: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple-silicon Hypervisor.framework target unavailable on this host');
  const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
  const linker = join(sysroot, 'lib/rustlib/aarch64-apple-darwin/bin/gcc-ld/ld.lld');
  const flags = ['-target', 'aarch64-none-elf', '-ffreestanding', '-fno-stack-protector', '-fno-builtin', '-nostdlib'];
  execFileSync('clang', [...flags, '-O3', '-c', join(output, 'kernel.c'), '-o', join(output, 'kernel.o')]);
  execFileSync('clang', [...flags, '-c', join(DIRECTORY, 'start.S'), '-o', join(output, 'start.o')]);
  const objects = [join(output, 'start.o'), join(output, 'kernel.o')];
  execFileSync(linker, ['-T', join(DIRECTORY, 'kernel.ld'), ...objects, '-o', join(output, 'kernel.elf')]);
  execFileSync(linker, ['-T', join(DIRECTORY, 'kernel.ld'), '--oformat=binary', ...objects, '-o', join(output, 'kernel.bin')]);
  const elf = readFileSync(join(output, 'kernel.elf'));
  if (elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 2 || elf[5] !== 1 || elf.readBigUInt64LE(24) !== 0x40000000n) throw new Error('unexpected native boot image ABI/entry');
  const boot = join(output, 'native-boot');
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', join(DIRECTORY, 'boot.c'), '-framework', 'Hypervisor', '-o', boot]);
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', join(DIRECTORY, 'hypervisor.entitlements'), boot], { stdio: 'pipe' });
  return { boot, image: join(output, 'kernel.bin'), linker, linkerVersion: execFileSync(linker, ['--version'], { encoding: 'utf8' }).trim(), hostSignature: execFileSync('codesign', ['--display', '--entitlements', ':-', boot], { encoding: 'utf8', stdio: 'pipe' }).trim() };
}
export function conformance(driver: string) {
  const fixture = nativeFixtures(), runtime = new Runtime({ registry: new CapabilityRegistry(), symbols: fixture.syms });
  runtime.load(b.module_({ symbol: fixture.syms.define('native-conformance'), symbolTable: fixture.syms.table(), members: fixture.operations.map(operation => operation.fn) }));
  const edges = [-(1n << 63n), -(1n << 63n) + 1n, -201n, -200n, -1n, 0n, 1n, 2n, 199n, 200n, 201n, (1n << 63n) - 2n, (1n << 63n) - 1n];
  const pairs: Array<[bigint, bigint]> = edges.flatMap(first => edges.map(second => [first, second] as [bigint, bigint]));
  let state = 0x726f322dn;
  const next = () => { state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n); return BigInt.asIntN(64, state); };
  for (let i = 0; i < 100; i++) pairs.push([next(), next()]);
  const cases = fixture.operations.flatMap((operation, index) => pairs.map(([first, second]) => {
    if (operation.fn.kind !== 'FunctionDecl') throw new Error('native fixture is not a function');
    const reference = runtime.call(operation.fn.symbol, [first, second]);
    return { operation: index, inputs: [String(first), String(second)], expectedStatus: reference.ok ? 0 : reference.fault.kind === 'division_by_zero' ? 2 : 1, expectedValue: reference.ok ? String(reference.value) : '0' };
  }));
  const input = cases.map(item => `${item.operation} ${item.inputs.join(' ')}`).join('\n') + '\n';
  const lines = execFileSync(driver, ['--check'], { input, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n');
  if (lines.length !== cases.length) throw new Error('native response count mismatch');
  const observations = cases.map((item, index) => {
    const [status, value] = lines[index].split(' ');
    if (Number(status) !== item.expectedStatus || value !== item.expectedValue) throw new Error(`native/reference mismatch at case ${index}: ${lines[index]}`);
    return { ...item, actualStatus: Number(status), actualValue: value };
  });
  const fallback = JSON.parse(execFileSync(driver, ['--fallback-check'], { encoding: 'utf8' }));
  if (!fallback.threeTiers || !fallback.rollbackPreserved || !fallback.revocationTrap) throw new Error('native fallback conformance failed');
  return { seed: '0x726f322d / PCG LCG constants, signed64 output', cases: observations, fallback };
}
export function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length || sorted.some(value => !Number.isFinite(value) || value < 0)) throw new Error('invalid native timing samples');
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1)!, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length };
}
export async function bootSample(boot: string, image: string): Promise<Record<string, number | string>> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(boot, [image]);
    let output = '', error = '', firstResponseNs: number | null = null;
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('guest boot timed out after 10 seconds')); }, 10000);
    child.stdout.on('data', chunk => { output += String(chunk); if (firstResponseNs === null && output.includes('\n')) firstResponseNs = Number(process.hrtime.bigint() - started); });
    child.stderr.on('data', chunk => { error += String(chunk); });
    child.on('error', failure => { clearTimeout(timeout); reject(failure); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || firstResponseNs === null) { reject(new Error(`guest boot failed: ${code}; ${error}`)); return; }
      try { resolve({ ...JSON.parse(output), processLaunchToResponseNs: firstResponseNs }); } catch (failure) { reject(failure); }
    });
  });
}
