/** Optional proof search. Consumers only need portable-formula-checker.ts. */
import type { SmtFormula } from './smt.ts';
import type { Digest } from '../fabric/identity.ts';
import { formulaCounterexampleCases, formulaCasesDigest } from './portable-formula.ts';
import { generateLinearCertificate } from './portable-linear-producer.ts';
import { checkFormulaCertificate, FORMULA_PROFILE_DIGEST, type FormulaCertificateV1 } from './portable-formula-checker.ts';

export function generateFormulaCertificate(formula: SmtFormula, executionManifest: Digest): FormulaCertificateV1 | null {
  const derived = formulaCounterexampleCases(formula, executionManifest);
  const cases: { index: number; certificate: NonNullable<ReturnType<typeof generateLinearCertificate>> }[] = [];
  for (const branch of derived) {
    const certificate = generateLinearCertificate(branch.claim);
    if (certificate === null) return null;
    cases.push({ index: branch.index, certificate });
  }
  const result: FormulaCertificateV1 = { format: 'aether.portable-formula-proof/1', executionManifest, profileDigest: FORMULA_PROFILE_DIGEST, caseSetDigest: formulaCasesDigest(derived), cases };
  checkFormulaCertificate(formula, result, executionManifest);
  return result;
}
