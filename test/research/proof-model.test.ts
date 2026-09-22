import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainDigest } from '../../src/fabric/identity.ts';
import { checkLinearCertificate, generateLinearCertificate, linearClaimDigest, type LinearClaim } from '../../roadmap/v4/research/proof-model.ts';

const subject = domainDigest('aether.execution/1', { fixture: 'bounded-linear-contract' });
const claim: LinearClaim = {
  format: 'aether.linear-claim/1', executionManifest: subject, variables: ['x', 'y'],
  assumptions: [
    { coefficients: ['1', '1'], bound: '10' }, // x+y <= 10
    { coefficients: ['-1', '0'], bound: '-4' }, // x >= 4
    { coefficients: ['0', '-1'], bound: '-3' }, // y >= 3
  ],
  goal: { coefficients: ['1', '0'], bound: '7' }, // x <= 7
};
test('R03: independent exact-arithmetic checker accepts an extracted nontrivial certificate', () => {
  const certificate = generateLinearCertificate(claim);
  assert.ok(certificate);
  assert.ok(certificate.multipliers.filter(value => value !== '0').length >= 3);
  checkLinearCertificate(claim, JSON.parse(JSON.stringify(certificate)), subject);
});
test('R03: false, stale, malformed and oversized certificates fail without a solver', () => {
  const certificate = generateLinearCertificate(claim)!;
  assert.throws(() => checkLinearCertificate(claim, { ...certificate, multipliers: ['0', '0', '0', '0'] }, subject));
  assert.throws(() => checkLinearCertificate(claim, { ...certificate, multipliers: ['-1', '0', '1', '1'] }, subject));
  assert.throws(() => checkLinearCertificate(claim, { ...certificate, trust: true }, subject));
  assert.throws(() => checkLinearCertificate(claim, { ...certificate, multipliers: ['1'.repeat(300), '0', '1', '1'] }, subject));
  assert.throws(() => checkLinearCertificate(claim, certificate, domainDigest('aether.execution/1', 'other target')));
  const falseClaim: LinearClaim = { ...claim, goal: { coefficients: ['1', '0'], bound: '6' } };
  assert.equal(generateLinearCertificate(falseClaim), null);
  assert.throws(() => checkLinearCertificate(falseClaim, { ...certificate, claimDigest: linearClaimDigest(falseClaim) }, subject));
});
test('R03: integer-bound transformation and large exact values do not use floating point', () => {
  const huge = 10n ** 90n;
  const integerClaim: LinearClaim = { ...claim, variables: ['x'], assumptions: [{ coefficients: ['2'], bound: (2n * huge).toString() }], goal: { coefficients: ['1'], bound: huge.toString() } };
  checkLinearCertificate(integerClaim, generateLinearCertificate(integerClaim), subject);
});
