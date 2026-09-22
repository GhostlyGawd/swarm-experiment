import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { domainDigest } from '../../../src/fabric/identity.ts';
import { generateLinearCertificate, checkLinearCertificate, type LinearClaim } from './proof-model.ts';

const claim: LinearClaim = {
  format: 'aether.linear-claim/1', executionManifest: domainDigest('aether.execution/1', { fixture: 'bounded-linear-contract' }),
  variables: ['x', 'y'], assumptions: [{ coefficients: ['1', '1'], bound: '10' }, { coefficients: ['-1', '0'], bound: '-4' }, { coefficients: ['0', '-1'], bound: '-3' }],
  goal: { coefficients: ['1', '0'], bound: '7' },
};
const samples = [];
let certificate;
for (let i = 0; i < 50; i++) {
  const start = performance.now();
  certificate = generateLinearCertificate(claim);
  const generated = performance.now();
  checkLinearCertificate(claim, certificate, claim.executionManifest);
  samples.push({ generationMs: generated - start, checkingMs: performance.now() - generated });
}
const report = {
  format: 'aether.r03-certificate-prototype/1', generatedAt: new Date().toISOString(),
  sourceSha256: createHash('sha256').update(readFileSync(new URL('./proof-model.ts', import.meta.url))).digest('hex'),
  runnerSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  claim, certificate, certificateBytes: Buffer.byteLength(JSON.stringify(certificate)), samples,
};
writeFileSync(process.argv[2] ?? new URL('./proof-model-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ samples: samples.length, certificateBytes: report.certificateBytes }));
