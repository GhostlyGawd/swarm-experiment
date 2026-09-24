import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { generateRecordFallbackCertificate } from '../../src/tier2/record-fallback-proof-producer.ts';
import { checkRecordFallbackCertificate } from '../../src/tier2/record-fallback-proof-checker.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { ProcessHost } from '../../src/tier4/process-host.ts';
import { ProcessFallbackSupervisor } from '../../src/tier4/process-fallback.ts';
import { assertProcessNativeFallbackBinding, createProcessNativeFallbackBinding }
  from '../../src/tier4/native-fallback-contract.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
import { fallbackFixture } from '../tier3/fallback-tree-fixture.ts';
import { buildProgram, executeBoundSnapshotFallback } from '../../roadmap/v4/research/native-fallback-ast/verify.ts';

type NativeResult = { tier: number; code: number; value: number; left: number; right: number;
  nextObjectId: number; records: Array<[number, number]> };
const fields = (records: Awaited<ReturnType<ProcessHost['snapshot']>>['records']): Array<[number, number]> =>
  records.map(row => {
    const value = row.fields.find(([name]) => name === 'value')?.[1];
    assert.equal(value?.tag, 'int');
    return [Number(row.objectId), Number(value.value)];
  });

test('exact native fallback consumes real ProcessHost state and matches durable tier decisions', async () => {
  for (const alias of [true, false]) {
    const directory = mkdtempSync(join(tmpdir(), 'aether-process-native-fallback-'));
    let host: ProcessHost | undefined;
    try {
      const source = fallbackFixture(join(directory, 'fixture'), 'fallback');
      const module = source.options.module, tier1 = source.options.tier1, tier2 = source.options.tier2;
      const registry = new CapabilityRegistry();
      const digest = (value: string) => domainDigest('aether.process-native-fallback-test/1', value);
      const manifest = createEvidenceManifest({ module, registry,
        specification: 'Exact native and process fallback state comparison.',
        semanticsVersion: 'reference/1', compilerDigest: digest('compiler'),
        capabilityPolicyDigest: digest('policy'),
        target: { abiVersion: 'process/1', profileDigest: digest('profile'),
          artifactDigest: digest('artifact') } });
      const plan: TopologyPlan = { shape: 'containers',
        units: [{ id: 'worker', members: [tier1, tier2], capabilities: [],
          placement: 'container', memoryMb: 16 }], crossEdges: [],
        transportLatencyMsPerSecond: 0, monthlyCost: 0,
        recombinations: [], blockedMerges: [] };
      host = await ProcessHost.open({ directory: join(directory, 'host'), module, manifest, plan,
        registry, sealer: new CapabilitySealer(new Uint8Array(32).fill(53), () => 100),
        authorizeRecovery: () => true });
      const left = await host.allocateRecord(source.record,
        { value: { tag: 'int', value: '10' } }, { operationId: 'left' });
      const right = alias ? left : await host.allocateRecord(source.record,
        { value: { tag: 'int', value: '110' } }, { operationId: 'right' });
      const before = await host.snapshot();
      const certificate = generateRecordFallbackCertificate({ module, manifest, tier2 });
      assert(certificate, 'actual ProcessHost manifest needs a checked native Tier 2 proof');
      const program = buildProgram(join(directory, 'native'), 'fallback',
        { module, manifest }, certificate);
      const checkedProof = checkRecordFallbackCertificate({ module, manifest, tier2 }, certificate);
      const journal = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
      const bindingInput = { operationId: 'native-host-comparison',
        configuration: host.fallbackIdentity().configuration,
        generation: host.generation, unit: 'worker',
        processHead: journal.heads.at(-1).digest as string,
        context: { module, manifest, tier2 }, tier1, checkedProof,
        snapshot: before, left, right, sourceSha256: program.lowered.sourceSha256,
        executableSha256: program.binarySha256 };
      const binding = createProcessNativeFallbackBinding(bindingInput);
      assertProcessNativeFallbackBinding(binding, bindingInput);
      assert('conservativeProofDigest' in program.lowered);
      assert.equal(binding.proofDigest, program.lowered.conservativeProofDigest);
      assert('compilerProfileDigest' in program.lowered);
      assert.equal(binding.compilerProfileDigest, program.lowered.compilerProfileDigest);
      assert.throws(() => createProcessNativeFallbackBinding({ ...bindingInput,
        checkedProof: { ...checkedProof } }), /untrusted checked proof/,
      'a JSON-shaped proof cannot enter the native host subject');
      assert.throws(() => assertProcessNativeFallbackBinding({ ...binding,
        executableSha256: '0'.repeat(64) }, bindingInput), /differs from exact retained subject/);
      assert.throws(() => executeBoundSnapshotFallback(binding, bindingInput,
        { ...program, binarySha256: '0'.repeat(64) }, true, false),
      /executable\/proof differs from host binding/);
      const native = executeBoundSnapshotFallback(binding, bindingInput,
        program, true, false) as NativeResult;
      const supervisor = new ProcessFallbackSupervisor({
        directory: join(directory, 'supervisor'), host, module, manifest,
        tier1, tier2, key: source.options.key,
        tokensFor: (_tier, symbol) => host!.issueTokens(symbol) });
      const result = await supervisor.call([
        { tag: 'ref', value: left }, { tag: 'ref', value: right },
      ], { operationId: 'native-host-comparison' });
      const after = await host.snapshot();
      assert.equal(native.tier, result.tier);
      assert.equal(native.code, result.state === 'completed' ? 0 : result.state === 'aborted' ? 1 : -1);
      if (result.state === 'completed') {
        assert.equal(result.value.tag, 'int');
        assert.equal(native.value, Number(result.value.value));
      }
      assert.equal(native.nextObjectId, Number(after.nextObjectId));
      assert.deepEqual(native.records, fields(after.records));
      if (alias) assert.throws(() => assertProcessNativeFallbackBinding(binding,
        { ...bindingInput, snapshot: after }), /differs from exact retained subject/,
      'a committed host snapshot cannot be relabeled as the native source');
      assert.equal(supervisor.pendingRepairs().length, result.state === 'completed' ? 1 : 2);
      assert.deepEqual(await supervisor.call([
        { tag: 'ref', value: left }, { tag: 'ref', value: right },
      ], { operationId: 'native-host-comparison' }), result);
    } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
