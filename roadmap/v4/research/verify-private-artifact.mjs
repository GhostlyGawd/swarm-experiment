/** Verify the recorded public artifact without witness, proving key, compiler or original prover. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [toolRoot, samplePath, expectedKeyHash, expectedContextHash] = process.argv.slice(2);
if (!expectedKeyHash || !expectedContextHash) throw new Error('usage: node verify-private-artifact.mjs TOOL_ROOT SAMPLE EXPECTED_KEY_SHA256 EXPECTED_CONTEXT_SHA256');
const hash = value => createHash('sha256').update(value).digest('hex');
const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
const { verificationKey, publicSignals, proof } = sample.publicArtifact;
if (hash(JSON.stringify(verificationKey)) !== expectedKeyHash) throw new Error('verification key is not the approved key');
if (hash(JSON.stringify(sample.contextDescriptors)) !== expectedContextHash) throw new Error('public context is not approved');
if (publicSignals.length !== 11 || sample.contextDescriptors.length !== 5) throw new Error('wrong public input count');
const expectedSignals = sample.contextDescriptors.flatMap(descriptor => {
  const digest = hash(`aether.r03.context/1\0${JSON.stringify(descriptor)}`);
  return [BigInt(`0x${digest.slice(0, 32)}`).toString(), BigInt(`0x${digest.slice(32)}`).toString()];
});
if (expectedSignals.some((value, index) => publicSignals[index] !== value)) throw new Error('context digest mismatch');
const require = createRequire(join(resolve(toolRoot), 'package.json'));
const snarkjs = await import(pathToFileURL(require.resolve('snarkjs')));
if (!(await snarkjs.groth16.verify(verificationKey, publicSignals, proof))) throw new Error('invalid cryptographic proof');
console.log('Verified recorded bounded private artifact proof against externally pinned key and context.');
process.exit(0);
