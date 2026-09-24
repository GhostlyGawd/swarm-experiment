/** Artifact/4 is the process-boundary subject for one checked, pure virtual
 * forwarder. It is deliberately not a ProcessDeployment state or worker wire
 * format: neither may dispatch this artifact until they have versioned support.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 };
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_FILES = 128;
const same = (a: unknown, b: unknown): boolean =>
  Buffer.from(encodeCanonical(a, LIMITS)).equals(Buffer.from(encodeCanonical(b, LIMITS)));
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T;

export interface MeasuredFileV2 {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
/** The V2 producer's exact object is checked by a fresh, independent rebuild.
 * Tool and native subtrees are opaque here because the producer owns their
 * versioned schema; canonical equality with the rebuilt output is mandatory. */
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
export interface ProcessVirtualArtifactInputV4 {
  readonly sourceContext: EvidenceContext;
  readonly candidateContext: EvidenceContext;
  readonly sourceEvidence: LocalEvidenceV1;
  readonly candidateEvidence: LocalEvidenceV1;
  /** Exact V2 manifest to be independently rebuilt before this artifact is made. */
  readonly bundleManifest: ProcessWorkerBundleManifestV2;
  readonly sourceIntent: Digest;
  readonly candidateIntent: Digest;
  /** Independent, signed lineage authority for both exact manifests. */
  readonly lineage: CausalLineageLedger;
}

function measureFile(path: string): MeasuredFileV2 {
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

/** Producer admission runs outside the worker. The verifier rebuilds the
 * esbuild graph twice, rescans imports, remeasures the exact 68-input closure,
 * toolchain, Node, static Mach-O links and dyld map/header identity. Spawning
 * the producer keeps esbuild and TypeScript out of the worker bundle. */
function verifyCurrentManifest(manifest: ProcessWorkerBundleManifestV2): void {
  const directory = mkdtempSync(join(tmpdir(), 'aether-artifact4-manifest-'));
  try {
    const path = join(directory, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest));
    const verifier = fileURLToPath(new URL('../../scripts/process-worker-bundle.ts', import.meta.url));
    const result = spawnSync(process.execPath,
      ['--experimental-strip-types', verifier, 'verify', manifest.bundle.path, path],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
        env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
    if (result.error || result.status !== 0)
      throw new TypeError(`Artifact/4 bundle rebuild failed: ${String(result.error ?? result.stderr).slice(0, 500)}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function measureWorkerBundleSubjectV2(value: unknown): MeasuredExecutableSubjectV2 {
  if (Object.keys(process.env).some(name => name.startsWith('DYLD_')))
    throw new TypeError('Artifact/4 refuses DYLD environment overrides');
  const manifest = clone(value) as ProcessWorkerBundleManifestV2;
  const fields = exactObject(manifest, ['format', 'entry', 'node', 'tool', 'nativeRuntime',
    'bundle', 'inputs', 'externalNodeImports']);
  if (fields.format !== 'aether.process-worker-bundle/2'
    || !Array.isArray(fields.inputs) || !fields.inputs.length || fields.inputs.length > MAX_SOURCE_FILES
    || !Array.isArray(fields.externalNodeImports))
    throw new TypeError('Artifact/4 requires a bounded V2 worker bundle manifest');
  const native = exactObject(fields.nativeRuntime, ['format', 'scope', 'architecture', 'macos',
    'dyldCache', 'probeTool', 'executable', 'libraries', 'systemInstallNames', 'links']);
  if (native.format !== 'aether.macos-node-static-link-closure/1'
    || !Array.isArray(native.libraries) || !native.libraries.length)
    throw new TypeError('Artifact/4 requires the measured macOS native static-link closure');
  const tool = exactObject(fields.tool, ['version', 'nativePackage', 'projectPackage',
    'package', 'api', 'binary', 'selectedNativePackage', 'selectedNativeBinary',
    'scanner', 'recipe', 'nativeProbeRecipe', 'lockfile']);
  const scanner = exactObject(tool.scanner, ['version', 'api']);
  const cache = exactObject(native.dyldCache, ['coverage', 'header', 'map']);
  for (const field of ['bundle', 'node'] as const) exactObject(fields[field], ['path', 'bytes', 'sha256']);
  for (const input of fields.inputs) exactObject(input, ['path', 'bytes', 'sha256']);
  if (manifest.node.path !== realpathSync(process.execPath))
    throw new TypeError('Artifact/4 names a different Node binary');
  const toolFiles = ['projectPackage', 'package', 'api', 'binary',
    'selectedNativePackage', 'selectedNativeBinary', 'recipe',
    'nativeProbeRecipe', 'lockfile'].map(name => tool[name] as MeasuredFileV2);
  const verifier = fileURLToPath(new URL('../../scripts/process-worker-bundle.ts', import.meta.url));
  if ((tool.recipe as MeasuredFileV2).path !== realpathSync(verifier))
    throw new TypeError('Artifact/4 build recipe is not the selected verifier');
  // Cheap current-byte checks reject tampering before the more expensive
  // independent graph and native closure rebuild.
  for (const file of [manifest.bundle, manifest.node, ...manifest.inputs,
    ...toolFiles, scanner.api as MeasuredFileV2, native.probeTool as MeasuredFileV2,
    cache.header as MeasuredFileV2, cache.map as MeasuredFileV2,
    ...(native.libraries as MeasuredFileV2[])]) {
    if (!same(measureFile(file.path), file))
      throw new TypeError('Artifact/4 measured bundle/input/native bytes changed');
  }
  verifyCurrentManifest(manifest);
  const body = { format: SUBJECT_FORMAT, manifest };
  return { ...body, digest: domainDigest(SUBJECT_FORMAT, body, LIMITS) };
}

function assertMeasuredBundleSubject(value: unknown): asserts value is MeasuredExecutableSubjectV2 {
  const subject = exactObject(value, ['format', 'manifest', 'digest']);
  if (subject.format !== SUBJECT_FORMAT)
    throw new TypeError('invalid Artifact/4 measured executable subject');
  const measured = measureWorkerBundleSubjectV2(subject.manifest);
  if (!same(value, measured)) throw new TypeError('Artifact/4 measured executable subject changed');
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

/** Recheck every execution-bearing field from its bytes and from independent
 * signed lineage. Caller-supplied contexts, labels, and cached roots have no
 * authority on this read path. */
export function validateProcessVirtualArtifactV4(value: unknown,
  lineage: CausalLineageLedger): ProcessVirtualArtifactV4 {
  if (!(lineage instanceof CausalLineageLedger))
    throw new TypeError('Artifact/4 requires a real signed lineage ledger');
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
  assertMeasuredBundleSubject(raw.executableSubject);
  const subject = raw.executableSubject as MeasuredExecutableSubjectV2;
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
    throw new TypeError('Artifact/4 candidate lacks exact signed source parent');
  return clone(value as ProcessVirtualArtifactV4);
}

export function makeProcessVirtualArtifactV4(input: ProcessVirtualArtifactInputV4): ProcessVirtualArtifactV4 {
  const { sourceContext, candidateContext } = input;
  if (sourceContext.module.kind !== 'Module' || candidateContext.module.kind !== 'Module'
    || !candidateContext.virtualForward)
    throw new TypeError('Artifact/4 requires exact source and candidate modules');
  const descriptor = candidateContext.virtualForward.descriptor;
  const wrapper = sourceContext.module.members.find((member): member is Decl =>
    member.kind === 'FunctionDecl' && member.symbol === descriptor.wrapper);
  if (!wrapper) throw new TypeError('Artifact/4 source wrapper missing');
  const artifact: ProcessVirtualArtifactV4 = {
    format: FORMAT, specification: candidateContext.specification,
    sourceIr: encodeIR(sourceContext.module).text,
    candidateIr: encodeIR(candidateContext.module).text,
    descriptor: clone(descriptor), sourceEvidence: clone(input.sourceEvidence),
    candidateEvidence: clone(input.candidateEvidence),
    archivedWrapper: { symbol: wrapper.symbol, ir: encodeIR(wrapper).text },
    executableSubject: measureWorkerBundleSubjectV2(input.bundleManifest),
    lineageBinding: { sourceIntent: input.sourceIntent, candidateIntent: input.candidateIntent },
  };
  return validateProcessVirtualArtifactV4(artifact, input.lineage);
}

export function encodeProcessVirtualArtifactV4(artifact: ProcessVirtualArtifactV4): Uint8Array {
  return encodeCanonical(artifact, LIMITS);
}
export function decodeProcessVirtualArtifactV4(bytes: Uint8Array,
  lineage: CausalLineageLedger): ProcessVirtualArtifactV4 {
  return validateProcessVirtualArtifactV4(decodeCanonical(bytes, LIMITS), lineage);
}
/** Bounded host-side launch check. The worker protocol still accepts only
 * Artifact/3; this check does not grant candidate execution or launch custody. */
export function assertProcessVirtualArtifactV4Launch(value: unknown,
  lineage: CausalLineageLedger, launchedPath: string): ProcessVirtualArtifactV4 {
  const artifact = validateProcessVirtualArtifactV4(value, lineage);
  const bundle = artifact.executableSubject.manifest.bundle;
  if (realpathSync(launchedPath) !== bundle.path || !same(measureFile(launchedPath), bundle))
    throw new TypeError('Artifact/4 does not measure the selected worker entry');
  return artifact;
}
export function processVirtualArtifactDigestV4(artifact: ProcessVirtualArtifactV4): Digest {
  return domainDigest(FORMAT, artifact, LIMITS);
}
