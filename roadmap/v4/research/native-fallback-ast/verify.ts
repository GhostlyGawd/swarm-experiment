import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Term } from '../../../../src/tier1/ast.ts';
import type { LogicalRefV1 } from '../../../../src/fabric/encoding.ts';
import { runtimeSnapshotDigest, validateRuntimeSnapshot, type RuntimeSnapshotV1 } from '../../../../src/fabric/snapshot.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { FallbackTreeRuntime } from '../../../../src/tier3/fallback-tree.ts';
import { fallbackFixture } from '../../../../test/tier3/fallback-tree-fixture.ts';
import { lowerFallbackAst, type NativeFallbackOutput } from './compiler.ts';

const here = dirname(fileURLToPath(import.meta.url));
const driver = join(here, 'driver.c');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Mode = 'primary' | 'fallback' | 'abort';
export interface Case { readonly mode: Mode; readonly alias: boolean; readonly initial: number;
  readonly grant2: boolean; readonly revokeAtFault: boolean }
export const cases: readonly Case[] = [
  ...(['primary', 'fallback', 'abort'] as const).flatMap(mode => [true, false].map(alias =>
    ({ mode, alias, initial: 10, grant2: true, revokeAtFault: false }))),
  { mode: 'fallback', alias: true, initial: -7, grant2: true, revokeAtFault: false },
  { mode: 'fallback', alias: true, initial: 99, grant2: true, revokeAtFault: false },
  { mode: 'primary', alias: true, initial: 0, grant2: false, revokeAtFault: false },
  { mode: 'fallback', alias: true, initial: 0, grant2: false, revokeAtFault: false },
  { mode: 'fallback', alias: true, initial: 0, grant2: true, revokeAtFault: true },
  { mode: 'abort', alias: true, initial: 0, grant2: true, revokeAtFault: true },
  { mode: 'fallback', alias: false, initial: -101, grant2: true, revokeAtFault: false },
  { mode: 'primary', alias: false, initial: 1000000, grant2: true, revokeAtFault: false },
];
export interface BuiltProgram { readonly mode: Mode | 'edited'; readonly lowered: NativeFallbackOutput;
  readonly binary: string; readonly binarySha256: string; readonly assembly: string; readonly assemblySha256: string }
function run(program: string, args: readonly string[]): string {
  const child = spawnSync(program, [...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`${program} failed (${child.status}): ${child.stderr}`);
  return child.stdout.trim();
}
function runCheckedSnapshotProgram(program: BuiltProgram, args: readonly string[]): string {
  const bytes = readFileSync(program.binary);
  if (bytes.length < 1 || bytes.length > 16 * 1024 * 1024
    || sha(bytes) !== program.binarySha256)
    throw new TypeError('native fallback executable digest mismatch');
  const privateDirectory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-run-'));
  try {
    const executable = join(privateDirectory, 'exact-native');
    writeFileSync(executable, bytes, { flag: 'wx', mode: 0o700 });
    const child = spawnSync(executable, [...args],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
    if (child.status !== 0) throw new Error(`checked native fallback failed (${child.status}): ${child.stderr}`);
    return child.stdout.trim();
  } finally { rmSync(privateDirectory, { recursive: true, force: true }); }
}
function reference(testCase: Case, changed?: Readonly<{ module: Term; manifest: ReturnType<typeof fallbackFixture>['options']['manifest'] }>) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-reference-'));
  try {
    let revoke = () => {};
    const f = fallbackFixture(directory, testCase.mode,
      phase => { if (phase === 'tier1-failed' && testCase.revokeAtFault) revoke(); });
    revoke = f.revoke;
    const runtime = changed ? new FallbackTreeRuntime({ ...f.options, directory: join(directory, 'edited'),
      module: changed.module, manifest: changed.manifest }) : f.runtime;
    const left = runtime.allocateRecord(f.record, { value: { tag: 'int', value: String(testCase.initial) } }, 'left');
    const right = testCase.alias ? left : runtime.allocateRecord(f.record,
      { value: { tag: 'int', value: String(testCase.initial + 100) } }, 'right');
    const tokens = runtime.issueTokens();
    const result = runtime.call([{ tag: 'ref', value: left }, { tag: 'ref', value: right }],
      { operationId: 'invoke', tokens: testCase.grant2 ? tokens : [tokens[0]] });
    const snapshot = runtime.snapshot();
    const recordValue = (row: typeof snapshot.records[number]): number => {
      const value = row.fields.find(([name]) => name === 'value')?.[1];
      assert.equal(value?.tag, 'int'); return Number(value.value);
    };
    return { tier: result.tier, code: result.state === 'completed' ? 0 : result.code === 'authority_denied' ? 2 : 1,
      value: result.state === 'completed' ? Number(result.value.tag === 'int' ? result.value.value : NaN) : 0,
      left: Number(left.objectId), right: Number(right.objectId), nextObjectId: Number(snapshot.nextObjectId),
      records: snapshot.records.map(row => [Number(row.objectId), recordValue(row)]) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Exact projection of a real runtime snapshot into the bounded native frame.
 * The native program receives values and aliases only after the complete
 * manifest, object table and reference ownership have been checked here. */
export function snapshotCaseArgs(snapshot: RuntimeSnapshotV1, manifestDigest: string,
  left: LogicalRefV1, right: LogicalRefV1, grant2: boolean, revokeAtFault: boolean): string[] {
  validateRuntimeSnapshot(snapshot);
  if (snapshot.executionManifest !== manifestDigest) throw new TypeError('native fallback snapshot/manifest mismatch');
  const nextId = Number(snapshot.nextObjectId);
  // This exact compiler profile may allocate one new record after rollback.
  // Reserve that slot before entering native code; otherwise a valid Aether
  // invocation could succeed in the reference runtime but trap in Frame[4].
  if (!Number.isSafeInteger(nextId) || nextId < 2 || nextId > 3
    || snapshot.records.length !== nextId - 1 || snapshot.ownership.length !== nextId - 1)
    throw new RangeError('native fallback snapshot exceeds bounded frame');
  const ownership = new Map(snapshot.ownership.map(row => [row.objectId, row.epoch]));
  const checkedRef = (ref: LogicalRefV1): string => {
    if (ref.heapId !== snapshot.heapId || ownership.get(ref.objectId) !== ref.ownerEpoch
      || !snapshot.records.some(row => row.objectId === ref.objectId))
      throw new TypeError('native fallback reference ownership mismatch');
    return ref.objectId;
  };
  const values = snapshot.records.map((row, index) => {
    if (row.objectId !== String(index + 1) || row.fields.length !== 1
      || row.fields[0][0] !== 'value' || row.fields[0][1].tag !== 'int')
      throw new TypeError('native fallback requires contiguous one-field Int records');
    const value = BigInt(row.fields[0][1].value);
    if (value < -1_000_000n || value > 1_000_100n)
      throw new RangeError('native fallback snapshot integer outside qualified range');
    return String(value);
  });
  return ['--snapshot-case', String(nextId), checkedRef(left), checkedRef(right),
    '1', String(Number(grant2)), String(Number(revokeAtFault)), ...values];
}
export function snapshotDifferential(programs: ReadonlyMap<Mode, BuiltProgram>,
  testCases: readonly Case[] = cases) {
  return testCases.map((testCase, index) => {
    const program = programs.get(testCase.mode);
    if (!program) throw new Error('native fallback mode binary missing');
    const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-snapshot-'));
    try {
      const f = fallbackFixture(directory, testCase.mode);
      const left = f.runtime.allocateRecord(f.record,
        { value: { tag: 'int', value: String(testCase.initial) } }, 'left');
      const right = testCase.alias ? left : f.runtime.allocateRecord(f.record,
        { value: { tag: 'int', value: String(testCase.initial + 100) } }, 'right');
      const before = f.runtime.snapshot();
      const args = snapshotCaseArgs(before, program.lowered.manifestDigest,
        left, right, testCase.grant2, testCase.revokeAtFault);
      const native = JSON.parse(runCheckedSnapshotProgram(program, args));
      const expected = reference(testCase);
      assert.deepEqual(native, expected,
        `native snapshot case ${index}: ${JSON.stringify(testCase)}`);
      return { index, input: testCase, beforeSnapshot: runtimeSnapshotDigest(before),
        native, reference: expected };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
export function buildProgram(directory: string, mode: Mode | 'edited', changed?: Readonly<{
  module: Term; manifest: ReturnType<typeof fallbackFixture>['options']['manifest'] }>): BuiltProgram {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-build-'));
  try {
    const f = fallbackFixture(fixtureDirectory, mode === 'edited' ? 'fallback' : mode);
    const lowered = lowerFallbackAst({ module: changed?.module ?? f.options.module,
      manifest: changed?.manifest ?? f.options.manifest, tier1: f.options.tier1, tier2: f.options.tier2 });
    const output = join(directory, mode); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'generated.h'), lowered.source);
    const binary = join(output, 'native-fallback'), assembly = join(output, 'native-fallback.s');
    const flags = ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fno-lto', '-I', output];
    run('clang', [...flags, '-o', binary, driver]);
    run('clang', [...flags, '-S', '-o', assembly, driver]);
    return { mode, lowered, binary, binarySha256: sha(readFileSync(binary)),
      assembly, assemblySha256: sha(readFileSync(assembly)) };
  } finally { rmSync(fixtureDirectory, { recursive: true, force: true }); }
}
export function differential(programs: ReadonlyMap<Mode, BuiltProgram>, testCases: readonly Case[] = cases) {
  return testCases.map((testCase, index) => {
    const binary = programs.get(testCase.mode)?.binary;
    if (!binary) throw new Error('native fallback mode binary missing');
    const native = JSON.parse(run(binary, ['--case', String(Number(testCase.alias)), String(testCase.initial),
      '1', String(Number(testCase.grant2)), String(Number(testCase.revokeAtFault))]));
    const expected = reference(testCase);
    assert.deepEqual(native, expected, `AST native case ${index}: ${JSON.stringify(testCase)}`);
    return { index, input: testCase, native, reference: expected };
  });
}
/** Change the Tier 2 allocation literal, preserving all other AST nodes. */
export function editedFallback(module: Term): Term {
  if (module.kind !== 'Module') throw new TypeError('fallback edit requires a module');
  let changed = false;
  const members = module.members.map((member, index) => {
    if (index !== 1 || member.kind !== 'FunctionDecl' || member.body?.kind !== 'Block') return member;
    const stmts = member.body.stmts.map(stmt => {
      if (stmt.kind !== 'Let' || stmt.init.kind !== 'RecordLit') return stmt;
      const fields = stmt.init.fields.map(([name, value]) => {
        if (name !== 'value' || value.kind !== 'Lit' || value.ty.t !== 'Int' || value.value !== 888n) return [name, value] as const;
        changed = true; return [name, { ...value, value: 889n }] as const;
      });
      return { ...stmt, init: { ...stmt.init, fields } };
    });
    return { ...member, body: { ...member.body, stmts } };
  });
  if (!changed) throw new TypeError('expected Tier 2 allocation literal not found');
  return { ...module, members };
}
export function editWitness(directory: string, original: BuiltProgram) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-edit-'));
  try {
    const f = fallbackFixture(fixtureDirectory, 'fallback');
    const module = editedFallback(f.options.module), manifest = { ...f.options.manifest,
      astRoot: new GraphStore().intern(module) };
    const edited = buildProgram(directory, 'edited', { module, manifest });
    if (edited.lowered.root === original.lowered.root || edited.lowered.sourceSha256 === original.lowered.sourceSha256
      || edited.binarySha256 === original.binarySha256) throw new Error('AST edit did not change native artifact');
    const testCase: Case = { mode: 'fallback', alias: true, initial: 10, grant2: true, revokeAtFault: false };
    const native = JSON.parse(run(edited.binary, ['--case', '1', '10', '1', '1', '0']));
    const expected = reference(testCase, { module, manifest });
    assert.deepEqual(native, expected);
    assert.deepEqual(native.records, [[1, 11], [2, 889]]);
    return { originalRoot: original.lowered.root, editedRoot: edited.lowered.root,
      originalSourceSha256: original.lowered.sourceSha256, editedSourceSha256: edited.lowered.sourceSha256,
      originalBinarySha256: original.binarySha256, editedBinarySha256: edited.binarySha256,
      editedProgram: { root: edited.lowered.root, manifestDigest: edited.lowered.manifestDigest,
        sourceSha256: edited.lowered.sourceSha256, binarySha256: edited.binarySha256,
        assemblySha256: edited.assemblySha256 },
      native, reference: expected };
  } finally { rmSync(fixtureDirectory, { recursive: true, force: true }); }
}
