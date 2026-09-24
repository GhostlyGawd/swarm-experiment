/** Shared Artifact/4 proof. This module is bundled into the worker, so it must
 * never import the host's bundle producer or include the bundle's own digest. */
import { decode as decodeIR, encode as encodeIR } from '../tier1/agent-ir.ts';
import { children, type Term } from '../tier1/ast.ts';
import { type SymbolId } from '../tier1/ids.ts';
import { GraphStore } from '../tier1/store.ts';
import { buildVirtualForwardCandidate, checkVirtualForwardDescriptor,
  type VirtualForwardDescriptor } from '../tier1/semantic-gc-virtual-forward.ts';
import { CausalLineageLedger } from '../tier1/causal-lineage.ts';
import { CapabilityRegistry, PURE_COMPUTE } from '../tier2/ocap.ts';
import { typecheck } from '../tier2/typecheck.ts';
import { decodeCanonical, encodeCanonical, exactObject } from '../fabric/encoding.ts';
import { createEvidenceManifest, DEFAULT_EVIDENCE_POLICY_V2, DEFAULT_EVIDENCE_POLICY_V3,
  validateEvidence, type EvidenceContext, type LocalEvidenceV1 } from '../fabric/evidence.ts';
import { domainDigest, executionManifestDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { RESUMABLE_PROFILE_DIGEST, virtualForwardResumableProfileDigest } from '../tier3/resumable-program.ts';

type Module = Extract<Term, { kind: 'Module' }>;
type Decl = Extract<Term, { kind: 'FunctionDecl' }>;
const FORMAT = 'aether.process-artifact/4' as const;
const SUBJECT_FORMAT = 'aether.measured-executable-subject/2' as const;
export const ARTIFACT4_LIMITS = { maxFrameBytes: 16 * 1024 * 1024,
  maxDecompressedBytes: 16 * 1024 * 1024, maxObjects: 500_000, maxDepth: 128 };
export const artifact4Same = (a: unknown, b: unknown): boolean =>
  Buffer.from(encodeCanonical(a, ARTIFACT4_LIMITS)).equals(Buffer.from(encodeCanonical(b, ARTIFACT4_LIMITS)));
export const artifact4Clone = <T>(value: T): T =>
  decodeCanonical(encodeCanonical(value, ARTIFACT4_LIMITS), ARTIFACT4_LIMITS) as T;

export interface MeasuredFileV2 {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface ProcessWorkerBundleManifestV2 {
  readonly format: 'aether.process-worker-bundle/2';
  readonly entry: string;
  readonly node: MeasuredFileV2;
  readonly tool: unknown;
  readonly nativeRuntime: unknown;
  readonly bundle: MeasuredFileV2;
  readonly inputs: readonly MeasuredFileV2[];
  readonly externalNodeImports: readonly string[];
}
export interface MeasuredExecutableSubjectV2 {
  readonly format: typeof SUBJECT_FORMAT;
  readonly manifest: ProcessWorkerBundleManifestV2;
  readonly digest: Digest;
}
export interface ProcessVirtualArtifactV4 {
  readonly format: typeof FORMAT;
  readonly specification: string;
  readonly sourceIr: string;
  readonly candidateIr: string;
  readonly descriptor: VirtualForwardDescriptor;
  readonly sourceEvidence: LocalEvidenceV1;
  readonly candidateEvidence: LocalEvidenceV1;
  readonly archivedWrapper: { readonly symbol: SymbolId; readonly ir: string };
  readonly executableSubject: MeasuredExecutableSubjectV2;
  readonly lineageBinding: { readonly sourceIntent: Digest; readonly candidateIntent: Digest };
}

export function artifact4SubjectDigest(manifest: ProcessWorkerBundleManifestV2): Digest {
  return domainDigest(SUBJECT_FORMAT, { format: SUBJECT_FORMAT, manifest }, ARTIFACT4_LIMITS);
}

function moduleFromIR(value: unknown): Module {
  if (typeof value !== 'string') throw new TypeError('process artifact requires Agent-IR text');
  const module = decodeIR(value);
  if (module.kind !== 'Module' || encodeIR(module).text !== value)
    throw new TypeError('noncanonical process module IR');
  return module;
}
function declarationFromIR(value: unknown): Decl {
  if (typeof value !== 'string') throw new TypeError('process artifact requires declaration IR');
  const declaration = decodeIR(value);
  if (declaration.kind !== 'FunctionDecl' || encodeIR(declaration).text !== value)
    throw new TypeError('noncanonical archived declaration IR');
  return declaration;
}
function* walk(term: Term): Generator<Term> { yield term; for (const child of children(term)) yield* walk(child); }
function assertPureClosed(module: Module, registry: CapabilityRegistry): void {
  if (registry.names.length !== 1 || registry.names[0] !== PURE_COMPUTE)
    throw new TypeError('Artifact/4 only admits default pure capability registry');
  if (!typecheck(module, { registry }).ok) throw new TypeError('ill-typed Artifact/4 module');
  for (const term of walk(module)) {
    if (['Invoke', 'Spawn', 'Await', 'Import', 'Lambda', 'Apply', 'SeqMap', 'SeqFold'].includes(term.kind))
      throw new TypeError('Artifact/4 rejects effectful or dynamic modules');
    if (term.kind === 'FunctionDecl' && (term.purity !== 'pure' || term.capabilities.length))
      throw new TypeError('Artifact/4 requires pure declarations');
  }
}

/** Caller provides the context-specific executable measurement. The host
 * rebuilds the whole producer manifest; the packaged child verifies its own
 * launched bundle and the available binary/static library bytes. Both paths
 * use this one proof for signed source, candidate, evidence and ancestry. */
export function validateProcessVirtualArtifactV4Core(value: unknown,
  lineage: CausalLineageLedger,
  assertSubject: (value: unknown) => MeasuredExecutableSubjectV2): ProcessVirtualArtifactV4 {
  if (!(lineage instanceof CausalLineageLedger))
    throw new TypeError('Artifact/4 requires a real signed lineage ledger');
  encodeCanonical(value, ARTIFACT4_LIMITS);
  const raw = exactObject(value, ['format', 'specification', 'sourceIr', 'candidateIr', 'descriptor',
    'sourceEvidence', 'candidateEvidence', 'archivedWrapper', 'executableSubject',
    'lineageBinding']);
  if (raw.format !== FORMAT) throw new TypeError('unsupported process virtual artifact version');
  const source = moduleFromIR(raw.sourceIr), candidate = moduleFromIR(raw.candidateIr);
  const archived = exactObject(raw.archivedWrapper, ['symbol', 'ir']);
  const wrapper = declarationFromIR(archived.ir);
  const descriptor = raw.descriptor as VirtualForwardDescriptor;
  if (archived.symbol !== wrapper.symbol || wrapper.symbol !== descriptor.wrapper)
    throw new TypeError('archived wrapper symbol mismatch');
  const graph = new GraphStore();
  if (graph.intern(source) !== descriptor.sourceRoot || graph.intern(candidate) !== descriptor.candidateRoot
    || graph.intern(wrapper) !== descriptor.wrapperDeclaration)
    throw new TypeError('process virtual artifact AST root mismatch');
  checkVirtualForwardDescriptor(descriptor, source, candidate);
  const expected = buildVirtualForwardCandidate(source, descriptor.wrapper, descriptor.target);
  if (graph.intern(expected.candidate) !== graph.intern(candidate)
    || !artifact4Same(expected.descriptor, descriptor))
    throw new TypeError('process artifact candidate is not exact virtual rewrite');
  const original = source.members.find((member): member is Decl =>
    member.kind === 'FunctionDecl' && member.symbol === wrapper.symbol);
  if (!original || graph.intern(original) !== graph.intern(wrapper))
    throw new TypeError('archived wrapper differs from source');
  const registry = new CapabilityRegistry();
  assertPureClosed(source, registry); assertPureClosed(candidate, registry);
  const subject = assertSubject(raw.executableSubject);
  const sourceEvidence = raw.sourceEvidence as LocalEvidenceV1;
  const candidateEvidence = raw.candidateEvidence as LocalEvidenceV1;
  const before = sourceEvidence.manifest, after = candidateEvidence.manifest;
  if (!before || !after || before.astRoot !== descriptor.sourceRoot
    || after.astRoot !== descriptor.candidateRoot || before.specRoot !== after.specRoot
    || before.semanticsVersion !== 'aether-reference/1' || after.semanticsVersion !== before.semanticsVersion
    || before.compilerDigest !== after.compilerDigest
    || before.capabilityPolicyDigest !== after.capabilityPolicyDigest
    || before.target.abiVersion !== 'resumable/1' || after.target.abiVersion !== 'resumable/1'
    || before.target.profileDigest !== RESUMABLE_PROFILE_DIGEST
    || after.target.profileDigest !== virtualForwardResumableProfileDigest(descriptor)
    || after.target.artifactDigest !== subject.digest)
    throw new TypeError('process artifact signed evidence/profile/executable mismatch');
  const base = { semanticsVersion: before.semanticsVersion,
    compilerDigest: before.compilerDigest, capabilityPolicyDigest: before.capabilityPolicyDigest,
    registry };
  const specification = raw.specification;
  if (typeof specification !== 'string') throw new TypeError('process artifact specification missing');
  const sourceContext: EvidenceContext = { ...base, specification, module: source,
    target: before.target, policy: DEFAULT_EVIDENCE_POLICY_V2 };
  const candidateContext: EvidenceContext = { ...base, specification, module: candidate,
    target: after.target, policy: DEFAULT_EVIDENCE_POLICY_V3,
    virtualForward: { source, descriptor },
    resolveDeclaration: symbol => symbol === wrapper.symbol ? wrapper : undefined };
  if (!artifact4Same(createEvidenceManifest(sourceContext), before)
    || !artifact4Same(createEvidenceManifest(candidateContext), after))
    throw new TypeError('process artifact evidence dependency closure changed');
  validateEvidence(sourceEvidence, sourceContext);
  validateEvidence(candidateEvidence, candidateContext);
  const dependencies = after.dependencies.filter(dep =>
    !candidate.members.some(member => member.kind === 'FunctionDecl' && member.symbol === dep.symbol));
  if (dependencies.length !== 1 || dependencies[0].symbol !== wrapper.symbol
    || dependencies[0].declaration !== descriptor.wrapperDeclaration)
    throw new TypeError('process artifact archived wrapper dependency closure mismatch');
  const sourceDigest = executionManifestDigest(before), candidateDigest = executionManifestDigest(after);
  const sourceEvidenceDigest = domainDigest('aether.evidence-bundle/1', sourceEvidence, ARTIFACT4_LIMITS);
  const candidateEvidenceDigest = domainDigest('aether.evidence-bundle/1', candidateEvidence, ARTIFACT4_LIMITS);
  const binding = exactObject(raw.lineageBinding, ['sourceIntent', 'candidateIntent']);
  validateDigest(binding.sourceIntent, 'aether.intent/1');
  validateDigest(binding.candidateIntent, 'aether.intent/1');
  CausalLineageLedger.prototype.assertCurrent.call(lineage, sourceDigest);
  CausalLineageLedger.prototype.assertCurrent.call(lineage, candidateDigest);
  CausalLineageLedger.prototype.assertNodeCurrent.call(lineage, candidateDigest,
    descriptor.wrapperDeclaration);
  const invalid = new Set(CausalLineageLedger.prototype.invalidation.call(lineage)
    .map(item => item.artifact));
  const currentRows = (root: string, manifest: Digest) =>
    CausalLineageLedger.prototype.lineage.call(lineage, root as typeof descriptor.sourceRoot)
      .filter(row => !invalid.has(row.artifact)
        && row.ancestry[0]?.body.executionManifest === manifest);
  if (!currentRows(descriptor.sourceRoot, sourceDigest)
    .some(row => row.intent === binding.sourceIntent
      && row.ancestry[0]?.body.evidenceBundleDigest === sourceEvidenceDigest)
    || !currentRows(descriptor.candidateRoot, candidateDigest)
      .some(row => row.intent === binding.candidateIntent
        && row.ancestry[0]?.body.evidenceBundleDigest === candidateEvidenceDigest
        && row.ancestry[0]?.body.parents.includes(binding.sourceIntent as Digest)))
    throw new TypeError('Artifact/4 candidate lacks exact signed source parent');
  return artifact4Clone(value as ProcessVirtualArtifactV4);
}
