/** Host-side Artifact/4 verifier and producer. Keep this module out of the worker bundle. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode as encodeIR } from '../tier1/agent-ir.ts';
import { type Term } from '../tier1/ast.ts';
import { CausalLineageLedger } from '../tier1/causal-lineage.ts';
import { decodeCanonical, encodeCanonical, exactObject } from '../fabric/encoding.ts';
import { domainDigest, type Digest } from '../fabric/identity.ts';
import { type EvidenceContext, type LocalEvidenceV1 } from '../fabric/evidence.ts';
import { ARTIFACT4_LIMITS as LIMITS, artifact4Clone as clone, artifact4Same as same,
  artifact4SubjectDigest, validateProcessVirtualArtifactV4Core,
  type ProcessVirtualArtifactV4, type MeasuredFileV2, type MeasuredExecutableSubjectV2,
  type ProcessWorkerBundleManifestV2 } from './process-virtual-artifact-v4-core.ts';
export type { ProcessVirtualArtifactV4, MeasuredExecutableSubjectV2,
  ProcessWorkerBundleManifestV2, MeasuredFileV2 } from './process-virtual-artifact-v4-core.ts';

type Decl = Extract<Term, { kind: 'FunctionDecl' }>;
const FORMAT = 'aether.process-artifact/4' as const;
const SUBJECT_FORMAT = 'aether.measured-executable-subject/2' as const;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_FILES = 128;
export interface ProcessVirtualArtifactInputV4 {
  readonly sourceContext: EvidenceContext;
  readonly candidateContext: EvidenceContext;
  readonly sourceEvidence: LocalEvidenceV1;
  readonly candidateEvidence: LocalEvidenceV1;
  readonly bundleManifest: ProcessWorkerBundleManifestV2;
  readonly sourceIntent: Digest;
  readonly candidateIntent: Digest;
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
  return { format: SUBJECT_FORMAT, manifest, digest: artifact4SubjectDigest(manifest) };
}

function assertMeasuredBundleSubject(value: unknown): MeasuredExecutableSubjectV2 {
  const subject = exactObject(value, ['format', 'manifest', 'digest']);
  if (subject.format !== SUBJECT_FORMAT)
    throw new TypeError('invalid Artifact/4 measured executable subject');
  const measured = measureWorkerBundleSubjectV2(subject.manifest);
  if (!same(value, measured)) throw new TypeError('Artifact/4 measured executable subject changed');
  return measured;
}

/** Full host admission independently rebuilds the V2 bundle producer. */
export function validateProcessVirtualArtifactV4(value: unknown,
  lineage: CausalLineageLedger): ProcessVirtualArtifactV4 {
  return validateProcessVirtualArtifactV4Core(value, lineage, assertMeasuredBundleSubject);
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
/** Bounded host-side launch check. This check does not grant deployment or OS launch custody. */
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
