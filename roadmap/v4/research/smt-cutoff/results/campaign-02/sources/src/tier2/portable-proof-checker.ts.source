/** Portable AST certificate admission, independent of all proof-search engines. */
import type { Term } from '../tier1/ast.ts';
import type { SymbolId } from '../tier1/ids.ts';
import { decodeCanonical, encodeCanonical, exactObject } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { derivePortableObligations, type PortableDerivationOptions, type PortableObligationSet } from './portable-obligations.ts';
import { formulaCounterexampleCases, formulaCasesDigest } from './portable-formula.ts';
import { checkFormulaCertificate, FORMULA_PROFILE_DIGEST, type FormulaCertificateV1 } from './portable-formula-checker.ts';

export const PORTABLE_CERTIFICATE_LIMITS = Object.freeze({ maxFrameBytes: 4 * 1024 * 1024, maxDecompressedBytes: 4 * 1024 * 1024, maxObjects: 500_000, maxDepth: 64 });
export interface PortableCertificateV1 {
  readonly format: 'aether.portable-ast-proof/1';
  readonly manifest: ExecutionManifestV1;
  readonly derivationProfileDigest: Digest;
  readonly formulaProfileDigest: Digest;
  readonly obligationSetDigest: Digest;
  readonly certificates: readonly { readonly obligationId: Digest; readonly proof: FormulaCertificateV1 }[];
}
export interface CheckedPortableCertificate {
  readonly format: 'aether.checked-portable-proof/1';
  readonly manifestDigest: Digest;
  readonly astRoot: Digest;
  readonly obligationSetDigest: Digest;
  readonly bundleDigest: Digest;
  readonly derivationProfileDigest: Digest;
  readonly formulaProfileDigest: Digest;
  readonly symbols: readonly SymbolId[];
}
const checked = new WeakMap<object, Digest>();
export function portableObligationSetDigest(set: PortableObligationSet): Digest {
  return domainDigest('aether.portable-obligation-set/1', {
    manifestDigest: set.manifestDigest, profileDigest: set.profileDigest,
    obligations: set.obligations.map(obligation => ({ id: obligation.id, symbol: obligation.symbol, kind: obligation.kind, casesDigest: formulaCasesDigest(formulaCounterexampleCases(obligation.formula, set.manifestDigest)) })),
    unsupported: set.unsupported,
  }, PORTABLE_CERTIFICATE_LIMITS);
}
export function portableCertificateDigest(value: PortableCertificateV1): Digest { return domainDigest('aether.portable-ast-proof/1', value, PORTABLE_CERTIFICATE_LIMITS); }
export function encodePortableCertificate(value: PortableCertificateV1): Uint8Array { return encodeCanonical(value, PORTABLE_CERTIFICATE_LIMITS); }
export function decodePortableCertificate(bytes: Uint8Array): unknown { return decodeCanonical(bytes, PORTABLE_CERTIFICATE_LIMITS); }

/** Expected execution context is trusted consumer input, never copied from the
 * sender's claimed manifest. Every obligation is independently reconstructed. */
export function checkPortableCertificate(module: Term, value: unknown, context: Omit<PortableDerivationOptions, 'manifest'>): CheckedPortableCertificate {
  encodeCanonical(value, PORTABLE_CERTIFICATE_LIMITS);
  const certificate = exactObject(value, ['format', 'manifest', 'derivationProfileDigest', 'formulaProfileDigest', 'obligationSetDigest', 'certificates']);
  if (certificate.format !== 'aether.portable-ast-proof/1' || certificate.formulaProfileDigest !== FORMULA_PROFILE_DIGEST || !Array.isArray(certificate.certificates)) throw new TypeError('unsupported portable certificate');
  const manifest = certificate.manifest as ExecutionManifestV1;
  if (executionManifestDigest(manifest) !== executionManifestDigest(context.expectedManifest)) throw new TypeError('portable proof does not match current execution context');
  const derived = derivePortableObligations(module, { ...context, manifest });
  if (derived.unsupported.length) throw new TypeError(`portable semantic fragment unsupported: ${derived.unsupported.map(item => item.reason).join('; ')}`);
  if (certificate.derivationProfileDigest !== derived.profileDigest || certificate.obligationSetDigest !== portableObligationSetDigest(derived)) throw new TypeError('changed portable derivation profile or obligation set');
  if (certificate.certificates.length !== derived.obligations.length) throw new TypeError('incomplete portable obligation coverage');
  for (let i = 0; i < derived.obligations.length; i++) {
    const record = exactObject(certificate.certificates[i], ['obligationId', 'proof']);
    if (record.obligationId !== derived.obligations[i].id) throw new TypeError('duplicate, missing or reordered portable obligation');
    checkFormulaCertificate(derived.obligations[i].formula, record.proof, derived.manifestDigest);
  }
  const result: CheckedPortableCertificate = Object.freeze({ format: 'aether.checked-portable-proof/1', manifestDigest: derived.manifestDigest, astRoot: manifest.astRoot,
    obligationSetDigest: certificate.obligationSetDigest as Digest, bundleDigest: portableCertificateDigest(value as PortableCertificateV1),
    derivationProfileDigest: derived.profileDigest, formulaProfileDigest: FORMULA_PROFILE_DIGEST,
    symbols: Object.freeze([...new Set(derived.obligations.map(obligation => obligation.symbol))].sort()),
  });
  checked.set(result, derived.manifestDigest); return result;
}

/** Local checked objects cannot be fabricated or restored by JSON deserialization.
 * A peer must supply the actual portable bundle for independent checking again. */
export function validateCheckedPortableCertificate(value: CheckedPortableCertificate, expectedManifest: ExecutionManifestV1): void {
  const expected = executionManifestDigest(expectedManifest);
  if (!value || typeof value !== 'object' || checked.get(value) !== expected || value.manifestDigest !== expected || value.astRoot !== expectedManifest.astRoot) throw new TypeError('untrusted or stale checked portable certificate');
}

export type { PortableDerivationOptions, PortableObligationSet, ResolvedPortableDependency } from './portable-obligations.ts';
