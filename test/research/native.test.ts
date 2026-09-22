import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeFixtures, lowerI64, I64 } from '../../roadmap/v4/research/native/lower.ts';
import { compileNative, conformance } from '../../roadmap/v4/research/native/harness.ts';
import * as b from '../../src/tier1/build.ts';

test('V4-R02 native lowering explicitly rejects unbounded arithmetic, contracts and effects', () => {
  const fixture = nativeFixtures();
  assert.equal(lowerI64(fixture.fee).abi, 'aether.native-i64/1');
  assert.match(lowerI64(fixture.fee).astRoot, /^ast:b3:[a-f0-9]{64}$/);
  const fee = fixture.fee;
  if (fee.kind !== 'FunctionDecl') throw new Error('fixture kind');
  assert.throws(() => lowerI64({ ...fee, returns: b.Int }), /unsupported/);
  assert.throws(() => lowerI64({ ...fee, contract: b.contract({}) }), /unsupported/);
  assert.throws(() => lowerI64({ ...fee, purity: 'effectful' }), /unsupported/);
  assert.throws(() => lowerI64({ ...fee, body: b.block(b.ret(b.add(b.int(1), b.int(2)))) }), /unsupported/);
  assert.throws(() => lowerI64({ ...fee, body: b.block(b.ret(b.typed(I64, 1n << 63n))) }), /outside/);
});

test('V4-R02 compiled native arithmetic agrees with TypeScript reference on signed limits, overflow and negative division', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-conformance-'));
  try {
    const built = compileNative(directory), result = conformance(built.driver);
    assert.equal(result.cases.length, 1345);
    assert.ok(result.cases.some(sample => sample.expectedStatus === 1));
    assert.ok(result.cases.some(sample => sample.expectedStatus === 2));
    assert.ok(result.cases.some(sample => sample.operation === 4 && sample.inputs[0] === '-9223372036854775808' && sample.inputs[1] === '-1' && sample.actualValue === '0' && sample.actualStatus === 0));
    assert.deepEqual(result.fallback, { threeTiers: true, rollbackPreserved: true, revocationTrap: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
