/** Artifact/3 is the process-boundary subject for one checked, pure virtual
 * forwarder. It is deliberately not a ProcessDeployment state or worker wire
 * format: neither may dispatch this artifact until they have versioned support.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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
const FORMAT = 'aether.process-artifact/3' as const;
const SUBJECT_FORMAT = 'aether.measured-executable-subject/1' as const;
const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 };
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
/** Current closed worker graph has more than 64 inputs; keep a finite bound
 * while admitting the independently recounted complete source set. */
const MAX_SOURCE_FILES = 128;
const same = (a: unknown, b: unknown): boolean =>
  Buffer.from(encodeCanonical(a, LIMITS)).equals(Buffer.from(encodeCanonical(b, LIMITS)));
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T;

export interface MeasuredFileV1 {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface MeasuredExecutableSubjectV1 {
  readonly format: typeof SUBJECT_FORMAT;
  /** The current Node binary, checked against process.execPath on every read. */
  readonly node: MeasuredFileV1;
  /** Caller-selected executable bundle bytes. This is not yet a worker launch. */
  readonly bundle: MeasuredFileV1;
  /** Complete declared source inputs, in canonical path order. */
  readonly sources: readonly MeasuredFileV1[];
  readonly digest: Digest;
}
export interface ProcessVirtualArtifactV3 {
  readonly format: typeof FORMAT;
  readonly specification: string;
  readonly sourceIr: string;
  readonly candidateIr: string;
  readonly descriptor: VirtualForwardDescriptor;
  readonly sourceEvidence: LocalEvidenceV1;
  readonly candidateEvidence: LocalEvidenceV1;
  readonly archivedWrapper: { readonly symbol: SymbolId; readonly ir: string };
  readonly executableSubject: MeasuredExecutableSubjectV1;
  readonly lineageBinding: { readonly sourceIntent: Digest; readonly candidateIntent: Digest };
}
export interface ProcessVirtualArtifactInputV3 {
  readonly sourceContext: EvidenceContext;
  readonly candidateContext: EvidenceContext;
  readonly sourceEvidence: LocalEvidenceV1;
  readonly candidateEvidence: LocalEvidenceV1;
  readonly bundlePath: string;
  readonly sourcePaths: readonly string[];
  readonly sourceIntent: Digest;
  readonly candidateIntent: Digest;
  /** Independent, signed lineage authority for both exact manifests. */
  readonly lineage: CausalLineageLedger;
}

function measureFile(path: string): MeasuredFileV1 {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('executable file path must be absolute');
  const canonical = realpathSync(path);
  const before = statSync(canonical);
  if (!before.isFile() || before.size < 1 || before.size > MAX_EXECUTABLE_BYTES)
    throw new TypeError('invalid executable file');
  const hash = createHash('sha256'), block = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(canonical, 'r');
  try {
    let count = 0;
    while (true) {
      const size = readSync(fd, block, 0, block.length, null);
      if (!size) break;
      count += size;
      if (count > MAX_EXECUTABLE_BYTES) throw new RangeError('executable file byte bound exceeded');
      hash.update(block.subarray(0, size));
    }
    const after = statSync(canonical);
    if (count !== before.size || count !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || before.dev !== after.dev || before.ino !== after.ino)
      throw new Error('executable file changed during measurement');
    return { path: canonical, bytes: count, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}

export function measureExecutableSubjectV1(bundlePath: string,
  sourcePaths: readonly string[]): MeasuredExecutableSubjectV1 {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.length > MAX_SOURCE_FILES)
    throw new TypeError('complete bounded executable source list required');
  const node = measureFile(realpathSync(process.execPath));
  const bundle = measureFile(bundlePath);
  const sources = sourcePaths.map(measureFile).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(sources.map(item => item.path)).size !== sources.length)
    throw new TypeError('duplicate executable source path');
  const body = { format: SUBJECT_FORMAT, node, bundle, sources };
  return { ...body, digest: domainDigest(SUBJECT_FORMAT, body, LIMITS) };
}

function assertMeasuredSubject(value: unknown): asserts value is MeasuredExecutableSubjectV1 {
  const subject = exactObject(value, ['format', 'node', 'bundle', 'sources', 'digest']);
  if (subject.format !== SUBJECT_FORMAT || !Array.isArray(subject.sources))
    throw new TypeError('invalid measured executable subject');
  const node = exactObject(subject.node, ['path', 'bytes', 'sha256']);
  if (node.path !== realpathSync(process.execPath))
    throw new TypeError('executable subject names a different Node binary');
  const bundle = exactObject(subject.bundle, ['path', 'bytes', 'sha256']);
  for (const source of subject.sources) exactObject(source, ['path', 'bytes', 'sha256']);
  const measured = measureExecutableSubjectV1(bundle.path as string,
    subject.sources.map(source => (source as MeasuredFileV1).path));
  if (!same(value, measured)) throw new TypeError('measured executable bytes or subject identity changed');
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
    throw new TypeError('Artifact/3 only admits default pure capability registry');
  if (!typecheck(module, { registry }).ok) throw new TypeError('ill-typed Artifact/3 module');
  for (const term of walk(module)) {
    if (['Invoke', 'Spawn', 'Await', 'Import', 'Lambda', 'Apply', 'SeqMap', 'SeqFold'].includes(term.kind))
      throw new TypeError('Artifact/3 rejects effectful or dynamic modules');
    if (term.kind === 'FunctionDecl' && (term.purity !== 'pure' || term.capabilities.length))
      throw new TypeError('Artifact/3 requires pure declarations');
  }
}

/** Recheck every execution-bearing field from its bytes and from independent
 * signed lineage. Caller-supplied contexts, labels, and cached roots have no
 * authority on this read path. */
export function validateProcessVirtualArtifactV3(value: unknown,
  lineage: CausalLineageLedger): ProcessVirtualArtifactV3 {
  if (!(lineage instanceof CausalLineageLedger))
    throw new TypeError('Artifact/3 requires a real signed lineage ledger');
  encodeCanonical(value, LIMITS);
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
    || !same(expected.descriptor, descriptor))
    throw new TypeError('process artifact candidate is not exact virtual rewrite');
  const original = source.members.find((member): member is Decl =>
    member.kind === 'FunctionDecl' && member.symbol === wrapper.symbol);
  if (!original || graph.intern(original) !== graph.intern(wrapper))
    throw new TypeError('archived wrapper differs from source');
  const registry = new CapabilityRegistry();
  assertPureClosed(source, registry); assertPureClosed(candidate, registry);
  assertMeasuredSubject(raw.executableSubject);
  const subject = raw.executableSubject as MeasuredExecutableSubjectV1;
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
  if (!same(createEvidenceManifest(sourceContext), before)
    || !same(createEvidenceManifest(candidateContext), after))
    throw new TypeError('process artifact evidence dependency closure changed');
  validateEvidence(sourceEvidence, sourceContext);
  validateEvidence(candidateEvidence, candidateContext);
  const dependencies = after.dependencies.filter(dep =>
    !candidate.members.some(member => member.kind === 'FunctionDecl' && member.symbol === dep.symbol));
  if (dependencies.length !== 1 || dependencies[0].symbol !== wrapper.symbol
    || dependencies[0].declaration !== descriptor.wrapperDeclaration)
    throw new TypeError('process artifact archived wrapper dependency closure mismatch');
  const sourceDigest = executionManifestDigest(before), candidateDigest = executionManifestDigest(after);
  const sourceEvidenceDigest = domainDigest('aether.evidence-bundle/1', sourceEvidence, LIMITS);
  const candidateEvidenceDigest = domainDigest('aether.evidence-bundle/1', candidateEvidence, LIMITS);
  const binding = exactObject(raw.lineageBinding, ['sourceIntent', 'candidateIntent']);
  validateDigest(binding.sourceIntent, 'aether.intent/1');
  validateDigest(binding.candidateIntent, 'aether.intent/1');
  // Call the trusted prototype methods, not replaceable instance properties.
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
    throw new TypeError('Artifact/3 candidate lacks exact signed source parent');
  return clone(value as ProcessVirtualArtifactV3);
}

export function makeProcessVirtualArtifactV3(input: ProcessVirtualArtifactInputV3): ProcessVirtualArtifactV3 {
  const { sourceContext, candidateContext } = input;
  if (sourceContext.module.kind !== 'Module' || candidateContext.module.kind !== 'Module'
    || !candidateContext.virtualForward)
    throw new TypeError('Artifact/3 requires exact source and candidate modules');
  const descriptor = candidateContext.virtualForward.descriptor;
  const wrapper = sourceContext.module.members.find((member): member is Decl =>
    member.kind === 'FunctionDecl' && member.symbol === descriptor.wrapper);
  if (!wrapper) throw new TypeError('Artifact/3 source wrapper missing');
  const artifact: ProcessVirtualArtifactV3 = {
    format: FORMAT, specification: candidateContext.specification,
    sourceIr: encodeIR(sourceContext.module).text,
    candidateIr: encodeIR(candidateContext.module).text,
    descriptor: clone(descriptor), sourceEvidence: clone(input.sourceEvidence),
    candidateEvidence: clone(input.candidateEvidence),
    archivedWrapper: { symbol: wrapper.symbol, ir: encodeIR(wrapper).text },
    executableSubject: measureExecutableSubjectV1(input.bundlePath, input.sourcePaths),
    lineageBinding: { sourceIntent: input.sourceIntent, candidateIntent: input.candidateIntent },
  };
  return validateProcessVirtualArtifactV3(artifact, input.lineage);
}

export function encodeProcessVirtualArtifactV3(artifact: ProcessVirtualArtifactV3): Uint8Array {
  return encodeCanonical(artifact, LIMITS);
}
export function decodeProcessVirtualArtifactV3(bytes: Uint8Array,
  lineage: CausalLineageLedger): ProcessVirtualArtifactV3 {
  return validateProcessVirtualArtifactV3(decodeCanonical(bytes, LIMITS), lineage);
}
export function processVirtualArtifactDigestV3(artifact: ProcessVirtualArtifactV3): Digest {
  return domainDigest(FORMAT, artifact, LIMITS);
}
