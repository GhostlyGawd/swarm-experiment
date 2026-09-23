/** Independent formula certificate consumer. It never invokes proof search. */
import type { SmtFormula } from './smt.ts';
import { encodeCanonical, exactObject } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { formulaCounterexampleCases, formulaCasesDigest, FORMULA_PROFILE } from './portable-formula.ts';
import { checkLinearCertificate, type LinearCertificate } from './portable-linear-kernel.ts';

export const FORMULA_PROFILE_DIGEST = domainDigest('aether.portable-formula-profile/1', FORMULA_PROFILE);
export const FORMULA_CERTIFICATE_LIMITS = Object.freeze({ maxFrameBytes: 4 * 1024 * 1024, maxDecompressedBytes: 4 * 1024 * 1024, maxObjects: 500_000, maxDepth: 32 });
export interface FormulaCertificateV1 {
  readonly format: 'aether.portable-formula-proof/1';
  readonly executionManifest: Digest;
  readonly profileDigest: Digest;
  readonly caseSetDigest: Digest;
  readonly cases: readonly { readonly index: number; readonly certificate: LinearCertificate }[];
}
export function checkFormulaCertificate(formula: SmtFormula, value: unknown, expectedManifest: Digest): void {
  validateDigest(expectedManifest, 'aether.execution/1');
  encodeCanonical(value, FORMULA_CERTIFICATE_LIMITS);
  const certificate = exactObject(value, ['format', 'executionManifest', 'profileDigest', 'caseSetDigest', 'cases']);
  if (certificate.format !== 'aether.portable-formula-proof/1' || certificate.executionManifest !== expectedManifest || certificate.profileDigest !== FORMULA_PROFILE_DIGEST || !Array.isArray(certificate.cases)) throw new TypeError('unsupported or stale formula certificate');
  const derived = formulaCounterexampleCases(formula, expectedManifest);
  if (certificate.caseSetDigest !== formulaCasesDigest(derived) || certificate.cases.length !== derived.length) throw new TypeError('incomplete or changed formula case coverage');
  for (let index = 0; index < derived.length; index++) {
    const item = exactObject(certificate.cases[index], ['index', 'certificate']);
    if (item.index !== index) throw new TypeError('duplicate or reordered formula case');
    checkLinearCertificate(derived[index].claim, item.certificate, expectedManifest);
  }
}
