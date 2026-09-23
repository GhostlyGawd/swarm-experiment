import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { typeName } from '../../../../src/tier1/ids.ts';
import { PackedHeap, type PackedLayout } from '../../../../src/tier3/packed-heap.ts';
import { MACHINE_LIMITS, type MachineRecord } from '../../../../src/tier3/resumable-state.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../../..');
const reportPath = resolve(process.argv[2] ?? join(here, 'results/local-01/report.json'));
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const u32 = (bytes: Buffer, offset: number) => bytes.readUInt32LE(offset);
const u64 = (bytes: Buffer, offset: number) => bytes.readBigUInt64LE(offset);
const MASK = (1n << 64n) - 1n;
const mix = (h: bigint, value: bigint, alive: bigint, id: bigint, epoch: bigint) =>
  (h * 1099511628211n + value + (alive << 11n) + id * 17n + epoch * 31n) & MASK;
const next = (state: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
const readBits = (bytes: Buffer, offset: number, width: number) => {
  let value = 0;
  for (let bit = 0; bit < width; bit++) value += ((bytes[(offset + bit) >>> 3] >>> ((offset + bit) & 7)) & 1) * 2 ** bit;
  return value;
};
const med = (values: number[]) => [...values].sort((a, b) => a - b)[3];
const distributions = ['local', 'cluster', 'wide'];
const patterns = ['scan', 'scatter', 'chase'];
const arms = ['baseline', 'packedAbi', 'packedValidated', 'packedFusedChecked'];
const recordType = { t: 'Record' as const, name: typeName('type:bench:native_locality'), fields:
  [['number', { t: 'Int' as const }], ['alive', { t: 'Bool' as const }], ['link', { t: 'Unit' as const }]] as const };

assert(report.format === 'aether.packed-fused-locality/1' && report.preregistration === 'roadmap/v4/research/packed-fused-locality/PREREGISTRATION.md', 'report identity');
assert(report.profile.operationsPerTrial === 100000 && report.profile.warmups === 5 && report.profile.measuredTrials === 7 &&
  JSON.stringify(report.profile.counts) === '[4096,16384]' && JSON.stringify(report.profile.distributions) === JSON.stringify(distributions) &&
  JSON.stringify(report.profile.patterns) === JSON.stringify(patterns), 'report profile');
assert(Array.isArray(report.cases) && report.cases.length === 6, 'case count');
const sourceFiles = [
  'roadmap/v4/research/packed-fused-locality/PREREGISTRATION.md',
  'roadmap/v4/research/packed-fused-locality/run.ts',
  'roadmap/v4/research/packed-fused-locality/native.c',
  'roadmap/v4/research/packed-fused-locality/adversarial.c',
  'roadmap/v4/research/packed-fused-locality/verify.ts',
  'roadmap/v4/research/packed-heap/abi.c',
  'roadmap/v4/research/packed-heap/abi.h',
  'src/tier3/packed-heap.ts',
  'src/tier3/resumable-state.ts',
  'src/fabric/encoding.ts',
  'src/fabric/identity.ts',
  'src/tier1/ids.ts',
];
assert(JSON.stringify(Object.keys(report.source.sha256).sort()) === JSON.stringify(sourceFiles.sort()), 'source manifest completeness');
assert(typeof report.source.gitHead === 'string' && /^[a-f0-9]{40}$/.test(report.source.gitHead), 'pinned commit syntax');
for (const [path, digest] of Object.entries(report.source.sha256)) {
  assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), `source hash syntax: ${path}`);
  assert(sha(readFileSync(join(repository, path))) === digest, `source hash mismatch: ${path}`);
  const pinned = execFileSync('git', ['show', `${report.source.gitHead}:${path}`], { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
  assert(sha(pinned) === digest, `pinned commit source mismatch: ${path}`);
}
assert(typeof report.source.nativeBinarySha256 === 'string' && /^[a-f0-9]{64}$/.test(report.source.nativeBinarySha256), 'native binary digest syntax');
assert(typeof report.source.adversarialBinarySha256 === 'string' && /^[a-f0-9]{64}$/.test(report.source.adversarialBinarySha256), 'adversarial binary digest syntax');
assert(report.host.compiler === execFileSync('clang', ['--version'], { encoding: 'utf8' }).split('\n')[0], 'compiler identity mismatch');
const expectedCompilerArgs = ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', './roadmap/v4/research/packed-heap',
  './roadmap/v4/research/packed-heap/abi.c', './roadmap/v4/research/packed-fused-locality/native.c', '-o', '<temporary-executable>'];
assert(JSON.stringify(report.host.compileArgs) === JSON.stringify(expectedCompilerArgs), 'compiler command mismatch');
const expectedAdversarialArgs = [...expectedCompilerArgs];
expectedAdversarialArgs[expectedAdversarialArgs.length - 3] = './roadmap/v4/research/packed-fused-locality/adversarial.c';
assert(JSON.stringify(report.host.adversarialCompileArgs) === JSON.stringify(expectedAdversarialArgs), 'adversarial compiler command mismatch');
const temporary = mkdtempSync(join(tmpdir(), 'aether-fused-locality-verify-'));
try {
  const executable = join(temporary, 'native');
  const compile = spawnSync('clang', ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I',
    join(repository, 'roadmap/v4/research/packed-heap'), join(repository, 'roadmap/v4/research/packed-heap/abi.c'),
    join(here, 'native.c'), '-o', executable], { encoding: 'utf8' });
  assert(compile.status === 0, `native recompilation failed: ${compile.stderr}`);
  assert(sha(readFileSync(executable)) === report.source.nativeBinarySha256, 'native binary digest mismatch');
  const adversarialExecutable = join(temporary, 'adversarial');
  const adversarialCompile = spawnSync('clang', ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I',
    join(repository, 'roadmap/v4/research/packed-heap'), join(repository, 'roadmap/v4/research/packed-heap/abi.c'),
    join(here, 'adversarial.c'), '-o', adversarialExecutable], { encoding: 'utf8' });
  assert(adversarialCompile.status === 0, `adversarial recompilation failed: ${adversarialCompile.stderr}`);
  assert(sha(readFileSync(adversarialExecutable)) === report.source.adversarialBinarySha256, 'adversarial binary digest mismatch');
  const adversarialRun = spawnSync(adversarialExecutable, [], { encoding: 'utf8' });
  assert(adversarialRun.status === 0 && JSON.stringify(JSON.parse(adversarialRun.stdout)) === JSON.stringify(report.adversarial) &&
    report.adversarial.validParityRows === 192192 && report.adversarial.invalidCases === 13, 'adversarial replay mismatch');
} finally { rmSync(temporary, { recursive: true, force: true }); }
for (const count of [4096, 16384]) for (let distribution = 0; distribution < 3; distribution++) {
  const label = distributions[distribution], item = report.cases.find((value: any) => value.count === count && value.distribution === label);
  assert(item, `missing ${count}/${label}`);
  assert(item.fixture === `fixture-${count}-${label}.bin`, `fixture name: ${label}`);
  const bytes = readFileSync(join(dirname(reportPath), item.fixture));
  assert(sha(bytes) === item.fixtureSha256, `fixture hash: ${label}`);
  const prior = readFileSync(join(repository, 'roadmap/v4/research/packed-native-locality/results/local-01', item.fixture));
  assert(bytes.equals(prior) && sha(prior) === item.priorFixtureSha256, `prior fixture identity: ${label}`);
  assert(bytes.subarray(0, 8).toString('ascii') === 'AENLOC01' && u32(bytes, 8) === count && u32(bytes, 12) === 10 &&
    u32(bytes, 32) === distribution && u32(bytes, 36) === 0, `fixture header: ${label}`);
  const maxRelative = distribution === 2 ? count - 1 : 63;
  const refWidth = (2 * maxRelative + 1).toString(2).length, rowBits = 11 + refWidth;
  const payloadLength = Math.ceil(count * rowBits / 8);
  assert(u32(bytes, 16) === refWidth && u32(bytes, 20) === rowBits && u32(bytes, 24) === payloadLength &&
    u32(bytes, 28) === maxRelative && bytes.length === 40 + count * 40 + payloadLength && item.payloadBytes === payloadLength, `fixture dimensions: ${label}`);
  const payload = bytes.subarray(40 + count * 40);
  let seed = 0x734e6a21 ^ count;
  const logical: { id: bigint; epoch: bigint; version: bigint; value: number; alive: number; target: number }[] = [];
  const records: MachineRecord[] = [];
  const indegree = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const group = Math.floor(i / 64) * 64;
    if (distribution === 2) seed = next(seed);
    const target = distribution === 0 ? group + (i + 1) % 64 : distribution === 1 ? group : seed % count;
    const offset = 40 + i * 40, id = u64(bytes, offset), epoch = u64(bytes, offset + 8), version = u64(bytes, offset + 16);
    const value = u32(bytes, offset + 24), alive = bytes[offset + 28];
    assert(id === BigInt(i + 1) && epoch === BigInt(1 + i % 7) && version === BigInt(i % 3) &&
      value === (i * 17 + count) % 1001 && alive === Number(i % 3 !== 0) &&
      bytes[offset + 29] === 0 && bytes[offset + 30] === 0 && bytes[offset + 31] === 0 &&
      u32(bytes, offset + 32) === target && u32(bytes, offset + 36) === 0, `logical row ${i}: ${label}`);
    logical.push({ id, epoch, version, value, alive, target }); indegree[target]++;
    records.push({ id: String(id), epoch: String(epoch), version: String(version), ty: recordType,
      fields: [['number', { tag: 'int', value: String(value) }], ['alive', { tag: 'bool', value: Boolean(alive) }],
        ['link', { tag: 'ref', value: { heapId: 'heap:native-locality', objectId: String(target + 1), ownerEpoch: String(1 + target % 7) } }]] });
  }
  let mapChecksum = 0n;
  for (let i = 0; i < count; i++) {
    const row = logical[i], bit = i * rowBits;
    const value = readBits(payload, bit, 10), alive = readBits(payload, bit + 10, 1), code = readBits(payload, bit + 11, refWidth);
    const target = code & 1 ? i + (code - 1) / 2 : i - code / 2;
    assert(code !== 0 && Math.abs(target - i) <= maxRelative && target === row.target &&
      value === row.value && alive === row.alive, `packed row ${i}: ${label}`);
    mapChecksum = mix(mapChecksum, BigInt(value) + row.version, BigInt(alive), logical[target].id, logical[target].epoch);
  }
  assert(item.mappingChecksum === String(mapChecksum) && item.aliasTargets === [...indegree].filter(n => n > 1).length, `mapping summary: ${label}`);
  const layout: PackedLayout = { typeName: recordType.name, fields: [
    { name: 'number', kind: 'int', min: '0', max: '1000', overflow: 'trap' }, { name: 'alive', kind: 'bool' },
    { name: 'link', kind: 'ref', maxRelative },
  ] };
  const image = PackedHeap.pack(records, 'heap:native-locality', [layout]).image();
  assert(image.format === 'aether.packed-heap/1' && Buffer.from(image.bytes, 'base64').equals(payload) &&
    image.layoutDigest === item.layoutDigest && image.imageDigest === item.imageDigest &&
    encodeCanonical(records, MACHINE_LIMITS).byteLength === item.logicalCanonicalBytes &&
    encodeCanonical(image, MACHINE_LIMITS).byteLength === item.packedImageCanonicalBytes, `actual image mapping: ${label}`);
  assert(item.baselineRowBytes >= 40 && item.packedRowBytes >= 28 &&
    item.baselineBytes === count * item.baselineRowBytes && item.packedBytes === count * item.packedRowBytes + payloadLength &&
    item.packedToBaselineAllocationRatio === item.packedBytes / item.baselineBytes, `allocation summary: ${label}`);
  assert(item.patterns.length === 3, `pattern count: ${label}`);
  for (let p = 0; p < 3; p++) {
    const pattern = item.patterns[p]; assert(pattern.name === patterns[p] && pattern.arms.length === 4, `pattern identity: ${label}`);
    let checksum = 0n, index = 0, random = (0x62ca1234 ^ count ^ distribution) >>> 0;
    for (let step = 0; step < 100000; step++) {
      if (p === 0) index = step % count;
      else if (p === 1) { random = next(random); index = random % count; }
      const row = logical[index], target = logical[row.target];
      checksum = mix(checksum, BigInt(row.value), BigInt(row.alive), target.id, target.epoch);
      if (p === 2) index = row.target;
    }
    assert(pattern.expectedChecksum === String(checksum), `pattern checksum: ${label}/${pattern.name}`);
    for (let armIndex = 0; armIndex < 4; armIndex++) {
      const arm = pattern.arms[armIndex]; assert(arm.name === arms[armIndex] && arm.samples.length === 7, `arm identity: ${label}/${pattern.name}`);
      const samples = arm.samples.map((sample: any) => {
        assert(Number.isSafeInteger(sample.ns) && sample.ns > 0 && sample.checksum === String(checksum), `raw sample: ${label}/${pattern.name}/${arm.name}`);
        return sample.ns;
      });
      assert(arm.medianNs === med(samples) && arm.maxNs === Math.max(...samples) &&
        arm.medianRatioToBaseline === arm.medianNs / pattern.arms[0].medianNs, `statistics: ${label}/${pattern.name}/${arm.name}`);
    }
  }
}
process.stdout.write(`verified 6 fixtures, 61,440 rows, 18 patterns, 504 raw timed samples, 192,192 parity rows: ${reportPath}\n`);
