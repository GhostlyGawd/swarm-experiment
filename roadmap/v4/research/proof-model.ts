/** R03 arithmetic certificate prototype. Independent checker: no solver/runtime imports. */
import { encodeCanonical, exactObject, identifier } from '../../../src/fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../../../src/fabric/identity.ts';

export interface LinearBound {
  /** sum(coefficients[i] * integer variable[i]) <= bound */
  readonly coefficients: readonly string[];
  readonly bound: string;
}
export interface LinearClaim {
  readonly format: 'aether.linear-claim/1';
  readonly executionManifest: Digest;
  readonly variables: readonly string[];
  readonly assumptions: readonly LinearBound[];
  readonly goal: LinearBound;
}
export interface LinearCertificate {
  readonly format: 'aether.linear-certificate/1';
  readonly executionManifest: Digest;
  readonly claimDigest: Digest;
  /** Nonnegative integer multipliers for assumptions followed by integer negation of goal. */
  readonly multipliers: readonly string[];
}
export const PROOF_LIMITS = Object.freeze({ maxVariables: 16, maxAssumptions: 128, maxDigits: 256, maxRows: 4096, maxOperations: 50_000, maxBytes: 256 * 1024 });
const encoding = { maxFrameBytes: PROOF_LIMITS.maxBytes, maxDecompressedBytes: PROOF_LIMITS.maxBytes, maxObjects: 100_000, maxDepth: 12 };
function integer(value: unknown, positive = false): bigint {
  if (typeof value !== 'string' || value.length > PROOF_LIMITS.maxDigits || !(positive ? /^(0|[1-9][0-9]*)$/ : /^(0|-?[1-9][0-9]*)$/).test(value)) throw new TypeError('invalid bounded proof integer');
  return BigInt(value);
}
function bounded(value: bigint): bigint {
  if (value.toString().length > PROOF_LIMITS.maxDigits) throw new RangeError('proof arithmetic resource limit');
  return value;
}
function validateClaim(value: unknown): asserts value is LinearClaim {
  encodeCanonical(value, encoding);
  const claim = exactObject(value, ['format', 'executionManifest', 'variables', 'assumptions', 'goal']);
  if (claim.format !== 'aether.linear-claim/1') throw new TypeError('unsupported calculus');
  validateDigest(claim.executionManifest, 'aether.execution/1');
  if (!Array.isArray(claim.variables) || claim.variables.length > PROOF_LIMITS.maxVariables || new Set(claim.variables).size !== claim.variables.length) throw new TypeError('invalid proof variables');
  for (const variable of claim.variables) identifier(variable);
  if (!Array.isArray(claim.assumptions) || claim.assumptions.length > PROOF_LIMITS.maxAssumptions) throw new RangeError('proof assumption limit');
  for (const value of [...claim.assumptions, claim.goal]) {
    const row = exactObject(value, ['coefficients', 'bound']);
    if (!Array.isArray(row.coefficients) || row.coefficients.length !== claim.variables.length) throw new TypeError('invalid proof dimension');
    row.coefficients.forEach(value => integer(value)); integer(row.bound);
  }
}
export function linearClaimDigest(claim: LinearClaim): Digest {
  validateClaim(claim); return domainDigest('aether.linear-claim/1', claim, encoding);
}
function constraints(claim: LinearClaim): { coefficients: bigint[]; bound: bigint }[] {
  return [...claim.assumptions.map(row => ({ coefficients: row.coefficients.map(value => integer(value)), bound: integer(row.bound) })),
    { coefficients: claim.goal.coefficients.map(value => -integer(value)), bound: -integer(claim.goal.bound) - 1n }];
}
/** Checks a Farkas contradiction over assumptions and negated goal using exact integers. */
export function checkLinearCertificate(claim: LinearClaim, value: unknown, expectedManifest: Digest): void {
  validateClaim(claim); validateDigest(expectedManifest, 'aether.execution/1');
  encodeCanonical(value, encoding);
  const certificate = exactObject(value, ['format', 'executionManifest', 'claimDigest', 'multipliers']);
  if (certificate.format !== 'aether.linear-certificate/1' || certificate.executionManifest !== expectedManifest || claim.executionManifest !== expectedManifest || certificate.claimDigest !== linearClaimDigest(claim)) throw new TypeError('unsupported or stale proof subject');
  if (!Array.isArray(certificate.multipliers) || certificate.multipliers.length !== claim.assumptions.length + 1) throw new TypeError('missing proof multipliers');
  const rows = constraints(claim);
  const sum = claim.variables.map(() => 0n);
  let bound = 0n;
  for (let row = 0; row < rows.length; row++) {
    const multiplier = integer(certificate.multipliers[row], true);
    for (let index = 0; index < sum.length; index++) sum[index] = bounded(sum[index] + bounded(multiplier * rows[row].coefficients[index]));
    bound = bounded(bound + bounded(multiplier * rows[row].bound));
  }
  if (sum.some(value => value !== 0n) || bound >= 0n) throw new TypeError('certificate does not establish a contradiction');
}
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

export const PRIVATE_ATTESTATION_STATEMENT = Object.freeze({
  version: 'aether.private-module-statement/1',
  claim: 'There exists an artifact, commitment randomness, and a complete independently checked obligation certificate bundle bound to this public manifest and bounded semantic profile.',
  publicInputs: ['artifactCommitment', 'specRoot', 'dependencyClosureDigest', 'semanticsVersion', 'targetProfileDigest', 'compilerDigest', 'effectPolicyDigest', 'obligationSetDigest', 'checkerImageId', 'boundProfileDigest', 'nonce', 'policyEpoch'],
  privateWitness: ['artifactBytes', 'commitmentRandomness', 'typedPrivateAST', 'loweringCertificateOrDeclaredCompilerTCB', 'completeObligationCertificates'],
  distinction: 'A receipt for one execution of the private program proves only that execution. A receipt for a checker processing every soundly derived obligation can attest the stated universal or bounded property, subject to the checker/derivation semantics and target binding.',
});
