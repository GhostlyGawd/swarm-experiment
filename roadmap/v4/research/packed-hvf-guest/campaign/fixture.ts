import * as b from '../../../../../src/tier1/build.ts';
import { GraphStore } from '../../../../../src/tier1/store.ts';
import { SymbolSpace } from '../../../../../src/tier1/symbols.ts';
import { typeName } from '../../../../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../../../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../../../../src/fabric/identity.ts';
import { ResumableRuntime } from '../../../../../src/tier3/resumable-runtime.ts';
import { packResumableCheckpoint, type PackedLayout } from '../../../../../src/tier3/packed-heap.ts';
import type { GuestOperation } from '../bridge.ts';

const nodeName = typeName('type:test:packed_hvf_hot_checkpoint');
const nodeType = { t: 'Record' as const, name: nodeName,
  fields: [['number', b.Int], ['alive', b.Bool], ['link', b.Unit]] as const };
const layout: PackedLayout = { typeName: nodeName, fields: [
  { name: 'number', kind: 'int', min: '0', max: '1000', overflow: 'trap' },
  { name: 'alive', kind: 'bool' },
  { name: 'link', kind: 'ref', maxRelative: 1 },
] };
export function checkpointFixture() {
  const symbols = new SymbolSpace('packed-hvf-hot-checkpoint'), entry = symbols.define('entry');
  const declaration = b.fn({ symbol: entry, returns: b.Int, body: b.ret(b.int(1)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [declaration], symbolTable: symbols.table() });
  const store = new GraphStore();
  const digest = (value: string) => domainDigest('aether.packed-hvf-hot-checkpoint/1', value);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module),
    specRoot: digest('spec'), dependencies: [], semanticsVersion: 'aether-reference/1',
    compilerDigest: digest('compiler'), target: { abiVersion: 'resumable/1',
      profileDigest: digest('target'), artifactDigest: digest('artifact') },
    capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence') };
  const runtime = new ResumableRuntime(module, { manifest, registry: new CapabilityRegistry(),
    executionId: 'packed-hvf-hot-checkpoint', authorizeCorrection: () => true });
  const refs = Array.from({ length: 16 }, (_, index) => runtime.allocateRecord(nodeType,
    { number: BigInt(index * 61), alive: !!(index & 1), link: null }));
  refs.forEach((ref, index) => runtime.correctRecord(ref, 'link', refs[Math.min(index + 1, refs.length - 1)]));
  const packed = packResumableCheckpoint(runtime.snapshot(), runtime.program, [layout]);
  const operations: GuestOperation[] = Array.from({ length: 128 }, (_, step) => {
    const id = String(refs[step % refs.length].addr);
    switch (step % 4) {
      case 0: return { kind: 'readInt', id, field: 'number' };
      case 1: return { kind: 'readBool', id, field: 'alive' };
      case 2: return { kind: 'readRef', id, field: 'link' };
      default: return { kind: 'addInt', id, field: 'number', increment: step % 8 === 3 ? '1000' : '-3' };
    }
  });
  return { runtime, packed, operations };
}
