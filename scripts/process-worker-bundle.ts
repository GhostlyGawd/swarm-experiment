/** Rebuildable measurement of the actual, closed process-worker executable. */
import assert from 'node:assert/strict';
import { builtinModules, createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion, type Metafile } from 'esbuild';
import ts from 'typescript';

const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = join(ROOT, 'src/tier4/process-worker.ts');
const DEFAULT_BUNDLE = join(ROOT, 'dist/process-worker.bundle.mjs');
const DEFAULT_MANIFEST = join(ROOT, 'dist/process-worker.bundle.manifest.json');
const FORMAT = 'aether.process-worker-bundle/1';
const NODE_BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const require = createRequire(import.meta.url);
type FileMeasurement = { path: string; bytes: number; sha256: string };

function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function measure(path: string): FileMeasurement {
  const canonical = realpathSync(path), before = statSync(canonical), bytes = readFileSync(canonical);
  const after = statSync(canonical);
  if (!before.isFile() || bytes.length !== before.size || bytes.length !== after.size
    || before.dev !== after.dev || before.ino !== after.ino
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new TypeError(`executable input changed during measurement: ${path}`);
  return { path: canonical, bytes: bytes.length, sha256: sha(bytes) };
}
function withinRoot(path: string): string {
  const rel = relative(ROOT, realpathSync(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new TypeError(`executable input escaped project root: ${path}`);
  return rel;
}

/** Source-level check catches literal and computed imports, require, and
 * runtime module loading before a bundler can quietly leave one external. */
export function assertNoDynamicImports(path: string, source: string): void {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if (target.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(target) && target.text === 'require')
        || (ts.isPropertyAccessExpression(target)
          && ts.isIdentifier(target.expression) && target.expression.text === 'module'
          && target.name.text === 'require'))
        throw new TypeError(`dynamic import/require in ${path}:${parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}

/** Esbuild's resolved runtime graph is cross-checked here. Only Node builtins
 * may remain external; every other resolved edge must point to an input. */
export function assertClosedImportGraph(meta: Metafile, root = ROOT): string[] {
  const inputs = new Set(Object.keys(meta.inputs));
  if (!inputs.size) throw new TypeError('empty worker import graph');
  const external = new Set<string>();
  for (const [path, input] of Object.entries(meta.inputs)) {
    const canonical = realpathSync(resolve(root, path));
    if (root === ROOT) withinRoot(canonical);
    assertNoDynamicImports(canonical, readFileSync(canonical, 'utf8'));
    for (const edge of input.imports) {
      if (edge.kind !== 'import-statement' && edge.kind !== 'require-call')
        throw new TypeError(`dynamic import edge ${edge.kind}: ${path} -> ${edge.path}`);
      if (edge.external) {
        const name = edge.path.replace(/^node:/, '');
        if (NODE_BUILTINS.has(name)) external.add(`node:${name}`);
        else if (edge.path.startsWith('.')) {
          // Esbuild reports static edges removed by tree shaking as external in
          // the input graph. The final output graph below must still be closed.
          const pruned = realpathSync(resolve(dirname(canonical), edge.path));
          if (root === ROOT) withinRoot(pruned);
        } else throw new TypeError(`nonbuiltin external import: ${edge.path}`);
      } else if (!inputs.has(edge.path)) {
        throw new TypeError(`missing executable import: ${path} -> ${edge.path}`);
      }
    }
  }
  for (const output of Object.values(meta.outputs)) {
    for (const edge of output.imports) {
      if (!edge.external || !NODE_BUILTINS.has(edge.path.replace(/^node:/, '')))
        throw new TypeError(`unclosed bundle output import: ${edge.path}`);
    }
  }
  return [...external].sort();
}

function toolIdentity() {
  if (process.env.ESBUILD_BINARY_PATH)
    throw new TypeError('ESBUILD_BINARY_PATH override is forbidden for measured worker builds');
  const esbuildPackage = join(ROOT, 'node_modules/esbuild/package.json');
  const pkg = JSON.parse(readFileSync(esbuildPackage, 'utf8')) as { version: string };
  const nativePackageName = `@esbuild/${process.platform}-${process.arch}`;
  const nativePackagePath = require.resolve(`${nativePackageName}/package.json`);
  const nativeBinaryPath = require.resolve(`${nativePackageName}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`);
  const nativePkg = JSON.parse(readFileSync(nativePackagePath, 'utf8')) as { version: string };
  const project = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string> };
  if (pkg.version !== esbuildVersion || pkg.version !== '0.28.2'
    || nativePkg.version !== esbuildVersion || ts.version !== '5.8.3'
    || project.devDependencies?.esbuild !== '0.28.2'
    || project.devDependencies?.typescript !== '5.8.3')
    throw new TypeError('unpinned or changed esbuild version');
  return { version: esbuildVersion, nativePackage: nativePackageName,
    projectPackage: measure(join(ROOT, 'package.json')),
    package: measure(esbuildPackage),
    api: measure(join(ROOT, 'node_modules/esbuild/lib/main.js')),
    binary: measure(join(ROOT, 'node_modules/esbuild/bin/esbuild')),
    selectedNativePackage: measure(nativePackagePath),
    selectedNativeBinary: measure(nativeBinaryPath),
    scanner: { version: ts.version,
      api: measure(join(ROOT, 'node_modules/typescript/lib/typescript.js')) },
    recipe: measure(join(ROOT, 'scripts/process-worker-bundle.ts')),
    lockfile: measure(join(ROOT, 'package-lock.json')) };
}

export async function compileWorker(): Promise<{ bytes: Uint8Array; meta: Metafile; external: string[] }> {
  if (process.env.ESBUILD_BINARY_PATH)
    throw new TypeError('ESBUILD_BINARY_PATH override is forbidden for measured worker builds');
  const output = await build({ absWorkingDir: ROOT, entryPoints: [ENTRY],
    outfile: DEFAULT_BUNDLE, bundle: true, platform: 'node', format: 'esm',
    target: 'node22', packages: 'bundle', treeShaking: true,
    sourcemap: false, legalComments: 'none', metafile: true,
    write: false, logLevel: 'silent' });
  if (output.outputFiles.length !== 1 || Object.keys(output.metafile.outputs).length !== 1)
    throw new TypeError('worker build must emit exactly one executable file');
  if (Object.keys(output.metafile.inputs).some(path => path.endsWith('.node')))
    throw new TypeError('native addon cannot be embedded in worker bundle');
  const external = assertClosedImportGraph(output.metafile);
  // An input may contain an unused dynamic import that tree shaking removed.
  // The executable itself must have no dynamic import/require expression.
  assertNoDynamicImports('process-worker.bundle.mjs', output.outputFiles[0].text);
  return { bytes: output.outputFiles[0].contents, meta: output.metafile, external };
}

export async function expectedManifest(bundlePath = DEFAULT_BUNDLE) {
  const compiled = await compileWorker();
  const inputs = Object.keys(compiled.meta.inputs).map(path => measure(resolve(ROOT, path)))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!inputs.some(input => input.path === realpathSync(ENTRY)))
    throw new TypeError('worker entry is absent from executable input graph');
  const repeated = await compileWorker();
  const repeatedInputs = Object.keys(repeated.meta.inputs).map(path => measure(resolve(ROOT, path)))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepStrictEqual(repeatedInputs, inputs, 'worker inputs changed during build');
  assert.deepStrictEqual(repeated.meta, compiled.meta, 'worker import graph changed during build');
  assert.equal(sha(repeated.bytes), sha(compiled.bytes), 'worker bundle is nondeterministic or changed during build');
  return { compiled, manifest: { format: FORMAT, entry: realpathSync(ENTRY),
    node: measure(process.execPath), tool: toolIdentity(),
    bundle: { path: join(realpathSync(dirname(bundlePath)), basename(bundlePath)),
      bytes: compiled.bytes.length, sha256: sha(compiled.bytes) },
    inputs, externalNodeImports: compiled.external } };
}

export async function writeWorkerBundle(bundlePath = DEFAULT_BUNDLE,
  manifestPath = DEFAULT_MANIFEST) {
  mkdirSync(dirname(bundlePath), { recursive: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  const { compiled, manifest } = await expectedManifest(bundlePath);
  writeFileSync(bundlePath, compiled.bytes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyWorkerBundle(bundlePath = DEFAULT_BUNDLE,
  manifestPath = DEFAULT_MANIFEST) {
  const { manifest } = await expectedManifest(bundlePath);
  const saved = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepStrictEqual(saved, manifest, 'bundle manifest or input closure changed');
  assert.deepStrictEqual(measure(bundlePath), manifest.bundle, 'bundle bytes are stale or changed');
  return manifest;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  const command = process.argv[2], bundle = process.argv[3] ?? DEFAULT_BUNDLE;
  const manifest = process.argv[4] ?? DEFAULT_MANIFEST;
  if (!['build', 'verify'].includes(command)) throw new TypeError('use build or verify');
  const result = command === 'build'
    ? await writeWorkerBundle(bundle, manifest)
    : await verifyWorkerBundle(bundle, manifest);
  process.stdout.write(`${JSON.stringify({ format: result.format,
    bundle: result.bundle, node: result.node,
    inputCount: result.inputs.length, externalNodeImports: result.externalNodeImports,
    toolVersion: result.tool.version })}\n`);
}
