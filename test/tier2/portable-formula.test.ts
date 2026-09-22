import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as S from '../../src/tier2/smt.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { formulaCounterexampleCases, FORMULA_PROFILE } from '../../src/tier2/portable-formula.ts';
import { checkFormulaCertificate } from '../../src/tier2/portable-formula-checker.ts';
import { generateFormulaCertificate } from '../../src/tier2/portable-formula-producer.ts';

const manifest = domainDigest('aether.execution/1', 'portable-formula-test');
const x = S.intVar('x'), y = S.intVar('y'), p = S.boolVar('p'), q = S.boolVar('q');
const proof = (formula: S.SmtFormula) => { const result = generateFormulaCertificate(formula, manifest); assert.ok(result); checkFormulaCertificate(formula, result, manifest); return result; };

test('portable kernel derives complete integer and propositional counterexample coverage', () => {
  proof(S.implies(S.and(S.le(S.add(x, y), S.num(10)), S.ge(x, S.num(4)), S.ge(y, S.num(3))), S.le(x, S.num(7))));
  assert.equal(generateFormulaCertificate(S.implies(S.and(S.le(S.add(x, y), S.num(10)), S.ge(x, S.num(4)), S.ge(y, S.num(3))), S.le(x, S.num(6))), manifest), null);
  proof(S.implies(S.lt(x, S.num(1)), S.le(x, S.num(0))));
  proof(S.eq(S.sub(x, S.num(-3)), S.add(x, S.num(3))));
  proof(S.iff(S.eq(x, y), S.eq(y, x)));
  proof(S.iff(S.not(S.and(p, q)), S.or(S.not(p), S.not(q))));
  assert.equal(generateFormulaCertificate(S.implies(p, q), manifest), null);
  proof(S.T); assert.equal(generateFormulaCertificate(S.F, manifest), null);
});

test('portable kernel splits conditional arithmetic and uses exact large signed integers', () => {
  proof(S.ge(S.ite(S.ge(x, S.num(0)), x, S.neg(x)), S.num(0)));
  const huge = 10n ** 90n;
  proof(S.implies(S.le(x, S.num(huge)), S.le(S.add(x, S.num(-7)), S.num(huge - 7n))));
  proof(S.eq(S.mul(S.num(-3), S.sub(x, y)), S.add(S.mul(S.num(-3), x), S.mul(S.num(3), y))));
  assert.equal(generateFormulaCertificate(S.gt(S.ite(p, S.num(1), S.num(0)), S.num(0)), manifest), null);
});

test('portable kernel rejects altered subjects, missing cases, trust fields and false multipliers', () => {
  const formula = S.ge(S.ite(S.ge(x, S.num(0)), x, S.neg(x)), S.num(0));
  const valid = proof(formula); assert.ok(valid.cases.length >= 2);
  assert.throws(() => checkFormulaCertificate(formula, { ...valid, cases: valid.cases.slice(1) }, manifest), /coverage/);
  assert.throws(() => checkFormulaCertificate(formula, { ...valid, cases: [...valid.cases].reverse() }, manifest), /reordered/);
  assert.throws(() => checkFormulaCertificate(formula, { ...valid, trust: true }, manifest), /field|unknown/);
  assert.throws(() => checkFormulaCertificate(formula, valid, domainDigest('aether.execution/1', 'changed')), /stale/);
  assert.throws(() => checkFormulaCertificate(S.gt(x, S.num(0)), valid, manifest), /coverage/);
  const fake = structuredClone(valid) as unknown as { cases: { certificate: { multipliers: string[] } }[] };
  fake.cases[0].certificate.multipliers = fake.cases[0].certificate.multipliers.map(() => '0');
  assert.throws(() => checkFormulaCertificate(formula, fake, manifest), /contradiction/);
  fake.cases[0].certificate.multipliers[0] = '-1';
  assert.throws(() => checkFormulaCertificate(formula, fake, manifest), /integer/);
});

test('portable kernel keeps unsupported theories and resource exhaustion unproved', () => {
  assert.throws(() => generateFormulaCertificate(S.ge(S.mul(x, y), S.num(0)), manifest), /nonlinear/);
  assert.throws(() => generateFormulaCertificate(S.eq(S.app('arbitrary', x), x), manifest), /unsupported/);
  assert.throws(() => generateFormulaCertificate(S.eq(x, S.num(10n ** 300n)), manifest), /resource/);
  let deep = p; for (let i = 0; i < FORMULA_PROFILE.maxDepth + 2; i++) deep = { k: 'not', arg: deep };
  assert.throws(() => formulaCounterexampleCases(deep, manifest), /traversal/);
  const explosive: S.SmtFormula = { k: 'and', args: Array.from({ length: 10 }, (_, i) => S.or(S.boolVar(`a${i}`), S.boolVar(`b${i}`))) };
  assert.throws(() => formulaCounterexampleCases(S.not(explosive), manifest), /case limit/);
});

test('portable raw formula boundary rejects changing goals and malformed nodes without invoking getters or traps', () => {
  const certificate = proof(S.T);
  let reads = 0;
  const changing = Object.defineProperty({}, 'k', { enumerable: true, get: () => ++reads <= 7 ? 'true' : 'false' }) as S.SmtFormula;
  assert.throws(() => checkFormulaCertificate(changing, certificate, manifest), /accessor/); assert.equal(reads, 0);
  const proxy = new Proxy(S.T, { get: () => { reads++; throw new Error('trap'); }, ownKeys: () => { reads++; throw new Error('trap'); } });
  assert.throws(() => checkFormulaCertificate(proxy, certificate, manifest), /opaque/); assert.equal(reads, 0);
  assert.throws(() => checkFormulaCertificate({ ...S.T, trust: true } as unknown as S.SmtFormula, certificate, manifest), /field|unknown/);
  assert.throws(() => generateFormulaCertificate({ k: 'and', args: new Array(1) }, manifest), /array/);
});

test('portable certificates agree with concrete integer/Boolean evaluation on a varied formula corpus', () => {
  let accepted = 0, unknown = 0;
  for (let coefficient = -2; coefficient <= 2; coefficient++) for (let bound = -2; bound <= 2; bound++) {
    const lhs = S.add(S.mul(S.num(coefficient), x), S.num(bound));
    const formulas = [S.eq(lhs, S.sub(S.add(S.num(bound), S.mul(x, S.num(coefficient))), S.num(0))), S.implies(S.ge(x, S.num(bound)), S.ge(x, S.num(bound + 1))), S.or(p, S.not(p)), S.iff(p, q)];
    for (const formula of formulas) {
      const certificate = generateFormulaCertificate(formula, manifest);
      if (!certificate) { unknown++; continue; }
      accepted++; checkFormulaCertificate(formula, certificate, manifest);
      for (let value = -4n; value <= 4n; value++) for (const pv of [false, true]) for (const qv of [false, true]) assert.equal(S.evaluate(formula, { x: value, p: pv, q: qv }), true);
    }
  }
  assert.equal(accepted, 50); assert.equal(unknown, 50);
});

test('portable formula consumer runs in an isolated process with no producer or solver files', () => {
  const formula = S.implies(S.ge(x, S.num(3)), S.gt(S.add(x, S.num(1)), S.num(3))), certificate = proof(formula);
  const directory = mkdtempSync(join(tmpdir(), 'aether-proof-consumer-'));
  try {
    const files = ['tier2/portable-formula-checker.ts', 'tier2/portable-formula.ts', 'tier2/portable-linear-kernel.ts', 'fabric/encoding.ts', 'fabric/identity.ts', 'tier1/blake3.ts'];
    for (const file of files) { const path = join(directory, 'src', file); mkdirSync(dirname(path), { recursive: true }); copyFileSync(resolve('src', file), path); }
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(directory, 'input.json'), JSON.stringify({ formula, certificate, manifest }, (_, value) => typeof value === 'bigint' ? { bigint: String(value) } : value));
    const script = "import {readFileSync} from 'node:fs'; import {checkFormulaCertificate} from './src/tier2/portable-formula-checker.ts'; const {formula,certificate,manifest}=JSON.parse(readFileSync('input.json','utf8'),(_,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.bigint==='string'?BigInt(v.bigint):v); checkFormulaCertificate(formula,certificate,manifest); console.log('independent consumer accepted');";
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /consumer accepted/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
