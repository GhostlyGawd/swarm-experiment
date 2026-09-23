import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typeName } from '../../../../src/tier1/ids.ts';
import { PackedHeap, type PackedLayout } from '../../../../src/tier3/packed-heap.ts';
import type { MachineRecord } from '../../../../src/tier3/resumable-state.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const abi = join(directory, 'abi.c'), header = join(directory, 'abi.h');
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const name = typeName('type:test:native_packed');
const ty = { t: 'Record' as const, name, fields: [['number', { t: 'Int' as const }], ['alive', { t: 'Bool' as const }], ['link', { t: 'Unit' as const }]] as const };
const layout: PackedLayout = { typeName: name, fields: [
  { name: 'number', kind: 'int', min: '0', max: '1000', overflow: 'trap' },
  { name: 'alive', kind: 'bool' },
  { name: 'link', kind: 'ref', maxRelative: 2 },
] };
const records: MachineRecord[] = [1000, 0, 512].map((number, index) => ({
  id: String(index + 1), epoch: String(index + 1), version: '0', ty,
  fields: [['number', { tag: 'int', value: String(number) }], ['alive', { tag: 'bool', value: index !== 1 }],
    ['link', { tag: 'ref', value: { heapId: 'heap:native', objectId: '3', ownerEpoch: '3' } }]],
}));
const heap = PackedHeap.pack(records, 'heap:native', [layout]);
const original = Buffer.from(heap.image().bytes, 'base64');
heap.set('1', 'number', { tag: 'int', value: '999' });
const mutated = Buffer.from(heap.image().bytes, 'base64');
const initial = [...original].join(','), changed = [...mutated].join(',');
const source = `#include "abi.h"
#include <stdio.h>
#include <string.h>
int main(void) {
  uint8_t data[] = {${initial}};
  const uint8_t expected[] = {${changed}};
  uint64_t out = 0; size_t target = 99; int is_null = -1; int64_t number = -1;
  int checks = 0;
  #define CHECK(x) do { checks++; if (!(x)) { fprintf(stderr, "native packed check %d failed\\n", checks); return 1; } } while(0)
  CHECK(ae_packed_read_u64(data,sizeof data,42,0,10,&out)==AE_PACKED_OK && out==1000);
  CHECK(ae_packed_read_u64(data,sizeof data,42,10,1,&out)==AE_PACKED_OK && out==1);
  CHECK(ae_packed_read_u64(data,sizeof data,42,11,3,&out)==AE_PACKED_OK && out==5);
  CHECK(ae_packed_ref_target(out,0,3,2,&target,&is_null)==AE_PACKED_OK && target==2 && is_null==0);
  CHECK(ae_packed_read_u64(data,sizeof data,42,14,10,&out)==AE_PACKED_OK && out==0);
  CHECK(ae_packed_read_u64(data,sizeof data,42,25,3,&out)==AE_PACKED_OK && out==3);
  CHECK(ae_packed_ref_target(out,1,3,2,&target,&is_null)==AE_PACKED_OK && target==2);
  CHECK(ae_packed_read_u64(data,sizeof data,42,28,10,&out)==AE_PACKED_OK && out==512);
  CHECK(ae_packed_read_u64(data,sizeof data,42,39,3,&out)==AE_PACKED_OK && out==1);
  CHECK(ae_packed_ref_target(out,2,3,2,&target,&is_null)==AE_PACKED_OK && target==2);
  CHECK(ae_packed_write_u64(data,sizeof data,42,0,10,999)==AE_PACKED_OK && memcmp(data,expected,sizeof data)==0);
  CHECK(ae_packed_read_u64(data,sizeof data,42,0,10,&out)==AE_PACKED_OK && out==999);
  CHECK(ae_packed_read_u64(data,sizeof data,42,42,1,&out)==AE_PACKED_BOUNDS);
  CHECK(ae_packed_read_u64(data,sizeof data,42,0,65,&out)==AE_PACKED_WIDTH);
  CHECK(ae_packed_write_u64(data,sizeof data,42,0,10,1024)==AE_PACKED_WIDTH);
  CHECK(ae_packed_ref_target(5,1,3,2,&target,&is_null)==AE_PACKED_REFERENCE);
  CHECK(ae_packed_ref_target(2,0,3,2,&target,&is_null)==AE_PACKED_REFERENCE);
  CHECK(ae_packed_ref_target(0,0,3,2,&target,&is_null)==AE_PACKED_OK && is_null==1);
  CHECK(ae_packed_add_i64(1000,1,0,1000,AE_PACKED_TRAP,&number)==AE_PACKED_OVERFLOW && number==-1);
  CHECK(ae_packed_add_i64(1000,1,0,1000,AE_PACKED_WRAP,&number)==AE_PACKED_OK && number==0);
  CHECK(ae_packed_add_i64(1000,1,0,1000,AE_PACKED_SATURATE,&number)==AE_PACKED_OK && number==1000);
  CHECK(ae_packed_add_i64(0,-1,0,1000,AE_PACKED_WRAP,&number)==AE_PACKED_OK && number==1000);
  CHECK(ae_packed_add_i64(INT64_MAX,INT64_MAX,INT64_MIN,INT64_MAX,AE_PACKED_WRAP,&number)==AE_PACKED_OK && number==-2);
  CHECK(ae_packed_add_i64(INT64_MIN,-1,INT64_MIN,INT64_MAX,AE_PACKED_SATURATE,&number)==AE_PACKED_OK && number==INT64_MIN);
  CHECK(ae_packed_add_i64(0,1,10,20,AE_PACKED_WRAP,&number)==AE_PACKED_BOUNDS);
  CHECK(ae_packed_add_i64(0,1,0,20,(ae_packed_overflow)-1,&number)==AE_PACKED_BOUNDS);
  printf("%d\\n",checks); return 0;
}
`;
const temporary = mkdtempSync(join(tmpdir(), 'aether-packed-c-'));
try {
  const driver = join(temporary, 'driver.c'), executable = join(temporary, 'packed-check');
  writeFileSync(driver, source);
  const compile = spawnSync('clang', ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', directory, abi, driver, '-o', executable], { encoding: 'utf8' });
  if (compile.status !== 0) throw new Error(`native ABI compile failed: ${compile.stderr}`);
  const run = spawnSync(executable, [], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`native ABI check failed: ${run.stderr}`);
  const result = { format: 'aether.packed-heap-native-check/1', checks: Number(run.stdout.trim()), status: 'pass',
    host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', node: process.version, compiler: execFileSync('clang', ['--version'], { encoding: 'utf8' }).split('\n')[0] },
    sourceSha256: { abi: hash(abi), header: hash(header), packedHeap: hash(join(directory, '../../../../src/tier3/packed-heap.ts')), verifier: hash(fileURLToPath(import.meta.url)) },
    fixture: { records: records.length, initialPayloadHex: original.toString('hex'), mutatedPayloadHex: mutated.toString('hex') } };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
