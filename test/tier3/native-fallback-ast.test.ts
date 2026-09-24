import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/tier1/store.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { fallbackFixture } from './fallback-tree-fixture.ts';
import { generateRecordFallbackCertificate } from '../../src/tier2/record-fallback-proof-producer.ts';
import { lowerFallbackAst, lowerProvedFallbackAst } from '../../roadmap/v4/research/native-fallback-ast/compiler.ts';
import { buildProgram, cases, differential, editedFallback, editWitness,
  snapshotCaseArgs, snapshotDifferential } from '../../roadmap/v4/research/native-fallback-ast/verify.ts';

test('actual fallback AST lowers to native bodies and matches state, aliases and tiers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-ast-'));
  try {
    const programs = new Map((['primary', 'fallback', 'abort'] as const).map(mode =>
      [mode, buildProgram(directory, mode)] as const));
    assert.equal(differential(programs).length, cases.length);
    assert.equal(snapshotDifferential(programs).length, cases.length,
      'native execution consumes the pre-call runtime snapshot, not a synthetic frame');
    const edit = editWitness(directory, programs.get('fallback')!);
    assert.notEqual(edit.originalRoot, edit.editedRoot);
    assert.notEqual(edit.originalBinarySha256, edit.editedBinarySha256);
    assert.deepEqual(edit.native, edit.reference);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native snapshot bridge rejects stale refs and malformed direct frames', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-snapshot-refuse-'));
  try {
    const program = buildProgram(directory, 'fallback');
    const f = fallbackFixture(join(directory, 'runtime'), 'fallback');
    const left = f.runtime.allocateRecord(f.record,
      { value: { tag: 'int', value: '7' } }, 'left');
    const before = f.runtime.snapshot();
    const valid = snapshotCaseArgs(before, program.lowered.manifestDigest, left, left, true, false);
    assert.equal(spawnSync(program.binary, valid).status, 0);
    assert.throws(() => snapshotCaseArgs(before,
      domainDigest('aether.execution/1', 'wrong-manifest'), left, left, true, false),
      /snapshot\/manifest mismatch/);
    assert.throws(() => snapshotCaseArgs(before, program.lowered.manifestDigest,
      { ...left, ownerEpoch: '999' }, left, true, false), /reference ownership mismatch/);
    f.runtime.allocateRecord(f.record, { value: { tag: 'int', value: '8' } }, 'second');
    f.runtime.allocateRecord(f.record, { value: { tag: 'int', value: '9' } }, 'third');
    assert.throws(() => snapshotCaseArgs(f.runtime.snapshot(), program.lowered.manifestDigest,
      left, left, true, false), /bounded frame/,
    'native entry refuses a base heap that leaves no slot for Tier 2 allocation');
    assert.equal(spawnSync(program.binary, ['--snapshot-case', '2', '1', '1', '1', '1', '0', '07']).status, 2,
      'native decoder refuses a noncanonical integer');
    assert.equal(spawnSync(program.binary, ['--snapshot-case', '4', '1', '1', '1', '1', '0', '7']).status, 2,
      'native decoder refuses a truncated frame');
    writeFileSync(program.binary, 'forged executable');
    assert.throws(() => snapshotDifferential(new Map([['fallback', program]]),
      [cases.find(value => value.mode === 'fallback')!]), /executable digest mismatch/,
    'a changed binary cannot execute after the approved digest is recorded');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('checked record proof changes exact native artifact identity and preserves snapshot outcomes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-proved-native-fallback-'));
  try {
    const f = fallbackFixture(join(directory, 'fixture'), 'fallback');
    const context = { module: f.options.module, manifest: f.options.manifest,
      tier2: f.options.tier2 };
    const certificate = generateRecordFallbackCertificate(context);
    assert(certificate);
    const ordinary = buildProgram(join(directory, 'ordinary'), 'fallback');
    const proved = buildProgram(join(directory, 'proved'), 'fallback', undefined, certificate);
    assert.notEqual(proved.lowered.sourceSha256, ordinary.lowered.sourceSha256);
    assert.notEqual(proved.binarySha256, ordinary.binarySha256,
      'portable proof subject must be retained in executable bytes');
    assert.equal(lowerProvedFallbackAst({ ...context, tier1: f.options.tier1,
      conservativeCertificate: certificate }).sourceSha256, proved.lowered.sourceSha256);
    assert.equal(snapshotDifferential(new Map([['fallback', proved]]),
      cases.filter(value => value.mode === 'fallback')).length,
    cases.filter(value => value.mode === 'fallback').length);
    assert.throws(() => lowerProvedFallbackAst({ ...context, tier1: f.options.tier1,
      conservativeCertificate: { ...certificate, certificates: [] } }),
    /incomplete or changed obligations/);
    assert.throws(() => buildProgram(join(directory, 'wrong'), 'primary', undefined, certificate),
      /stale certificate context|AST root or typecheck/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native lowering refuses stale manifests, unadmitted edits and unsupported effects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-refuse-'));
  try {
    const f = fallbackFixture(directory, 'fallback');
    const base = { module: f.options.module, manifest: f.options.manifest,
      tier1: f.options.tier1, tier2: f.options.tier2 };
    const edited = editedFallback(base.module);
    assert.throws(() => lowerFallbackAst({ ...base, module: edited }), /AST\/manifest mismatch/);
    const otherManifest = { ...base.manifest, astRoot: new GraphStore().intern(edited) };
    assert.notEqual(lowerFallbackAst({ ...base, module: edited, manifest: otherManifest }).sourceSha256,
      lowerFallbackAst(base).sourceSha256);
    if (base.module.kind !== 'Module') throw new Error('fixture module');
    const changed = { ...base.module, members: base.module.members.map((member, index) => index === 1 && member.kind === 'FunctionDecl'
      ? { ...member, purity: 'effectful' as const } : member) };
    assert.throws(() => lowerFallbackAst({ ...base, module: changed,
      manifest: { ...base.manifest, astRoot: new GraphStore().intern(changed) } }), /two pure tiers/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
