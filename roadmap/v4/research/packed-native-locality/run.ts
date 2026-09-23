import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { typeName } from '../../../../src/tier1/ids.ts';
import { PackedHeap, type PackedLayout } from '../../../../src/tier3/packed-heap.ts';
import { MACHINE_LIMITS, type MachineRecord } from '../../../../src/tier3/resumable-state.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../../..');
const output = resolve(process.argv[2] ?? join(here, 'results/local-01'));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const distNames = ['local', 'cluster', 'wide'] as const;
const counts = [4096, 16384] as const;
const sourceFiles = [
  'roadmap/v4/research/packed-native-locality/PREREGISTRATION.md',
  'roadmap/v4/research/packed-native-locality/run.ts',
  'roadmap/v4/research/packed-native-locality/native.c',
  'roadmap/v4/research/packed-native-locality/verify.ts',
  'roadmap/v4/research/packed-heap/abi.c',
  'roadmap/v4/research/packed-heap/abi.h',
  'src/tier3/packed-heap.ts',
  'src/tier3/resumable-state.ts',
  'src/fabric/encoding.ts',
  'src/fabric/identity.ts',
  'src/tier1/ids.ts',
];
const name = typeName('type:bench:native_locality');
const ty = { t: 'Record' as const, name, fields: [['number', { t: 'Int' as const }], ['alive', { t: 'Bool' as const }], ['link', { t: 'Unit' as const }]] as const };
const write64 = (view: DataView, offset: number, value: bigint) => view.setBigUint64(offset, value, true);
function rows(count: number, distribution: number): { records: MachineRecord[]; targets: number[] } {
  let seed = 0x734e6a21 ^ count;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const targets: number[] = [];
  const records = Array.from({ length: count }, (_, ordinal): MachineRecord => {
    const group = Math.floor(ordinal / 64) * 64;
    const target = distribution === 0 ? group + (ordinal + 1) % 64 : distribution === 1 ? group : random() % count;
    targets.push(target);
    return { id: String(ordinal + 1), epoch: String(1 + ordinal % 7), version: String(ordinal % 3), ty,
      fields: [['number', { tag: 'int', value: String((ordinal * 17 + count) % 1001) }], ['alive', { tag: 'bool', value: ordinal % 3 !== 0 }],
        ['link', { tag: 'ref', value: { heapId: 'heap:native-locality', objectId: String(target + 1), ownerEpoch: String(1 + target % 7) } }]] };
  });
  return { records, targets };
}
function makeFixture(count: number, distribution: number) {
  const { records, targets } = rows(count, distribution);
  const maxRelative = distribution === 2 ? count - 1 : 63;
  const layout: PackedLayout = { typeName: name, fields: [
    { name: 'number', kind: 'int', min: '0', max: '1000', overflow: 'trap' }, { name: 'alive', kind: 'bool' },
    { name: 'link', kind: 'ref', maxRelative },
  ] };
  const heap = PackedHeap.pack(records, 'heap:native-locality', [layout]);
  const image = heap.image();
  if (image.format !== 'aether.packed-heap/1') throw new Error('unexpected packed image format');
  const decoded = PackedHeap.fromImage(image);
  if (decoded.rows.length !== count || decoded.byteLength !== heap.byteLength) throw new Error('packed image round trip failed');
  const payload = Buffer.from(image.bytes, 'base64');
  const refWidth = (2 * maxRelative + 1).toString(2).length;
  const rowBits = 11 + refWidth;
  if (payload.length !== Math.ceil(count * rowBits / 8)) throw new Error('unexpected packed row width');
  const fixture = Buffer.alloc(40 + count * 40 + payload.length), view = new DataView(fixture.buffer, fixture.byteOffset, fixture.byteLength);
  fixture.write('AENLOC01', 0, 'ascii');
  [count, 10, refWidth, rowBits, payload.length, maxRelative, distribution, 0].forEach((value, i) => view.setUint32(8 + i * 4, value, true));
  for (let i = 0; i < count; i++) {
    const offset = 40 + i * 40, record = records[i];
    write64(view, offset, BigInt(record.id)); write64(view, offset + 8, BigInt(record.epoch)); write64(view, offset + 16, BigInt(record.version));
    view.setUint32(offset + 24, Number((record.fields[0][1] as { value: string }).value), true);
    view.setUint8(offset + 28, (record.fields[1][1] as { value: boolean }).value ? 1 : 0);
    view.setUint32(offset + 32, targets[i], true);
  }
  payload.copy(fixture, 40 + count * 40);
  return { fixture, logicalCanonicalBytes: encodeCanonical(records, MACHINE_LIMITS).byteLength,
    packedImageCanonicalBytes: encodeCanonical(image, MACHINE_LIMITS).byteLength,
    layoutDigest: image.layoutDigest, imageDigest: image.imageDigest, payloadBytes: payload.length };
}
function summarize(native: any) {
  for (const pattern of native.patterns) {
    const baseline = pattern.arms[0];
    for (const arm of pattern.arms) {
      if (arm.samples.length !== 7 || arm.samples.some((sample: any) => sample.checksum !== pattern.expectedChecksum || !Number.isSafeInteger(sample.ns) || sample.ns <= 0)) throw new Error('invalid native trial');
      const values = arm.samples.map((sample: any) => sample.ns).sort((a: number, b: number) => a - b);
      arm.medianNs = values[3]; arm.maxNs = values[6];
    }
    for (const arm of pattern.arms) arm.medianRatioToBaseline = arm.medianNs / baseline.medianNs;
  }
  native.packedToBaselineAllocationRatio = native.packedBytes / native.baselineBytes;
  return native;
}
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'aether-native-locality-'));
try {
  const before = Object.fromEntries(sourceFiles.map(path => [path, sha(join(repository, path))]));
  const executable = join(temporary, 'native');
  const compilerArgs = ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', join(repository, 'roadmap/v4/research/packed-heap'),
    join(repository, 'roadmap/v4/research/packed-heap/abi.c'), join(here, 'native.c'), '-o', executable];
  const compile = spawnSync('clang', compilerArgs, { encoding: 'utf8' });
  if (compile.status !== 0) throw new Error(`native compile failed: ${compile.stderr}`);
  const cases = [];
  for (const count of counts) for (let distribution = 0; distribution < distNames.length; distribution++) {
    const generated = makeFixture(count, distribution);
    const fixtureName = `fixture-${count}-${distNames[distribution]}.bin`;
    const fixturePath = join(output, fixtureName); writeFileSync(fixturePath, generated.fixture);
    process.stderr.write(`measuring ${count} ${distNames[distribution]}\n`);
    const run = spawnSync(executable, [fixturePath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
    if (run.status !== 0) throw new Error(`native run failed: ${run.stderr || run.error?.message}`);
    const native = summarize(JSON.parse(run.stdout));
    if (native.count !== count || native.distribution !== distribution || native.payloadBytes !== generated.payloadBytes) throw new Error('native fixture identity mismatch');
    cases.push({ ...native, count, distribution: distNames[distribution], fixture: fixtureName, fixtureSha256: sha(fixturePath),
      logicalCanonicalBytes: generated.logicalCanonicalBytes, packedImageCanonicalBytes: generated.packedImageCanonicalBytes,
      layoutDigest: generated.layoutDigest, imageDigest: generated.imageDigest });
  }
  const after = Object.fromEntries(sourceFiles.map(path => [path, sha(join(repository, path))]));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('source changed during campaign');
  const report = { format: 'aether.packed-native-locality/1', preregistration: 'roadmap/v4/research/packed-native-locality/PREREGISTRATION.md',
    timestamp: new Date().toISOString(), source: { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: repository }).trim(),
      sha256: after, nativeBinarySha256: sha(executable) },
    host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model ?? 'unknown',
      node: process.version, compiler: execFileSync('clang', ['--version'], { encoding: 'utf8' }).split('\n')[0],
      compileArgs: compilerArgs.map(arg => arg === executable ? '<temporary-executable>' : arg.replace(repository, '.')) },
    profile: { counts, distributions: distNames, patterns: ['scan', 'scatter', 'chase'], operationsPerTrial: 100000,
      warmups: 5, measuredTrials: 7, clock: 'CLOCK_MONOTONIC', units: 'nanoseconds' }, cases };
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${join(output, 'report.json')}\n`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
