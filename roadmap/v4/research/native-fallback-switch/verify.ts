import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fallbackFixture } from '../../../../test/tier3/fallback-tree-fixture.ts';

interface Case { mode: 'primary' | 'fallback' | 'abort'; alias: boolean; initial: number; grant2: boolean; revokeAtFault: boolean }
export const cases: readonly Case[] = [
  { mode: 'primary', alias: true, initial: 10, grant2: true, revokeAtFault: false },
  { mode: 'fallback', alias: true, initial: 10, grant2: true, revokeAtFault: false },
  { mode: 'abort', alias: true, initial: 10, grant2: true, revokeAtFault: false },
  { mode: 'primary', alias: false, initial: 10, grant2: true, revokeAtFault: false },
  { mode: 'fallback', alias: false, initial: 10, grant2: true, revokeAtFault: false },
  { mode: 'abort', alias: false, initial: 10, grant2: true, revokeAtFault: false },
  { mode: 'fallback', alias: true, initial: -7, grant2: true, revokeAtFault: false },
  { mode: 'fallback', alias: true, initial: 99, grant2: true, revokeAtFault: false },
  { mode: 'primary', alias: true, initial: 0, grant2: false, revokeAtFault: false },
  { mode: 'fallback', alias: true, initial: 0, grant2: false, revokeAtFault: false },
  { mode: 'fallback', alias: true, initial: 0, grant2: true, revokeAtFault: true },
  { mode: 'abort', alias: true, initial: 0, grant2: true, revokeAtFault: true },
];

function normalizeReference(testCase: Case) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-switch-reference-'));
  try {
    let revoke = () => {};
    const f = fallbackFixture(directory, testCase.mode,
      phase => { if (phase === 'tier1-failed' && testCase.revokeAtFault) revoke(); });
    revoke = f.revoke;
    const left = f.runtime.allocateRecord(f.record,
      { value: { tag: 'int', value: String(testCase.initial) } }, 'left');
    const right = testCase.alias ? left : f.runtime.allocateRecord(f.record,
      { value: { tag: 'int', value: String(testCase.initial + 100) } }, 'right');
    const tokens = f.runtime.issueTokens();
    const result = f.runtime.call([
      { tag: 'ref', value: left }, { tag: 'ref', value: right },
    ], { operationId: 'invoke', tokens: testCase.grant2 ? tokens : [tokens[0]] });
    const snapshot = f.runtime.snapshot();
    const recordValue = (row: typeof snapshot.records[number]): number => {
      const value = row.fields.find(([name]) => name === 'value')?.[1];
      assert.equal(value?.tag, 'int');
      return Number(value.value);
    };
    return {
      tier: result.tier,
      code: result.state === 'completed' ? 0 : result.code === 'authority_denied' ? 2 : 1,
      value: result.state === 'completed' ? Number(result.value.tag === 'int' ? result.value.value : NaN) : 0,
      left: Number(left.objectId), right: Number(right.objectId),
      nextObjectId: Number(snapshot.nextObjectId),
      records: snapshot.records.map(row => [Number(row.objectId), recordValue(row)]),
    };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function differential(binary: string) {
  const rows = [];
  for (const [index, testCase] of cases.entries()) {
    const mode = { primary: 0, fallback: 1, abort: 2 }[testCase.mode];
    const child = spawnSync(binary, ['--case', String(mode), String(Number(testCase.alias)),
      String(testCase.initial), '1', String(Number(testCase.grant2)),
      String(Number(testCase.revokeAtFault))], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const native = JSON.parse(child.stdout);
    const reference = normalizeReference(testCase);
    assert.deepEqual(native, reference, `case ${index}: ${JSON.stringify(testCase)}`);
    rows.push({ index, input: testCase, native, reference });
  }
  return rows;
}

if (process.argv[1]?.endsWith('/verify.ts')) {
  const binary = process.argv[2];
  if (!binary) throw new Error('usage: verify.ts <native executable>');
  process.stdout.write(`${JSON.stringify({ cases: differential(binary) }, null, 2)}\n`);
}
