/** Optional producer for the independent portable AST certificate consumer. */
import type { Term } from '../tier1/ast.ts';
import { decodeCanonical, encodeCanonical } from '../fabric/encoding.ts';
import { derivePortableObligations, type PortableDerivationOptions } from './portable-obligations.ts';
import { generateFormulaCertificate } from './portable-formula-producer.ts';
import { FORMULA_PROFILE_DIGEST } from './portable-formula-checker.ts';
import { checkPortableCertificate, portableObligationSetDigest, PORTABLE_CERTIFICATE_LIMITS, type PortableCertificateV1 } from './portable-proof-checker.ts';

export function generatePortableCertificate(module: Term, options: PortableDerivationOptions): PortableCertificateV1 | null {
  const derived = derivePortableObligations(module, options);
  if (derived.unsupported.length) return null;
  const certificates: PortableCertificateV1['certificates'][number][] = [];
  for (const obligation of derived.obligations) {
    const proof = generateFormulaCertificate(obligation.formula, derived.manifestDigest);
    if (proof === null) return null;
    certificates.push({ obligationId: obligation.id, proof });
  }
  const result: PortableCertificateV1 = { format: 'aether.portable-ast-proof/1', manifest: options.manifest, derivationProfileDigest: derived.profileDigest,
    formulaProfileDigest: FORMULA_PROFILE_DIGEST, obligationSetDigest: portableObligationSetDigest(derived), certificates };
  const copy = decodeCanonical(encodeCanonical(result, PORTABLE_CERTIFICATE_LIMITS), PORTABLE_CERTIFICATE_LIMITS) as unknown as PortableCertificateV1;
  checkPortableCertificate(module, copy, options); return copy;
}
