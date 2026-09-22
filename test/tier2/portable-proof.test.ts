import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';
import { checkPortableCertificate, encodePortableCertificate, decodePortableCertificate, validateCheckedPortableCertificate, PORTABLE_CERTIFICATE_LIMITS } from '../../src/tier2/portable-proof-checker.ts';
import { generatePortableCertificate } from '../../src/tier2/portable-proof-producer.ts';

function fixture(external = false) {
  const symbols = new SymbolSpace('portable-bundle'), entry = symbols.define('entry'), helper = symbols.define('helper'), x = symbols.define('x');
  const contract = b.contract({ requires: [b.clause(b.ge(b.v(x), b.int(0)), 'nonnegative')], ensures: [b.clause(b.eq(b.result(), b.add(b.old(b.v(x)), b.int(1))), 'incremented')] });
  const target = b.fn({ symbol: helper, params: [b.param(x, b.Int)], returns: b.Int, contract, body: b.ret(b.add(b.v(x), b.int(1))) });
  const caller = b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, contract, body: b.ret(b.call(helper, b.v(x))) });
  const module = b.module_({ symbol: symbols.define('module'), members: external ? [caller] : [caller, target], symbolTable: symbols.table() });
  const specification = 'For nonnegative inputs, pure scalar calls return the input plus one.';
  const store = new GraphStore(), digest = (name: string) => domainDigest('aether.portable-test/1', name);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module), specRoot: domainDigest('aether.specification/1', specification), dependencies: [{ symbol: helper, declaration: store.intern(target) }],
    semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'), target: { abiVersion: 'scalar/1', profileDigest: digest('target'), artifactDigest: digest('artifact') }, capabilityPolicyDigest: digest('pure-policy'), evidencePolicyDigest: digest('portable-policy') };
  return { module, entry, helper, caller, target, specification, manifest, options: { manifest, expectedManifest: manifest, specification, dependencies: external ? [{ symbol: helper, declaration: target }] : [] } };
}

test('portable bundle round-trips and admits a closed compiled artifact with entry checks retained', () => {
  const f = fixture(), certificate = generatePortableCertificate(f.module, f.options); assert.ok(certificate);
  const decoded = decodePortableCertificate(encodePortableCertificate(certificate));
  const vetted = checkPortableCertificate(f.module, decoded, f.options);
  validateCheckedPortableCertificate(vetted, f.manifest);
  assert.ok(Object.isFrozen(vetted));
  const runtime = ProductionRuntime.compile(f.module, { registry: new CapabilityRegistry(), portableEvidence: { vetted, expectedManifest: f.manifest } });
  assert.deepEqual(runtime.call(f.entry, [4n]), { ok: true, value: 5n, steps: 0 });
  const negative = runtime.call(f.entry, [-1n]); assert.equal(negative.ok, false); if (!negative.ok) assert.equal(negative.fault.kind, 'precondition');
  for (const args of [[], [4n, 5n], ['4'], [true]]) {
    const invalid = runtime.call(f.entry, args); assert.equal(invalid.ok, false); if (!invalid.ok) assert.equal(invalid.fault.kind, 'type_error');
  }
  assert.throws(() => ProductionRuntime.compile(f.module, { registry: new CapabilityRegistry(), policy: 'elide', portableEvidence: { vetted, expectedManifest: f.manifest } }), /unconditional/);
  assert.throws(() => ProductionRuntime.compile(f.module, { registry: new CapabilityRegistry(), includeSymbols: [f.entry], portableEvidence: { vetted, expectedManifest: f.manifest } }), /loaded artifact/);
  assert.throws(() => validateCheckedPortableCertificate(JSON.parse(JSON.stringify(vetted)), f.manifest), /untrusted/);
});

test('portable bundle refuses stale execution dimensions, incomplete coverage and exchanged formula proofs', () => {
  const f = fixture(), certificate = generatePortableCertificate(f.module, f.options); assert.ok(certificate); assert.ok(certificate.certificates.length >= 3);
  for (const field of ['specRoot', 'compilerDigest', 'capabilityPolicyDigest', 'evidencePolicyDigest'] as const) {
    const expectedManifest = { ...f.manifest, [field]: domainDigest('aether.changed/1', field) };
    assert.throws(() => checkPortableCertificate(f.module, certificate, { ...f.options, expectedManifest }), /execution context/);
  }
  for (const target of [{ ...f.manifest.target, abiVersion: 'changed/1' }, { ...f.manifest.target, artifactDigest: domainDigest('aether.changed/1', 'artifact') }]) assert.throws(() => checkPortableCertificate(f.module, certificate, { ...f.options, expectedManifest: { ...f.manifest, target } }), /execution context/);
  assert.throws(() => checkPortableCertificate(f.module, certificate, { ...f.options, specification: 'Changed prose.' }), /specification/);
  assert.throws(() => checkPortableCertificate(f.module, { ...certificate, certificates: certificate.certificates.slice(1) }, f.options), /coverage/);
  const reversed = { ...certificate, certificates: [...certificate.certificates].reverse() };
  assert.throws(() => checkPortableCertificate(f.module, reversed, f.options), /reordered/);
  const exchanged = { ...certificate, certificates: certificate.certificates.map((item, i) => ({ ...item, proof: certificate.certificates[(i + 1) % certificate.certificates.length].proof })) };
  assert.throws(() => checkPortableCertificate(f.module, exchanged, f.options), /coverage|stale/);
  assert.throws(() => checkPortableCertificate(f.module, { ...certificate, trust: true }, f.options), /field|unknown/);
  assert.throws(() => checkPortableCertificate(f.module, { ...certificate, derivationProfileDigest: domainDigest('aether.changed/1', 'profile') }, f.options), /profile/);
  assert.throws(() => decodePortableCertificate(new Uint8Array(PORTABLE_CERTIFICATE_LIMITS.maxFrameBytes + 1)), /byte limit/);
});

test('portable proof consumer resolves actual dependency bodies and compilation rejects external replacement hooks', () => {
  const f = fixture(true), certificate = generatePortableCertificate(f.module, f.options); assert.ok(certificate);
  const vetted = checkPortableCertificate(f.module, certificate, f.options);
  assert.throws(() => checkPortableCertificate(f.module, certificate, { ...f.options, dependencies: [] }), /unresolved|missing|dependency/);
  const changed = f.target.kind === 'FunctionDecl' ? { ...f.target, body: b.ret(b.int(0)) } : f.target;
  assert.throws(() => checkPortableCertificate(f.module, certificate, { ...f.options, dependencies: [{ symbol: f.helper, declaration: changed }] }), /closure|dependency/);
  assert.throws(() => ProductionRuntime.compile(f.module, { registry: new CapabilityRegistry(), portableEvidence: { vetted, expectedManifest: f.manifest }, callHandler: () => ({ ok: true, value: 0n, steps: 0 }) }), /loaded artifact/);
});

test('portable certificates cannot be relabeled for a semantically false edited AST', () => {
  const f = fixture(), valid = generatePortableCertificate(f.module, f.options); assert.ok(valid); assert.equal(f.module.kind, 'Module');
  if (f.module.kind !== 'Module' || f.target.kind !== 'FunctionDecl') return;
  const brokenTarget = { ...f.target, body: b.ret(b.int(0)) };
  const module: Term = { ...f.module, members: [f.caller, brokenTarget] };
  const store = new GraphStore(), manifest = { ...f.manifest, astRoot: store.intern(module), dependencies: [{ symbol: f.helper, declaration: store.intern(brokenTarget) }] };
  const options = { ...f.options, manifest, expectedManifest: manifest };
  assert.equal(generatePortableCertificate(module, options), null);
  assert.throws(() => checkPortableCertificate(module, { ...valid, manifest }, options), /obligation|profile/);
  const vetted = checkPortableCertificate(f.module, valid, f.options);
  assert.throws(() => ProductionRuntime.compile(module, { registry: new CapabilityRegistry(), portableEvidence: { vetted, expectedManifest: f.manifest } }), /compiled module/);
});

test('independent AST certificate consumption works with original solver, verifier and producer absent', () => {
  const f = fixture(), certificate = generatePortableCertificate(f.module, f.options); assert.ok(certificate);
  const directory = mkdtempSync(join(tmpdir(), 'aether-ast-certificate-consumer-'));
  try {
    const files = ['tier2/portable-proof-checker.ts', 'tier2/portable-obligations.ts', 'tier2/portable-formula-checker.ts', 'tier2/portable-formula.ts', 'tier2/portable-linear-kernel.ts', 'tier2/smt.ts', 'fabric/encoding.ts', 'fabric/identity.ts', 'tier1/ast.ts', 'tier1/store.ts', 'tier1/canonical.ts', 'tier1/ids.ts', 'tier1/persistence.ts', 'tier1/blake3.ts'];
    for (const file of files) { const path = join(directory, 'src', file); mkdirSync(dirname(path), { recursive: true }); copyFileSync(resolve('src', file), path); }
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(directory, 'input.json'), JSON.stringify({ module: f.module, certificate, options: f.options }, (_, value) => typeof value === 'bigint' ? { bigint: String(value) } : value));
    const script = "import {readFileSync} from 'node:fs'; import {checkPortableCertificate} from './src/tier2/portable-proof-checker.ts'; const {module,certificate,options}=JSON.parse(readFileSync('input.json','utf8'),(_,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.bigint==='string'?BigInt(v.bigint):v); const accepted=checkPortableCertificate(module,certificate,options); if(accepted.astRoot!==options.expectedManifest.astRoot)throw Error('wrong AST'); console.log('independent AST consumer accepted');";
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /AST consumer accepted/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
