import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/tier1/store.ts';
import { fallbackFixture } from '../tier3/fallback-tree-fixture.ts';
import { deriveRecordFallbackObligations, checkRecordFallbackCertificate,
  validateCheckedRecordFallbackProof } from '../../src/tier2/record-fallback-proof-checker.ts';
import { generateRecordFallbackCertificate } from '../../src/tier2/record-fallback-proof-producer.ts';
import { buildProgram, snapshotCaseArgs } from '../../roadmap/v4/research/native-fallback-ast/verify.ts';

function fixture<T>(run: (value: ReturnType<typeof fallbackFixture>) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'aether-record-fallback-proof-'));
  try { return run(fallbackFixture(directory, 'fallback')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('portable certificate proves bounded alias success and exact distinct-reference classification', () => fixture(f => {
  const context = { module: f.options.module, manifest: f.options.manifest, tier2: f.options.tier2 };
  const derivation = deriveRecordFallbackObligations(context);
  assert(derivation.obligations.some(item => item.kind === 'alias.postcondition'));
  assert(derivation.obligations.some(item => item.kind === 'distinct.postcondition'));
  assert(derivation.obligations.some(item => item.kind === 'alias.frame'));
  assert(derivation.obligations.some(item => item.kind === 'distinct.frame'));
  assert(derivation.obligations.some(item => item.kind.startsWith('distinct.i64.')));
  const certificate = generateRecordFallbackCertificate(context);
  assert(certificate, 'all universal obligations must have portable Farkas certificates');
  const checked = checkRecordFallbackCertificate(context, certificate);
  assert.equal(checked.astRoot, context.manifest.astRoot);
  assert.equal(checked.tier2, context.tier2);
  validateCheckedRecordFallbackProof(checked, context);
  assert.throws(() => validateCheckedRecordFallbackProof({ ...checked }, context), /untrusted checked proof/);
  assert.throws(() => checkRecordFallbackCertificate(context, { ...certificate, certificates: certificate.certificates.slice(1) }), /incomplete or changed/);
  assert.throws(() => checkRecordFallbackCertificate(context, { ...certificate, declarationRoot: context.manifest.astRoot }), /incomplete or changed/);
  const forgedRows = [...certificate.certificates];
  forgedRows[0] = { ...forgedRows[0], proof: { ...forgedRows[0].proof, caseSetDigest: context.manifest.astRoot } };
  assert.throws(() => checkRecordFallbackCertificate(context, { ...certificate, certificates: forgedRows }), /incomplete or changed formula case coverage/);
}));

test('proof cannot authorize a changed selected declaration or a false alias contract', () => fixture(f => {
  const base = { module: f.options.module, manifest: f.options.manifest, tier2: f.options.tier2 };
  const certificate = generateRecordFallbackCertificate(base);
  assert(certificate);
  if (base.module.kind !== 'Module') throw new Error('fixture shape');
  const changed = { ...base.module, members: base.module.members.map(member => {
    if (member.kind !== 'FunctionDecl' || member.symbol !== base.tier2 || member.body?.kind !== 'Block') return member;
    return { ...member, body: { ...member.body, stmts: member.body.stmts.map(stmt => stmt.kind === 'Return'
      ? { ...stmt, value: { kind: 'Lit' as const, ty: { t: 'Int' as const }, value: 0n } } : stmt) } };
  }) };
  assert.throws(() => checkRecordFallbackCertificate({ ...base, module: changed }, certificate), /AST root or typecheck/);
  const changedContext = { ...base, module: changed, manifest: { ...base.manifest, astRoot: new GraphStore().intern(changed) } };
  assert.equal(generateRecordFallbackCertificate(changedContext), null, 'edited return cannot prove alias postcondition');
}));

test('proof excludes arbitrary signed i64 and nonterminating or faulting syntax', () => fixture(f => {
  const base = { module: f.options.module, manifest: f.options.manifest, tier2: f.options.tier2 };
  if (base.module.kind !== 'Module') throw new Error('fixture shape');
  const changed = { ...base.module, members: base.module.members.map(member => {
    if (member.kind !== 'FunctionDecl' || member.symbol !== base.tier2 || member.body?.kind !== 'Block') return member;
    return { ...member, body: { ...member.body, stmts: [...member.body.stmts.slice(0, -1),
      { kind: 'Assert' as const, expr: { kind: 'Lit' as const, ty: { t: 'Bool' as const }, value: false }, label: 'fault' },
      member.body.stmts.at(-1)!] } };
  }) };
  const changedContext = { ...base, module: changed, manifest: { ...base.manifest, astRoot: new GraphStore().intern(changed) } };
  assert.throws(() => deriveRecordFallbackObligations(changedContext), /unsupported statement/);
}));

test('portable range goals refuse a source edit that can overflow signed i64', () => fixture(f => {
  const base = { module: f.options.module, manifest: f.options.manifest, tier2: f.options.tier2 };
  if (base.module.kind !== 'Module') throw new Error('fixture shape');
  const changed = { ...base.module, members: base.module.members.map(member => {
    if (member.kind !== 'FunctionDecl' || member.symbol !== base.tier2 || member.body?.kind !== 'Block') return member;
    return { ...member, body: { ...member.body, stmts: member.body.stmts.map(stmt => {
      if (stmt.kind !== 'Assign' || stmt.value.kind !== 'Bin') return stmt;
      return { ...stmt, value: { ...stmt.value, right: { kind: 'Lit' as const,
        ty: { t: 'Int' as const }, value: (1n << 63n) - 1n } } };
    }) } };
  }) };
  const changedContext = { ...base, module: changed, manifest: { ...base.manifest, astRoot: new GraphStore().intern(changed) } };
  assert.equal(generateRecordFallbackCertificate(changedContext), null,
    'a valid i64 literal does not make every intermediate signed-i64 result valid');
}));

test('distinct postcondition admits right = old left + 1 and aborts on right = old left + 100', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-record-fallback-distinct-'));
  try {
    const program = buildProgram(directory, 'fallback');
    for (const [rightValue, succeeds] of [[11, true], [110, false]] as const) {
      const f = fallbackFixture(join(directory, 'case-' + rightValue), 'fallback');
      const context = { module: f.options.module, manifest: f.options.manifest, tier2: f.options.tier2 };
      assert(generateRecordFallbackCertificate(context));
      const left = f.runtime.allocateRecord(f.record, { value: { tag: 'int', value: '10' } }, 'left');
      const right = f.runtime.allocateRecord(f.record, { value: { tag: 'int', value: String(rightValue) } }, 'right');
      const before = f.runtime.snapshot();
      const args = snapshotCaseArgs(before, program.lowered.manifestDigest, left, right, true, false);
      const nativeRun = spawnSync(program.binary, args, { encoding: 'utf8', timeout: 5000 });
      assert.equal(nativeRun.status, 0, nativeRun.stderr);
      const native = JSON.parse(nativeRun.stdout);
      const reference = f.runtime.call([{ tag: 'ref', value: left }, { tag: 'ref', value: right }],
        { operationId: 'invoke', tokens: f.runtime.issueTokens() });
      const after = f.runtime.snapshot();
      const values = after.records.map(row => {
        const field = row.fields[0][1];
        assert.equal(field.tag, 'int');
        return [Number(row.objectId), Number(field.value)];
      });
      assert.equal(reference.state === 'completed', succeeds);
      assert.deepEqual(native, { tier: succeeds ? 2 : 3, code: succeeds ? 0 : 1,
        value: succeeds ? rightValue : 0, left: Number(left.objectId), right: Number(right.objectId),
        nextObjectId: Number(after.nextObjectId), records: values });
      assert.deepEqual(values, succeeds ? [[1, 11], [2, 11], [3, 888]] : [[1, 10], [2, 110]]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
