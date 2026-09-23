/** Opt-in independent proof binding for a closed scalar conservative tier.
 * This checks source-level total correctness; it does not qualify native
 * lowering, active-frame switching, external effects, or runtime budgets. */
import type { Term } from '../tier1/ast.ts';
import type { SymbolId } from '../tier1/ids.ts';
import { decode as decodeIR, encode as encodeIR } from '../tier1/agent-ir.ts';
import { GraphStore } from '../tier1/store.ts';
import { checkPortableCertificate, type PortableCertificateV1 } from '../tier2/portable-proof-checker.ts';
import { encodeCanonical } from '../fabric/encoding.ts';
import { decodeExecutionManifest, encodeExecutionManifest, domainDigest, executionManifestDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';

export interface ConservativeFallbackProofInput {
  readonly module: Term;
  readonly manifest: ExecutionManifestV1;
  readonly specification: string;
  readonly certificate: PortableCertificateV1;
}

/** The proof module contains exactly the executed Tier 2 declaration. Every
 * other execution dimension must match the full fallback manifest. */
export function checkConservativeFallbackProof(fullModule: Term, fullManifest: ExecutionManifestV1,
  tier2: SymbolId, input: ConservativeFallbackProofInput): Digest {
  const executed = decodeIR(encodeIR(fullModule).text);
  const module = decodeIR(encodeIR(input.module).text);
  const manifest = decodeExecutionManifest(encodeExecutionManifest(input.manifest));
  const full = decodeExecutionManifest(encodeExecutionManifest(fullManifest));
  if (executed.kind !== 'Module' || module.kind !== 'Module' || module.members.length !== 1 || module.members[0].kind !== 'FunctionDecl'
    || module.members[0].symbol !== tier2 || full.dependencies.length || manifest.dependencies.length)
    throw new TypeError('conservative proof requires one closed Tier 2 declaration');
  const matches = executed.members.filter(member => member.kind === 'FunctionDecl' && member.symbol === tier2);
  const declaration = matches[0];
  if (matches.length !== 1 || new GraphStore().intern(declaration) !== new GraphStore().intern(module.members[0]))
    throw new TypeError('conservative proof does not bind the executed Tier 2 declaration');
  if (declaration.kind !== 'FunctionDecl' || declaration.contract?.kind !== 'Contract' || declaration.contract.ensures.length === 0)
    throw new TypeError('conservative proof requires an explicit postcondition');
  if (new GraphStore().intern(executed) !== full.astRoot || new GraphStore().intern(module) !== manifest.astRoot)
    throw new TypeError('conservative proof module/manifest mismatch');
  const { astRoot: _fullRoot, ...fullContext } = full;
  const { astRoot: _proofRoot, ...proofContext } = manifest;
  if (!Buffer.from(encodeCanonical(fullContext)).equals(Buffer.from(encodeCanonical(proofContext))))
    throw new TypeError('conservative proof execution context mismatch');
  const checked = checkPortableCertificate(module, input.certificate, { expectedManifest: manifest, specification: input.specification });
  if (checked.symbols.length !== 1 || checked.symbols[0] !== tier2)
    throw new TypeError('conservative proof lacks exact Tier 2 coverage');
  return domainDigest('aether.conservative-fallback-proof/1', {
    fullManifest: executionManifestDigest(full), declaration: new GraphStore().intern(declaration),
    proofManifest: executionManifestDigest(manifest), bundle: checked.bundleDigest,
  });
}
