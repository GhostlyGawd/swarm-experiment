import * as b from '../../../../../src/tier1/build.ts';
import { GraphStore } from '../../../../../src/tier1/store.ts';
import { SymbolSpace } from '../../../../../src/tier1/symbols.ts';
import { typeName } from '../../../../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../../../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../../../../src/fabric/identity.ts';
import { ResumableRuntime } from '../../../../../src/tier3/resumable-runtime.ts';
import { packResumableCheckpoint, type PackedLayout } from '../../../../../src/tier3/packed-heap.ts';
import type { GuestOperation } from '../bridge.ts';

const name = typeName('type:test:packed_hvf_string_campaign');
const record = { t: 'Record' as const, name, fields: [['text', b.Str]] as const };
const layout: PackedLayout = { typeName: name, fields: [{ name: 'text', kind: 'string', maxUtf8Bytes: 32 }] };
const values = ['hello', 'é', '🧪', '', 'a\u0000b', 'same', 'longer ASCII value'];
export function stringCheckpointFixture() {
  const symbols = new SymbolSpace('packed-hvf-string-campaign'), entry = symbols.define('entry');
  const declaration = b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [declaration], symbolTable: symbols.table() });
  const store = new GraphStore();
  const digest = (value: string) => domainDigest('aether.packed-hvf-string-campaign/1', value);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module),
    specRoot: digest('spec'), dependencies: [], semanticsVersion: 'aether-reference/1',
    compilerDigest: digest('compiler'), target: { abiVersion: 'resumable/1',
      profileDigest: digest('target'), artifactDigest: digest('artifact') },
    capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence') };
  const runtime = new ResumableRuntime(module, { manifest, registry: new CapabilityRegistry(),
    executionId: 'packed-hvf-string-campaign', authorizeCorrection: () => true });
  const refs = Array.from({ length: 16 }, (_, index) => runtime.allocateRecord(record,
    { text: values[index % values.length] }));
  const packed = packResumableCheckpoint(runtime.snapshot(), runtime.program, [layout]);
  let seed = 0x93f813af;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const operations: GuestOperation[] = Array.from({ length: 128 }, () => {
    const left = refs[next() % refs.length];
    return next() & 1 ? { kind: 'readString', id: String(left.addr), field: 'text' }
      : { kind: 'equalsString', id: String(left.addr), field: 'text',
          otherId: String(refs[next() % refs.length].addr), otherField: 'text' };
  });
  return { runtime, packed, operations };
}
