import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, arch, release, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePackedGuest, sha256 } from '../build.ts';
import { executePackedCheckpointGuest } from '../bridge.ts';
import { checkpointFixture } from './fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const destination = resolve(process.argv[2] ?? join(here, 'results/local-01.json'));
const paths = [
  'roadmap/v4/research/packed-hvf-guest/campaign/registration.md',
  'roadmap/v4/research/packed-hvf-guest/campaign/driver.c',
  'roadmap/v4/research/packed-hvf-guest/campaign/fixture.ts',
  'roadmap/v4/research/packed-hvf-guest/campaign/run.ts',
  'roadmap/v4/research/packed-hvf-guest/campaign/verify.ts',
  'roadmap/v4/research/packed-hvf-guest/bridge.ts',
  'roadmap/v4/research/packed-hvf-guest/build.ts',
  'roadmap/v4/research/packed-hvf-guest/guest.c',
  'roadmap/v4/research/packed-hvf-guest/start.S',
  'roadmap/v4/research/packed-hvf-guest/kernel.ld',
  'roadmap/v4/research/native/hypervisor.entitlements',
  'src/tier3/packed-heap.ts',
  'src/tier3/resumable-runtime.ts',
  'src/tier3/resumable-state.ts',
];
if (platform() !== 'darwin' || arch() !== 'arm64') throw new Error('Apple Silicon required');
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: root, encoding: 'utf8' });
if (dirty.trim()) throw new Error(`campaign source is dirty:\n${dirty}`);
const temp = mkdtempSync('/tmp/aether-packed-hvf-hot-');
try {
  const guest = compilePackedGuest(temp), driver = join(temp, 'campaign-driver');
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', join(here, 'driver.c'),
    '-framework', 'Hypervisor', '-o', driver]);
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements',
    join(root, 'roadmap/v4/research/native/hypervisor.entitlements'), driver]);
  const { runtime, packed, operations } = checkpointFixture();
  const result = executePackedCheckpointGuest({ packed, program: runtime.program,
    expectedSnapshotDigest: packed.snapshotDigest, expectedLayoutDigest: packed.heap.layoutDigest,
    driver, guestImage: guest.image, expectedDriverSha256: sha256(readFileSync(driver)),
    expectedGuestSha256: guest.guestSha256, operations, campaign: true });
  const evidence = {
    format: 'aether.packed-hvf-hot-campaign-evidence/1',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceFiles: paths.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
    binary: { guestSha256: guest.guestSha256, driverSha256: sha256(readFileSync(driver)),
      guestBytes: readFileSync(guest.image).length },
    environment: { os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model,
      compiler: guest.compiler, linker: guest.linker,
      hypervisor: 'Apple Hypervisor.framework EL1 AArch64' },
    profile: { records: 16, operations: operations.length, warmups: 20, samples: 1000,
      boundary: 'fresh guest on already-running controller' },
    input: { snapshotDigest: packed.snapshotDigest, layoutDigest: packed.heap.layoutDigest,
      imageDigest: packed.heap.imageDigest, operations },
    result: { candidateImageDigest: result.candidateHeap.imageDigest,
      observations: result.observations, diagnostics: result.diagnostics },
  };
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
  console.log(destination);
} finally { rmSync(temp, { recursive: true, force: true }); }
