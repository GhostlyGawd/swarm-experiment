import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/tier1/store.ts';
import { fallbackFixture } from './fallback-tree-fixture.ts';
import { lowerFallbackAst } from '../../roadmap/v4/research/native-fallback-ast/compiler.ts';
import { buildProgram, cases, differential, editedFallback, editWitness } from '../../roadmap/v4/research/native-fallback-ast/verify.ts';

test('actual fallback AST lowers to native bodies and matches state, aliases and tiers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-ast-'));
  try {
    const programs = new Map((['primary', 'fallback', 'abort'] as const).map(mode =>
      [mode, buildProgram(directory, mode)] as const));
    assert.equal(differential(programs).length, cases.length);
    const edit = editWitness(directory, programs.get('fallback')!);
    assert.notEqual(edit.originalRoot, edit.editedRoot);
    assert.notEqual(edit.originalBinarySha256, edit.editedBinarySha256);
    assert.deepEqual(edit.native, edit.reference);
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
