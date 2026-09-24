import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { domainDigest } from '../../src/fabric/identity.ts';
import { generateRecordFallbackCertificate } from '../../src/tier2/record-fallback-proof-producer.ts';
import { checkRecordFallbackCertificate } from '../../src/tier2/record-fallback-proof-checker.ts';
import { createProcessNativeFallbackBinding } from '../../src/tier4/native-fallback-contract.ts';
import { runProcessNativeFallback, validateProcessNativeFallbackOutcome,
  type ProcessNativeFallbackRunInput } from '../../src/tier4/native-fallback-runner.ts';
import { fallbackFixture } from '../tier3/fallback-tree-fixture.ts';
import { buildProgram } from '../../roadmap/v4/research/native-fallback-ast/verify.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function setup(directory: string, alias: boolean): ProcessNativeFallbackRunInput {
  const fixture = fallbackFixture(join(directory, 'fixture'), 'fallback');
  const context = { module: fixture.options.module, manifest: fixture.options.manifest,
    tier2: fixture.options.tier2 };
  const certificate = generateRecordFallbackCertificate(context);
  assert(certificate);
  const program = buildProgram(join(directory, 'native'), 'fallback',
    { module: context.module, manifest: context.manifest }, certificate);
  assert('conservativeProofDigest' in program.lowered);
  assert('compilerProfileDigest' in program.lowered);
  assert('proofProfileDigest' in program.lowered);
  assert('format' in program.lowered);
  const left = fixture.runtime.allocateRecord(fixture.record,
    { value: { tag: 'int', value: '10' } }, 'left');
  const right = alias ? left : fixture.runtime.allocateRecord(fixture.record,
    { value: { tag: 'int', value: '110' } }, 'right');
  const bindingInput = { operationId: alias ? 'alias' : 'distinct',
    configuration: domainDigest('aether.native-test-configuration/1', 'config'),
    generation: '0', unit: 'worker',
    processHead: domainDigest('aether.process-state-head/1', 'head'),
    context, tier1: fixture.options.tier1,
    checkedProof: checkRecordFallbackCertificate(context, certificate),
    snapshot: fixture.runtime.snapshot(), left, right,
    sourceSha256: program.lowered.sourceSha256,
    executableSha256: program.binarySha256 };
  return { binding: createProcessNativeFallbackBinding(bindingInput), bindingInput,
    executablePath: program.binary,
    lowered: program.lowered as ProcessNativeFallbackRunInput['lowered'], grant2: true };
}

test('native runner validates a complete Tier 2 frame against independent exact-source execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-runner-'));
  try {
    const input = setup(directory, true);
    const outcome = runProcessNativeFallback(input);
    assert.equal(outcome.tier, 2);
    assert.equal(outcome.state, 'completed');
    assert.deepEqual(outcome.value, { tag: 'int', value: '11' });
    assert.deepEqual(outcome.after.records.map(row => row.fields[0][1]),
      [{ tag: 'int', value: '11' }, { tag: 'int', value: '888' }]);
    assert.equal(outcome.after.ownership[0].epoch, input.bindingInput.snapshot.ownership[0].epoch);
    assert.deepEqual(outcome.after.ownership[1],
      { objectId: '2', unit: 'worker', epoch: '0' });
    validateProcessNativeFallbackOutcome(input.binding, input.bindingInput, outcome, input.lowered);
    assert.deepEqual(runProcessNativeFallback(input), outcome,
      'two private rebuilds must produce the same exact bound image and result');
    assert.throws(() => validateProcessNativeFallbackOutcome(input.binding,
      input.bindingInput, { ...outcome, value: { tag: 'int', value: '12' } }, input.lowered),
    /differs from exact-source execution/);
    assert.throws(() => validateProcessNativeFallbackOutcome(input.binding,
      input.bindingInput, { ...outcome, nativeOutputDigest: domainDigest('aether.wrong/1', 'x') }, input.lowered),
    /output digest mismatch/);
    assert.throws(() => validateProcessNativeFallbackOutcome(input.binding,
      input.bindingInput, { ...outcome, after: input.bindingInput.snapshot }, input.lowered),
    /differs from exact-source execution/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native runner requires exact Tier 3 rollback and rejects changed artifact and proof identities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-runner-abort-'));
  try {
    const input = setup(directory, false);
    const outcome = runProcessNativeFallback(input);
    assert.equal(outcome.tier, 3);
    assert.equal(outcome.state, 'aborted');
    assert.equal(outcome.code, 'fallback_exhausted');
    assert.deepEqual(outcome.after, input.bindingInput.snapshot);
    validateProcessNativeFallbackOutcome(input.binding, input.bindingInput, outcome, input.lowered);
    const denied = runProcessNativeFallback({ ...input, grant2: false });
    assert.equal(denied.tier, 3);
    assert.equal(denied.code, 'authority_denied');
    assert.deepEqual(denied.after, input.bindingInput.snapshot);
    assert.throws(() => validateProcessNativeFallbackOutcome(input.binding,
      input.bindingInput, denied, input.lowered), /differs from exact-source execution/,
    'a host that recorded grant2=true cannot relabel a denied result');
    validateProcessNativeFallbackOutcome(input.binding, input.bindingInput,
      denied, input.lowered, { grant2: false });
    assert.throws(() => runProcessNativeFallback({ ...input,
      lowered: { ...input.lowered, sourceSha256: '0'.repeat(64) } }),
    /compiler\/proof subject mismatch/);
    assert.throws(() => runProcessNativeFallback({ ...input,
      bindingInput: { ...input.bindingInput, checkedProof: { ...input.bindingInput.checkedProof } } }),
    /untrusted checked proof/);
    writeFileSync(input.executablePath, 'modified binary');
    assert.throws(() => runProcessNativeFallback(input), /executable digest mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native runner refuses symlinked and mismatched artifact bytes before launch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-runner-forged-'));
  try {
    const input = setup(directory, true);
    const linked = join(directory, 'link');
    symlinkSync(input.executablePath, linked);
    assert.throws(() => runProcessNativeFallback({ ...input,
      executablePath: linked }), /ELOOP|symbolic link/);
    const changed = Buffer.from(readFileSync(input.executablePath));
    changed[changed.length - 1] ^= 1;
    const alternate = join(directory, 'alternate-artifact');
    writeFileSync(alternate, changed, { mode: 0o700 });
    const mismatchedInput = { ...input.bindingInput,
      executableSha256: sha(readFileSync(alternate)) };
    const mismatched = createProcessNativeFallbackBinding(mismatchedInput);
    assert.throws(() => runProcessNativeFallback({ ...input,
      binding: mismatched, bindingInput: mismatchedInput, executablePath: alternate }),
    /rebuilt executable differs from binding/,
    'an otherwise valid identity for different bytes cannot enter this source profile');
    writeFileSync(input.executablePath, changed);
    assert.throws(() => runProcessNativeFallback({ ...input,
      executablePath: input.executablePath }), /executable digest mismatch/,
    'the selected artifact path must still match the trusted rebuild');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
