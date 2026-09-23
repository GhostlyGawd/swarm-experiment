import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as b from '../../../../src/tier1/build.ts';
import { type Term, type Ty } from '../../../../src/tier1/ast.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { typeName, type SymbolId } from '../../../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';
import { ResumableRuntime } from '../../../../src/tier3/resumable-runtime.ts';
import { buildGuest, encodeFrame, lowerAstToGuest, sha256, type LoweringInput, type LoweredGuest } from './compiler.ts';

const here = dirname(fileURLToPath(import.meta.url));
const recordTy: Extract<Ty, { t: 'Record' }> = { t: 'Record', name: typeName('type:research:ast_hvf_row'), fields: [['number', b.Int], ['delta', b.Int]] };
const layout = [{ name: 'number', min: -1000n, max: 1000n, bits: 11 }, { name: 'delta', min: -3n, max: 3n, bits: 3 }] as const;
type Arg = bigint | boolean | Readonly<Record<string, bigint>>;

function fixture(name: string, make: (s: SymbolSpace) => { entry: SymbolId; fn: Term; fields?: typeof layout }): LoweringInput {
  const syms = new SymbolSpace(`ast-hvf-${name}`), spec = make(syms);
  const module = b.module_({ symbol: syms.define('module'), members: [spec.fn], symbolTable: syms.table() });
  const manifest: ExecutionManifestV1 = {
    format: 'aether.execution/1', astRoot: new GraphStore().intern(module), specRoot: domainDigest('aether.ast-hvf-spec/1', name),
    dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: domainDigest('aether.ast-hvf-compiler/1', 'research'),
    target: { abiVersion: 'ast-hvf-research/1', profileDigest: domainDigest('aether.ast-hvf-profile/1', 'bounded i64 and one packed row'), artifactDigest: domainDigest('aether.ast-hvf-artifact/1', 'research build') },
    capabilityPolicyDigest: domainDigest('aether.ast-hvf-policy/1', 'no effects'), evidencePolicyDigest: domainDigest('aether.ast-hvf-evidence/1', 'local')
  };
  return { module, manifest, entry: spec.entry, fields: spec.fields };
}
function fixtures() {
  const arithmetic = fixture('arithmetic', syms => {
    const entry = syms.define('entry'), x = syms.define('x'), y = syms.define('y');
    return { entry, fn: b.fn({ symbol: entry, params: [b.param(x, b.Int), b.param(y, b.Int)], returns: b.Int,
      body: b.ret(b.cond(b.gt(b.v(x), b.v(y)), b.add(b.mul(b.v(x), b.int(3)), b.v(y)), b.sub(b.v(y), b.v(x)))) }) };
  });
  const packed = fixture('packed', syms => {
    const entry = syms.define('entry'), row = syms.define('row'), x = syms.define('x');
    return { entry, fields: layout, fn: b.fn({ symbol: entry, params: [b.param(row, recordTy), b.param(x, b.Int)], returns: b.Int,
      body: b.block(b.if_(b.gt(b.v(x), b.int(0)), b.ret(b.add(b.field(b.v(row), 'number'), b.mul(b.v(x), b.int(2)))),
        b.ret(b.sub(b.field(b.v(row), 'delta'), b.v(x))))) }) };
  });
  const division = fixture('division', syms => {
    const entry = syms.define('entry'), x = syms.define('x'), y = syms.define('y');
    return { entry, fn: b.fn({ symbol: entry, params: [b.param(x, b.Int), b.param(y, b.Int)], returns: b.Int,
      body: b.ret(b.div(b.v(x), b.v(y))) }) };
  });
  return { arithmetic, packed, division };
}

function guest(driver: string, image: string, frame: Buffer) {
  const process = spawnSync(driver, [image], { input: frame, timeout: 5000, maxBuffer: 1024 * 1024 });
  const diagnostic = process.stderr.toString().trim().split('\n').find(line => line.startsWith('{'));
  if (process.status !== 0) return { status: process.status, stderr: process.stderr.toString(), output: null, sample: null };
  const output = process.stdout;
  assert.equal(output.length, frame.length);
  assert.equal(output.readUInt32LE(40), 0x454e4f44);
  assert.equal(output.subarray(48, 80).toString('hex'), frame.subarray(48, 80).toString('hex'));
  return { status: 0, stderr: process.stderr.toString(), output, sample: JSON.parse(diagnostic!) as Record<string, number> };
}
function reference(input: LoweringInput, args: readonly Arg[]) {
  const runtime = new ResumableRuntime(input.module, { manifest: input.manifest, registry: new CapabilityRegistry(), executionId: 'ast-hvf-differential' });
  const converted = args.map((arg, index) => {
    if (index === 0 && typeof arg === 'object' && arg !== null) return runtime.allocateRecord(recordTy, arg);
    return arg as bigint | boolean;
  });
  runtime.start(input.entry, converted);
  const result = runtime.run();
  return { state: result.state, value: result.value?.tag === 'int' ? result.value.value : result.value, fault: result.fault?.kind ?? null };
}

function main() {
  const cases = fixtures(), temporary = mkdtempSync(join(tmpdir(), 'ast-hvf-lowering-'));
  const retain = process.argv.includes('--record');
  const resultDir = join(here, 'results/local-01');
  try {
    const built = Object.fromEntries(Object.entries(cases).map(([name, input]) => {
      const lowered = lowerAstToGuest(input), binary = buildGuest(lowered, join(temporary, name));
      return [name, { input, lowered, binary }];
    })) as Record<keyof typeof cases, { input: LoweringInput; lowered: LoweredGuest; binary: ReturnType<typeof buildGuest> }>;
    const results: unknown[] = [];
    let seed = 0x9a37ab21;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const vectors: { name: keyof typeof cases; args: Arg[] }[] = [
      { name: 'arithmetic', args: [0n, 0n] }, { name: 'arithmetic', args: [-1000n, 1000n] },
      { name: 'arithmetic', args: [1000n, -1000n] }, { name: 'arithmetic', args: [-(1n << 63n), -(1n << 63n)] },
      { name: 'packed', args: [{ number: -1000n, delta: -3n }, 1n] },
      { name: 'packed', args: [{ number: 1000n, delta: 3n }, 0n] },
      { name: 'packed', args: [{ number: 0n, delta: 0n }, -10n] },
      { name: 'division', args: [-(1n << 63n), 1n] }, { name: 'division', args: [7n, -3n] },
    ];
    for (let i = 0; i < 24; i++) {
      vectors.push({ name: 'arithmetic', args: [BigInt((next() % 2001) - 1000), BigInt((next() % 2001) - 1000)] });
      vectors.push({ name: 'packed', args: [{ number: BigInt((next() % 2001) - 1000), delta: BigInt((next() % 7) - 3) }, BigInt((next() % 201) - 100)] });
    }
    for (const { name, args } of vectors) {
      const item = built[name], frame = encodeFrame(item.lowered, args), native = guest(item.binary.driver, item.binary.image, frame), ref = reference(item.input, args);
      assert.equal(native.status, 0, native.stderr); assert.equal(ref.state, 'completed');
      assert.equal(native.output!.readUInt32LE(24), 0, `guest semantic status ${name}`);
      assert.equal(native.output!.readUInt32LE(28), 1);
      assert.equal(native.output!.readBigInt64LE(32), BigInt(ref.value as string), `differential mismatch ${name}`);
      results.push({ name, args: args.map(arg => typeof arg === 'bigint' ? String(arg) : typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, String(value)])) : arg),
        expected: ref.value, actual: String(native.output!.readBigInt64LE(32)), frameSha256: sha256(frame), sample: native.sample });
    }
    // Unsupported syntax and exact identity/schema failures must be rejected before compilation.
    const altered = structuredClone(cases.arithmetic) as LoweringInput;
    const body = (altered.module as Extract<Term, { kind: 'Module' }>).members[0] as Extract<Term, { kind: 'FunctionDecl' }>;
    const extra = { ...body, body: b.block(b.let_(body.params[0]!.symbol, b.Int, b.int(1)), body.body!) };
    const changed = { ...altered, module: { ...(altered.module as Extract<Term, { kind: 'Module' }>), members: [extra] } as Term };
    assert.throws(() => lowerAstToGuest(changed), /root|mismatch/);
    const changedRoot = { ...changed, manifest: { ...changed.manifest, astRoot: new GraphStore().intern(changed.module) } };
    assert.throws(() => lowerAstToGuest(changedRoot), /unsupported AST statement|typecheck/);
    // A real AST literal edit must change the compiled image and guest result.
    const editedModule = structuredClone(cases.arithmetic.module) as Extract<Term, { kind: 'Module' }>;
    const editedFn = editedModule.members[0] as Extract<Term, { kind: 'FunctionDecl' }>;
    const editedReturn = editedFn.body as Extract<Term, { kind: 'Return' }>;
    const editedCond = editedReturn.value as Extract<Term, { kind: 'Cond' }>;
    const editedAdd = editedCond.then as Extract<Term, { kind: 'Bin' }>;
    const editedMul = editedAdd.left as Extract<Term, { kind: 'Bin' }>;
    const editedLiteral = editedMul.right as Extract<Term, { kind: 'Lit' }>;
    const edited = { ...cases.arithmetic, module: { ...editedModule, members: [{ ...editedFn, body: { ...editedReturn,
      value: { ...editedCond, then: { ...editedAdd, left: { ...editedMul, right: { ...editedLiteral, value: 4n } } } } } }] } as Term };
    const editedInput = { ...edited, manifest: { ...edited.manifest, astRoot: new GraphStore().intern(edited.module) } };
    const editedLowered = lowerAstToGuest(editedInput), editedBinary = buildGuest(editedLowered, join(temporary, 'edited'));
    assert.notEqual(editedLowered.sourceSha256, built.arithmetic.lowered.sourceSha256);
    assert.notEqual(editedBinary.imageSha256, built.arithmetic.binary.imageSha256);
    const editedResult = guest(editedBinary.driver, editedBinary.image, encodeFrame(editedLowered, [7n, 1n]));
    assert.equal(editedResult.status, 0, editedResult.stderr);
    assert.equal(editedResult.output!.readBigInt64LE(32), 29n);
    assert.equal(reference(editedInput, [7n, 1n]).value, '29');
    assert.throws(() => lowerAstToGuest({ ...cases.packed, fields: [{ ...layout[0]!, bits: 10 }, layout[1]!] }), /layout/);
    assert.throws(() => encodeFrame(built.packed.lowered, [{ number: 1001n, delta: 0n }, 1n]), /bounds/);
    const normal = built.packed, valid = encodeFrame(normal.lowered, [{ number: 1n, delta: 2n }, 1n]);
    const wrongDigest = Buffer.from(valid); wrongDigest[48] ^= 1;
    const rejectedDigest = guest(normal.binary.driver, normal.binary.image, wrongDigest);
    assert.notEqual(rejectedDigest.status, 0); assert.match(rejectedDigest.stderr, /guest exit\/status/);
    const badField = Buffer.from(valid); badField[112] = 0xff; badField[113] |= 7; // 11-bit number code 2047 > 2000.
    const rejectedField = guest(normal.binary.driver, normal.binary.image, badField);
    assert.equal(rejectedField.status, 0, rejectedField.stderr); assert.equal(rejectedField.output!.readUInt32LE(24), 3);
    const overflow = built.arithmetic, overflowFrame = encodeFrame(overflow.lowered, [(1n << 63n) - 1n, 1n]);
    const overflowNative = guest(overflow.binary.driver, overflow.binary.image, overflowFrame);
    assert.equal(overflowNative.status, 0, overflowNative.stderr); assert.equal(overflowNative.output!.readUInt32LE(24), 1);
    const zero = built.division, zeroNative = guest(zero.binary.driver, zero.binary.image, encodeFrame(zero.lowered, [5n, 0n]));
    assert.equal(zeroNative.status, 0, zeroNative.stderr); assert.equal(zeroNative.output!.readUInt32LE(24), 2);
    const zeroReference = reference(zero.input, [5n, 0n]); assert.equal(zeroReference.state, 'faulted');
    const sourcePaths = ['compiler.ts', 'driver.c', 'start.S', 'kernel.ld', 'run.ts', 'verify.ts', '../native/hypervisor.entitlements',
      '../../../../src/tier1/ast.ts', '../../../../src/tier1/build.ts', '../../../../src/tier1/store.ts',
      '../../../../src/tier2/typecheck.ts', '../../../../src/tier3/resumable-program.ts', '../../../../src/tier3/resumable-runtime.ts',
      '../../../../src/fabric/identity.ts', '../../../../src/fabric/encoding.ts'];
    const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, sha256(readFileSync(join(here, path)))]));
    const report = { format: 'aether.ast-hvf-lowering-research/1', gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      platform: { arch: process.arch, platform: process.platform, release: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), hardware: execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim(), pageBytes: 16384 },
      toolchain: { clang: built.arithmetic.binary.compiler, linker: built.arithmetic.binary.linker }, sourceHashes,
      artifacts: Object.fromEntries(Object.entries(built).map(([name, item]) => [name, { root: item.lowered.root, manifestDigest: item.lowered.manifestDigest,
        generatedSourceSha256: item.lowered.sourceSha256, guestImageSha256: item.binary.imageSha256, guestImageBytes: readFileSync(item.binary.image).length,
        controllerSha256: item.binary.driverSha256 }])),
      comparisons: results, adversarial: { editedAstRoot: editedLowered.root, editedImageSha256: editedBinary.imageSha256,
        editedResult: String(editedResult.output!.readBigInt64LE(32)), wrongDigestExit: rejectedDigest.status, badFieldStatus: rejectedField.output!.readUInt32LE(24),
        overflowStatus: overflowNative.output!.readUInt32LE(24), divisionByZeroStatus: zeroNative.output!.readUInt32LE(24), divisionByZeroReference: zeroReference } };
    if (retain) {
      mkdirSync(resultDir, { recursive: true });
      for (const [name, item] of Object.entries(built)) {
        copyFileSync(item.binary.image, join(resultDir, `${name}.bin`));
        writeFileSync(join(resultDir, `${name}.c`), item.lowered.source);
      }
      copyFileSync(built.arithmetic.binary.driver, join(resultDir, 'driver'));
      copyFileSync(editedBinary.image, join(resultDir, 'edited.bin'));
      writeFileSync(join(resultDir, 'edited.c'), editedLowered.source);
      writeFileSync(join(resultDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    if (process.argv.includes('--verify')) {
      const saved = JSON.parse(readFileSync(join(resultDir, 'report.json'), 'utf8')) as typeof report;
      assert.deepEqual(report.sourceHashes, saved.sourceHashes, 'source bytes changed');
      assert.deepEqual(report.artifacts, saved.artifacts, 'recompiled artifacts changed');
      assert.deepEqual(report.adversarial, saved.adversarial, 'adversarial result changed');
      assert.deepEqual(results.map(row => { const { sample: _sample, ...stable } = row as Record<string, unknown>; return stable; }),
        saved.comparisons.map(row => { const { sample: _sample, ...stable } = row as Record<string, unknown>; return stable; }), 'differential cases changed');
      assert.equal(saved.comparisons.length, 57);
      for (const row of saved.comparisons) {
        const sample = (row as { sample: Record<string, number> }).sample;
        assert.equal(sample.kind as unknown, 'ast_hvf_guest_sample');
        assert.equal(sample.guestMappedBytes, 65536);
        assert.ok(sample.guestResidentObservedBytes > 0 && sample.guestResidentObservedBytes <= sample.guestMappedBytes);
        assert.ok(Math.abs((sample.validatedResponseTick - sample.guestStartTick) * sample.tickNs - sample.freshGuestToValidatedResponseNs) < 2);
        assert.ok(sample.mainStartTick <= sample.guestStartTick && sample.guestStartTick <= sample.runStartTick && sample.runStartTick <= sample.validatedResponseTick);
      }
      for (const [name, item] of Object.entries(saved.artifacts)) {
        const artifact = item as { generatedSourceSha256: string; guestImageSha256: string };
        assert.equal(sha256(readFileSync(join(resultDir, `${name}.c`))), artifact.generatedSourceSha256);
        assert.equal(sha256(readFileSync(join(resultDir, `${name}.bin`))), artifact.guestImageSha256);
      }
      assert.equal(sha256(readFileSync(join(resultDir, 'driver'))), (saved.artifacts.arithmetic as { controllerSha256: string }).controllerSha256);
      assert.equal(sha256(readFileSync(join(resultDir, 'edited.bin'))), saved.adversarial.editedImageSha256);
      console.log('retained evidence verified against rebuilt artifacts and 57 fresh guest comparisons');
    }
    console.log(JSON.stringify({ cases: results.length, adversarial: report.adversarial, artifacts: report.artifacts,
      maxFreshGuestNs: Math.max(...results.map(row => (row as { sample: { freshGuestToValidatedResponseNs: number } }).sample.freshGuestToValidatedResponseNs)) }));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
main();
