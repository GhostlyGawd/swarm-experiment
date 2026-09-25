/** Untrusted certificate producer; acceptance always runs the independent kernel. */
import { validateClaim, constraints, bounded, linearClaimDigest, checkLinearCertificate, PROOF_LIMITS, type LinearClaim, type LinearCertificate } from './portable-linear-kernel.ts';
/** Fourier–Motzkin producer retains every linear-combination witness; checker does not rerun it. */
export function generateLinearCertificate(claim: LinearClaim): LinearCertificate | null {
  validateClaim(claim);
  const input = constraints(claim), dimension = input.length;
  let operations = 0;
  let rows = input.map((row, index) => ({ ...row, weights: Array.from({ length: dimension }, (_, k): bigint => index === k ? 1n : 0n) }));
  const finish = () => {
    const contradiction = rows.find(row => row.coefficients.every(value => value === 0n) && row.bound < 0n);
    if (!contradiction) return null;
    const certificate: LinearCertificate = { format: 'aether.linear-certificate/1', executionManifest: claim.executionManifest, claimDigest: linearClaimDigest(claim), multipliers: contradiction.weights.map(String) };
    checkLinearCertificate(claim, certificate, claim.executionManifest);
    return certificate;
  };
  for (let variable = 0; variable < claim.variables.length; variable++) {
    const early = finish(); if (early) return early;
    const positive = rows.filter(row => row.coefficients[variable] > 0n), negative = rows.filter(row => row.coefficients[variable] < 0n);
    const next = rows.filter(row => row.coefficients[variable] === 0n);
    if (next.length + positive.length * negative.length > PROOF_LIMITS.maxRows) throw new RangeError('proof generation row limit');
    for (const upper of positive) for (const lower of negative) {
      if (++operations > PROOF_LIMITS.maxOperations) throw new RangeError('proof generation operation limit');
      const a = -lower.coefficients[variable], b = upper.coefficients[variable];
      next.push({ coefficients: upper.coefficients.map((value, i) => bounded(a * value + b * lower.coefficients[i])),
        bound: bounded(a * upper.bound + b * lower.bound), weights: upper.weights.map((value, i) => bounded(a * value + b * lower.weights[i])) });
    }
    rows = next;
  }
  return finish(); // null means unknown/not established, never a proof of the negation
}

