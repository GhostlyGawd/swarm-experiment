import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, arch, release, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePackedGuest, sha256 } from '../packed-hvf-guest/build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const destination = resolve(process.argv[2] ?? join(here, 'results/local-01.json'));
const paths = [
  'roadmap/v4/research/hvf-map-coalescing/registration.md',
  'roadmap/v4/research/hvf-map-coalescing/driver.c',
  'roadmap/v4/research/hvf-map-coalescing/run.ts',
  'roadmap/v4/research/hvf-map-coalescing/verify.ts',
  'roadmap/v4/research/packed-hvf-guest/guest.c',
  'roadmap/v4/research/packed-hvf-guest/start.S',
  'roadmap/v4/research/packed-hvf-guest/kernel.ld',
  'roadmap/v4/research/packed-hvf-guest/build.ts',
  'roadmap/v4/research/native/hypervisor.entitlements',
];
if (platform() !== 'darwin' || arch() !== 'arm64') throw new Error('Apple Silicon required');
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: root, encoding: 'utf8' });
if (dirty.trim()) throw new Error(`campaign source is dirty:\n${dirty}`);
const temp = mkdtempSync('/tmp/aether-hvf-map-');
try {
  const guest = compilePackedGuest(temp);
  const driver = join(temp, 'map-driver');
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', join(here, 'driver.c'),
    '-framework', 'Hypervisor', '-o', driver]);
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements',
    join(root, 'roadmap/v4/research/native/hypervisor.entitlements'), driver]);
  const raw = JSON.parse(execFileSync(driver, [guest.image], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  }));
  const evidence = {
    format: 'aether.hvf-map-coalescing-evidence/1',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceFiles: paths.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
    binary: { guestSha256: guest.guestSha256, driverSha256: sha256(readFileSync(driver)) },
    environment: { os: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model,
      compiler: guest.compiler, linker: guest.linker,
      hypervisor: 'Apple Hypervisor.framework EL1 AArch64' },
    raw,
  };
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
  console.log(destination);
} finally { rmSync(temp, { recursive: true, force: true }); }
