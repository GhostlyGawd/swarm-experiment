import { createHash } from 'node:crypto';
import { cpus, platform, arch, release } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { typeName } from '../../../../src/tier1/ids.ts';
import { PackedHeap, type PackedLayout } from '../../../../src/tier3/packed-heap.ts';
import { MACHINE_LIMITS, type MachineRecord, type MachineValue } from '../../../../src/tier3/resumable-state.ts';

const source = fileURLToPath(new URL('../../../../src/tier3/packed-heap.ts', import.meta.url));
const runner = fileURLToPath(import.meta.url);
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const type = { t: 'Record' as const, name: typeName('type:bench:packed_node'), fields: [['number', { t: 'Int' as const }], ['alive', { t: 'Bool' as const }], ['link', { t: 'Unit' as const }]] as const };
const ref = (target: number): MachineValue => ({ tag: 'ref', value: { heapId: 'heap:packed-bench', objectId: String(target), ownerEpoch: '1' } });
function make(count: number, distribution: 'local' | 'random'): MachineRecord[] {
  let seed = 0x734e6a21;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  return Array.from({ length: count }, (_, index) => {
    const target = distribution === 'local' ? Math.min(index + 2, count) : (next() % count) + 1;
    return { id: String(index + 1), epoch: '1', version: '0', ty: type, fields: [
      ['number', { tag: 'int', value: String((index * 17) % 1001) }],
      ['alive', { tag: 'bool', value: index % 2 === 0 }],
      ['link', ref(target)],
    ] };
  });
}
const sample = (fn: () => number): { ms: number; checksum: number } => { const start = process.hrtime.bigint(), checksum = fn(); return { ms: Number(process.hrtime.bigint() - start) / 1e6, checksum }; };
function campaign(count: number, distribution: 'local' | 'random') {
  const records = make(count, distribution);
  const layout: PackedLayout = { typeName: type.name, fields: [
    { name: 'number', kind: 'int', min: '0', max: '1000', overflow: 'trap' },
    { name: 'alive', kind: 'bool' },
    { name: 'link', kind: 'ref', maxRelative: distribution === 'local' ? 1 : count - 1 },
  ] };
  const heap = PackedHeap.pack(records, 'heap:packed-bench', [layout]), image = heap.image();
  const baseline = new Map(records.map(row => [row.id, row]));
  const baselineRead = () => {
    let id = '1', checksum = 0;
    for (let i = 0; i < 100_000; i++) {
      const row = baseline.get(id)!;
      const number = row.fields[0][1] as Extract<MachineValue, { tag: 'int' }>;
      const alive = row.fields[1][1] as Extract<MachineValue, { tag: 'bool' }>;
      const link = row.fields[2][1] as Extract<MachineValue, { tag: 'ref' }>;
      checksum = (checksum + Number(number.value) + Number(alive.value)) >>> 0;
      id = link.value.objectId;
    }
    return checksum;
  };
  const packedRead = () => {
    let id = '1', checksum = 0;
    for (let i = 0; i < 100_000; i++) {
      const number = heap.get(id, 'number') as Extract<MachineValue, { tag: 'int' }>;
      const alive = heap.get(id, 'alive') as Extract<MachineValue, { tag: 'bool' }>;
      const link = heap.get(id, 'link') as Extract<MachineValue, { tag: 'ref' }>;
      checksum = (checksum + Number(number.value) + Number(alive.value)) >>> 0;
      id = link.value.objectId;
    }
    return checksum;
  };
  for (let warmup = 0; warmup < 5; warmup++) { const a = baselineRead(), b = packedRead(); if (a !== b) throw new Error('packed/baseline traversal mismatch'); }
  const baselineSamples = Array.from({ length: 7 }, () => sample(baselineRead));
  const packedSamples = Array.from({ length: 7 }, () => sample(packedRead));
  if (baselineSamples.some((entry, i) => entry.checksum !== packedSamples[i].checksum)) throw new Error('measured traversal mismatch');
  const median = (samples: readonly { ms: number }[]) => samples.map(item => item.ms).sort((a, b) => a - b)[3];
  return { count, distribution, layout, baselineCanonicalRecordBytes: encodeCanonical(records, MACHINE_LIMITS).byteLength,
    packedPayloadBytes: heap.byteLength, packedImageCanonicalBytes: encodeCanonical(image, MACHINE_LIMITS).byteLength,
    baselineSamples, packedSamples, baselineMedianMs: median(baselineSamples), packedMedianMs: median(packedSamples) };
}

let gitHead = 'unknown'; try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* hash pins are primary */ }
const result = { format: 'aether.packed-heap-local-campaign/1', preregistration: 'roadmap/v4/research/packed-heap/PREREGISTRATION.md',
  timestamp: new Date().toISOString(), host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model ?? 'unknown', node: process.version },
  source: { gitHead, packedHeapSha256: sha256(source), runnerSha256: sha256(runner) },
  trials: [campaign(1024, 'local'), campaign(1024, 'random'), campaign(4096, 'local'), campaign(4096, 'random')] };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
