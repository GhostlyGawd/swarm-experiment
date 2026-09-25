/** Optional search for the bounded record fallback; the checker rederives all goals. */
import type { RecordFallbackContext, RecordFallbackCertificateV1 } from './record-fallback-proof-checker.ts';
import { deriveRecordFallbackObligations, checkRecordFallbackCertificate, RECORD_FALLBACK_PROFILE_DIGEST } from './record-fallback-proof-checker.ts';
import { generateFormulaCertificate } from './portable-formula-producer.ts';

export function generateRecordFallbackCertificate(context: RecordFallbackContext): RecordFallbackCertificateV1 | null {
  const derived = deriveRecordFallbackObligations(context);
  const certificates: RecordFallbackCertificateV1['certificates'][number][] = [];
  for (const obligation of derived.obligations) {
    const proof = generateFormulaCertificate(obligation.formula, derived.manifestDigest);
    if (proof === null) return null;
    certificates.push({ kind: obligation.kind, proof });
  }
  const result: RecordFallbackCertificateV1 = {
    format: 'aether.record-fallback-proof/1', manifest: context.manifest,
    tier2: context.tier2, declarationRoot: derived.declarationRoot,
    profileDigest: RECORD_FALLBACK_PROFILE_DIGEST, obligationSetDigest: derived.obligationSetDigest,
    certificates,
  };
  checkRecordFallbackCertificate(context, result);
  return result;
}
