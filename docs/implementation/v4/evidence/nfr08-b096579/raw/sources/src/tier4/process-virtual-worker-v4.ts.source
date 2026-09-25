/** Packaged Artifact/4 worker check. It never runs a recipe from the artifact:
 * the parent must have independently rebuilt that recipe before launch. */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { exactObject } from '../fabric/encoding.ts';
import { CausalLineageLedger } from '../tier1/causal-lineage.ts';
import { artifact4Same, artifact4SubjectDigest,
  validateProcessVirtualArtifactV4Core,
  type MeasuredFileV2, type MeasuredExecutableSubjectV2,
  type ProcessVirtualArtifactV4, type ProcessWorkerBundleManifestV2 } from './process-virtual-artifact-v4-core.ts';

const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** Node reads the ESM from anonymous stdin and the parent sends the worker
 * protocol on FD5. The child binds its launch arguments to signed Artifact/4. */
export function assertProcessWorkerPipeCustodyV1(bundle: MeasuredFileV2): void {
  if (process.argv[1] !== '-'
    || process.argv[3] !== 'aether.process-worker-launch-custody/1'
    || process.argv[2] !== bundle.path || process.argv[4] !== bundle.sha256)
    throw new TypeError('Artifact/4 worker launch custody is missing');
}
function measure(path: string): MeasuredFileV2 {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Artifact/4 requires an absolute measured file');
  const canonical = realpathSync(path), before = statSync(canonical);
  if (!before.isFile() || before.size < 1 || before.size > MAX_FILE_BYTES)
    throw new TypeError('Artifact/4 measured file is invalid');
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(canonical, 'r');
  try {
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > MAX_FILE_BYTES) throw new RangeError('Artifact/4 measured file bound exceeded');
      hash.update(buffer.subarray(0, count));
    }
    const after = statSync(canonical);
    if (bytes !== before.size || bytes !== after.size || before.dev !== after.dev
      || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs)
      throw new TypeError('Artifact/4 measured file changed during worker admission');
    return { path: canonical, bytes, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}
function assertFile(value: unknown): MeasuredFileV2 {
  const file = exactObject(value, ['path', 'bytes', 'sha256']) as unknown as MeasuredFileV2;
  if (!artifact4Same(measure(file.path), file))
    throw new TypeError('Artifact/4 packaged worker measured file changed');
  return file;
}

export function assertPackagedWorkerSubjectV2(value: unknown,
  launchedPath: string): MeasuredExecutableSubjectV2 {
  if (Object.keys(process.env).some(name => name.startsWith('DYLD_')))
    throw new TypeError('Artifact/4 refuses DYLD environment overrides');
  const subject = exactObject(value, ['format', 'manifest', 'digest']);
  if (subject.format !== 'aether.measured-executable-subject/2')
    throw new TypeError('Artifact/4 worker subject version mismatch');
  const manifest = exactObject(subject.manifest, ['format', 'entry', 'node', 'tool',
    'nativeRuntime', 'bundle', 'inputs', 'externalNodeImports']) as unknown as ProcessWorkerBundleManifestV2;
  if (manifest.format !== 'aether.process-worker-bundle/2'
    || !Array.isArray(manifest.inputs) || !manifest.inputs.length || manifest.inputs.length > 128
    || !Array.isArray(manifest.externalNodeImports))
    throw new TypeError('Artifact/4 worker manifest version mismatch');
  if (manifest.bundle.path !== realpathSync(launchedPath)
    || manifest.node.path !== realpathSync(process.execPath))
    throw new TypeError('Artifact/4 does not measure the launched worker or Node');
  if (subject.digest !== artifact4SubjectDigest(manifest))
    throw new TypeError('Artifact/4 worker subject digest changed');
  const native = exactObject(manifest.nativeRuntime, ['format', 'scope', 'architecture',
    'macos', 'dyldCache', 'probeTool', 'executable', 'libraries', 'systemInstallNames', 'links']);
  if (native.format !== 'aether.macos-node-static-link-closure/1'
    || native.scope !== 'mach-o-static-links-only'
    || !Array.isArray(native.libraries) || !native.libraries.length
    || native.libraries.length > 256)
    throw new TypeError('Artifact/4 worker requires a measured static native closure');
  const cache = exactObject(native.dyldCache, ['coverage', 'header', 'map']);
  if (cache.coverage !== 'header-and-map-identity-only')
    throw new TypeError('Artifact/4 worker native scope mismatch');
  const tool = exactObject(manifest.tool, ['version', 'nativePackage', 'projectPackage',
    'package', 'api', 'binary', 'selectedNativePackage', 'selectedNativeBinary',
    'scanner', 'recipe', 'nativeProbeRecipe', 'lockfile']);
  const scanner = exactObject(tool.scanner, ['version', 'api']);
  // The child can rehash named files, but cannot independently reproduce the
  // input graph or dyld's runtime decisions without importing the producer.
  // The parent has already performed that independent rebuild.
  for (const file of [manifest.bundle, manifest.node, ...manifest.inputs,
    tool.projectPackage, tool.package, tool.api, tool.binary,
    tool.selectedNativePackage, tool.selectedNativeBinary, tool.recipe,
    tool.nativeProbeRecipe, tool.lockfile, scanner.api, native.probeTool,
    cache.header, cache.map, ...native.libraries]) assertFile(file);
  if (!artifact4Same(native.executable, manifest.node))
    throw new TypeError('Artifact/4 worker native executable differs from Node');
  return value as MeasuredExecutableSubjectV2;
}

export function validatePackagedProcessVirtualArtifactV4(value: unknown,
  lineage: CausalLineageLedger, launchedPath: string): ProcessVirtualArtifactV4 {
  return validateProcessVirtualArtifactV4Core(value, lineage,
    subject => assertPackagedWorkerSubjectV2(subject, launchedPath));
}
