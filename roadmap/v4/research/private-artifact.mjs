/** Reproduce with isolated pinned tools. No project dependencies or external proving service. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

const [toolRootArg, outputArg] = process.argv.slice(2);
if (!toolRootArg || !outputArg) throw new Error('usage: node private-artifact.mjs TOOL_ROOT OUTPUT_DIR');
const toolRoot = resolve(toolRootArg), output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(toolRoot, 'package.json'));
const snarkjs = await import(pathToFileURL(require.resolve('snarkjs')));
const circomlib = await import(pathToFileURL(require.resolve('circomlibjs')));
const cli = join(toolRoot, 'node_modules/snarkjs/cli.js');
const timings = [];
function command(label, executable, args) {
  const start = performance.now();
  const result = spawnSync(executable, args, { cwd: output, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  const milliseconds = performance.now() - start;
  writeFileSync(join(output, `${label}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error || result.status !== 0) throw new Error(`${label} failed: ${result.error?.message ?? result.stderr}; see ${output}/${label}.log`);
  timings.push({ operation: label, milliseconds });
}
function snark(label, ...args) { command(label, process.execPath, [cli, ...args]); }
const hash = value => createHash('sha256').update(value).digest('hex');
command('compile', join(toolRoot, 'circom/bin/circom'), [join(directory, 'private-artifact.circom'), '--r1cs', '--wasm', '--sym', '-l', join(toolRoot, 'node_modules'), '-o', output]);
// Local single-party setup is research-only. No production ceremony claim.
snark('tau-new', 'powersoftau', 'new', 'bn128', '12', 'initial.ptau');
snark('tau-contribution', 'powersoftau', 'contribute', 'initial.ptau', 'contributed.ptau', '--name=R03-local-research', `-e=${randomBytes(64).toString('hex')}`);
snark('tau-phase2', 'powersoftau', 'prepare', 'phase2', 'contributed.ptau', 'phase2.ptau');
snark('tau-verify', 'powersoftau', 'verify', 'phase2.ptau');
snark('circuit-setup', 'groth16', 'setup', 'private-artifact.r1cs', 'phase2.ptau', 'initial.zkey');
snark('circuit-contribution', 'zkey', 'contribute', 'initial.zkey', 'final.zkey', '--name=R03-local-research', `-e=${randomBytes(64).toString('hex')}`);
snark('circuit-verify', 'zkey', 'verify', 'private-artifact.r1cs', 'phase2.ptau', 'final.zkey');
snark('verification-key', 'zkey', 'export', 'verificationkey', 'final.zkey', 'verification_key.json');

const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const contextDescriptors = [
  { kind: 'specification', value: { format: 'aether.r03.spec/1', predicate: 'forall integer x in [0,15]: 0 <= slope*x+offset <=255', artifact: 'private-u8-slope-and-offset' } },
  { kind: 'target', value: { format: 'aether.r03.target/1', circuitSha256: hash(readFileSync(join(directory, 'private-artifact.circom'))), r1csSha256: hash(readFileSync(join(output, 'private-artifact.r1cs'))), abi: 'two-u8-coefficients/1' } },
  { kind: 'compiler', value: { format: 'aether.r03.compiler/1', circomTag: '2.2.3', compilerBinarySha256: hash(readFileSync(join(toolRoot, 'circom/bin/circom'))), poseidonCircuitSha256: hash(readFileSync(join(toolRoot, 'node_modules/circomlib/circuits/poseidon.circom'))), bitifyCircuitSha256: hash(readFileSync(join(toolRoot, 'node_modules/circomlib/circuits/bitify.circom'))), npmLockSha256: hash(readFileSync(join(toolRoot, 'package-lock.json'))) } },
  { kind: 'effect-policy', value: { format: 'aether.r03.effect-policy/1', grants: [], foreignCalls: false, mutableExternalState: false } },
  { kind: 'bounds', value: { format: 'aether.r03.bounds/1', inputMin: 0, inputMax: 15, outputMin: 0, outputMax: 255, coefficientBits: 8, field: String(field) } },
];
const contextLabels = contextDescriptors.map(descriptor => descriptor.kind);
const contextDigests = contextDescriptors.map(descriptor => hash(`aether.r03.context/1\0${JSON.stringify(descriptor)}`));
const context = contextDigests.flatMap(hex => [BigInt(`0x${hex.slice(0, 32)}`), BigInt(`0x${hex.slice(32)}`)]);
const poseidon = await circomlib.buildPoseidon();
const salt = BigInt(`0x${randomBytes(32).toString('hex')}`) % field;
const slope = 7n, offset = 9n;
const artifactCommitment = poseidon.F.toObject(poseidon([slope, offset, salt, ...context]));
const input = { slope: String(slope), offset: String(offset), salt: String(salt), context: context.map(String), artifactCommitment: String(artifactCommitment) };
const wasm = join(output, 'private-artifact_js/private-artifact.wasm');
const key = JSON.parse(readFileSync(join(output, 'verification_key.json'), 'utf8'));
const samples = [];
let retainedProof, retainedSignals;
for (let i = 0; i < 3; i++) {
  const started = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, join(output, 'final.zkey'));
  const generated = performance.now();
  if (!(await snarkjs.groth16.verify(key, publicSignals, proof))) throw new Error('valid private artifact proof was rejected');
  const checked = performance.now();
  samples.push({ generationMs: generated - started, checkingMs: checked - generated, proofBytes: Buffer.byteLength(JSON.stringify(proof)) });
  retainedProof = proof; retainedSignals = publicSignals;
}
const rejected = [];
// Every public signal is individually bound by the cryptographic verifier.
for (let i = 0; i < retainedSignals.length; i++) {
  const altered = [...retainedSignals]; altered[i] = String((BigInt(altered[i]) + 1n) % field);
  if (await snarkjs.groth16.verify(key, altered, retainedProof)) throw new Error(`altered public signal ${i} was accepted`);
  rejected.push(`public-signal-${i}`);
}
const badProof = structuredClone(retainedProof);
badProof.pi_a[0] = String((BigInt(badProof.pi_a[0]) + 1n) % field);
try {
  if (await snarkjs.groth16.verify(key, retainedSignals, badProof)) throw new Error('invalid proof accepted');
} catch (error) { if (error.message === 'invalid proof accepted') throw error; }
rejected.push('invalid-proof');
// Recompute a valid commitment for an unsafe artifact; rejection must come from
// quantified output-range constraints, rather than merely the commitment check.
const unsafeSlope = 20n;
const unsafe = { ...input, slope: String(unsafeSlope), artifactCommitment: String(poseidon.F.toObject(poseidon([unsafeSlope, offset, salt, ...context]))) };
let unsafeRejected = false;
try { await snarkjs.groth16.fullProve(unsafe, wasm, join(output, 'final.zkey')); }
catch { unsafeRejected = true; }
if (!unsafeRejected) throw new Error('unsafe private artifact produced a proof');
rejected.push('unsafe-artifact-with-valid-commitment');
// Also bypass honest witness generation: directly alter a valid witness and try proving.
writeFileSync(join(output, 'private-input.json'), JSON.stringify(input));
snark('witness', 'wtns', 'calculate', 'private-artifact_js/private-artifact.wasm', 'private-input.json', 'valid.wtns');
snark('witness-check', 'wtns', 'check', 'private-artifact.r1cs', 'valid.wtns');
const witness = Buffer.from(readFileSync(join(output, 'valid.wtns')));
// WTNS v2: find section 2 and corrupt its first field element (constant-one wire).
let cursor = 12;
while (cursor < witness.length) {
  const section = witness.readUInt32LE(cursor), size = Number(witness.readBigUInt64LE(cursor + 4));
  cursor += 12;
  if (section === 2) { witness[cursor] ^= 1; break; }
  cursor += size;
}
writeFileSync(join(output, 'invalid.wtns'), witness);
const invalid = spawnSync(process.execPath, [cli, 'wtns', 'check', 'private-artifact.r1cs', 'invalid.wtns'], { cwd: output, encoding: 'utf8', timeout: 30_000 });
writeFileSync(join(output, 'invalid-witness-check.log'), `${invalid.stdout}\n${invalid.stderr}`);
if (invalid.status === 0) throw new Error('tampered witness passed constraints');
rejected.push('tampered-witness-constraint-check');
const report = {
  format: 'aether.r03-private-prototype/1', generatedAt: new Date().toISOString(),
  status: 'research-proof-verified', productionSetup: false,
  statement: 'exists secret u8 slope,offset and salt: Poseidon(slope,offset,salt,context)=commitment AND for every integer x from 0 to 15, 0<=slope*x+offset<=255',
  scope: 'A fixed private affine artifact in a public arithmetic interpreter; not arbitrary AST, Wasm, native code, effects or full-module proof.',
  tools: { circom: '2.2.3 / ad44e915', snarkjs: '0.7.6', circomlib: '2.0.5', circomlibjs: '0.1.7', curve: 'BN254', scheme: 'Groth16', setup: 'local single-party research ceremony' },
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  sources: { circuitSha256: hash(readFileSync(join(directory, 'private-artifact.circom'))), runnerSha256: hash(readFileSync(fileURLToPath(import.meta.url))), r1csSha256: hash(readFileSync(join(output, 'private-artifact.r1cs'))), verificationKeySha256: hash(JSON.stringify(key)), toolsLockSha256: hash(readFileSync(join(toolRoot, 'package-lock.json'))) },
  contextLabels, contextDescriptors, contextDigests, setupTimings: timings, samples, rejected,
  verificationTarget: { boundMs: 5, allSamplesPass: samples.every(sample => sample.checkingMs <= 5), scope: 'research fixture only; cannot qualify full module attestation' },
  publicArtifact: { verificationKey: key, publicSignals: retainedSignals, proof: retainedProof },
};
writeFileSync(join(output, 'private-artifact-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, samples, rejected: rejected.length, output: join(output, 'private-artifact-results.json') }, null, 2));
// snarkjs may retain worker pools; all awaited work and results are complete.
process.exit(0);
