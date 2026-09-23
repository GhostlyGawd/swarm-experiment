import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as b from '../../../../src/tier1/build.ts';
import { typeName } from '../../../../src/tier1/ids.ts';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { MACHINE_LIMITS, type MachineRecord } from '../../../../src/tier3/resumable-state.ts';
import { PackedHeap, type PackedLayout } from '../../../../src/tier3/packed-heap.ts';

const source = fileURLToPath(new URL('../../../../src/tier3/packed-heap.ts', import.meta.url));
const runner = fileURLToPath(import.meta.url);
const sha256 = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const name = typeName('type:research:packed_strings');
const ty = { t: 'Record' as const, name, fields: [['left', b.Str], ['right', b.Str], ['link', b.Unit]] as const };
const layout: PackedLayout = { typeName: name, fields: [
  { name: 'left', kind: 'string', maxUtf8Bytes: 32 },
  { name: 'right', kind: 'string', maxUtf8Bytes: 32 },
  { name: 'link', kind: 'ref', maxRelative: 1023 },
] };
const values = Array.from({ length: 1024 }, (_, index) => `value-${String(index).padStart(4, '0')}`);
const rows = (distinct: number): MachineRecord[] => Array.from({ length: 1024 }, (_, index) => ({
  id: String(index + 1), epoch: '7', version: '0', ty,
  fields: [
    ['left', { tag: 'string', value: values[index % distinct] }],
    ['right', { tag: 'string', value: values[(index * 17) % distinct] }],
    ['link', { tag: 'ref', value: { heapId: 'heap:string-size', objectId: String(Math.min(index + 2, 1024)), ownerEpoch: '7' } }],
  ],
}));
const scenarios = [4, 64, 1024].map(distinct => {
  const original = rows(distinct), image = PackedHeap.pack(original, 'heap:string-size', [layout]).image();
  const logical = encodeCanonical(original, MACHINE_LIMITS), unpacked = PackedHeap.fromImage(image, image.layoutDigest).unpack();
  if (Buffer.compare(logical, encodeCanonical(unpacked, MACHINE_LIMITS))) throw new Error('packed string round-trip mismatch');
  const completeImageBytes = encodeCanonical(image, MACHINE_LIMITS).byteLength;
  return {
    distinct, logicalRecordBytes: logical.byteLength, completeImageBytes,
    ratio: completeImageBytes / logical.byteLength,
    payloadBytes: Buffer.from(image.bytes, 'base64').byteLength,
    dictionaryArenaBytes: Buffer.from(image.stringBytes!, 'base64').byteLength,
    dictionaryEntries: image.stringEntries!.length,
  };
});
const result = {
  format: 'aether.packed-string-size-experiment/1' as const,
  sourceSha256: sha256(readFileSync(source)), runnerSha256: sha256(readFileSync(runner)),
  node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown',
  scenarios,
};
if (process.argv.length !== 3) throw new TypeError('usage: node --experimental-strip-types run.ts OUTPUT.json');
writeFileSync(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
