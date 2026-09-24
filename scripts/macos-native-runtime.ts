/** Bounded, static Mach-O link closure for the Node executable on macOS.
 * This does not claim dyld shared-cache bytes or runtime dlopen coverage. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { release } from 'node:os';

export interface NativeFile { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface NativeLink {
  readonly loader: string;
  readonly installName: string;
  readonly resolved: string;
  readonly classification: 'non-system' | 'system-cache';
}
export interface MacosNativeRuntimeV1 {
  readonly format: 'aether.macos-node-static-link-closure/1';
  readonly scope: 'mach-o-static-links-only';
  readonly architecture: string;
  readonly macos: { readonly productVersion: string; readonly buildVersion: string;
    readonly darwinKernel: string };
  readonly dyldCache: { readonly coverage: 'header-and-map-identity-only';
    readonly header: NativeFile; readonly map: NativeFile };
  readonly probeTool: NativeFile;
  readonly executable: NativeFile;
  readonly libraries: readonly NativeFile[];
  readonly systemInstallNames: readonly string[];
  readonly links: readonly NativeLink[];
}

const OTOOL = '/usr/bin/otool';
const SW_VERS = '/usr/bin/sw_vers';
const CACHE_DIR = '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld';
const MAX_LIBRARIES = 256, MAX_LINKS = 2048, MAX_CONTEXTS = 512;
const SHA = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function measureNativeFile(path: string): NativeFile {
  const canonical = realpathSync(path), before = statSync(canonical);
  if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024)
    throw new TypeError(`invalid native file: ${path}`);
  const bytes = readFileSync(canonical), after = statSync(canonical);
  if (bytes.length !== before.size || bytes.length !== after.size
    || before.dev !== after.dev || before.ino !== after.ino
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new Error(`native file changed during measurement: ${path}`);
  return { path: canonical, bytes: bytes.length, sha256: SHA(bytes) };
}
function run(path: string, args: string[]): string {
  const result = spawnSync(path, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string')
    throw new Error(`${path} failed: ${args.join(' ')}: ${String(result.error ?? result.stderr).slice(0, 500)}`);
  return result.stdout;
}
function arch(): string {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x86_64';
  throw new TypeError(`unsupported macOS executable architecture: ${process.arch}`);
}
function isSystem(path: string): boolean {
  return path.startsWith('/usr/lib/') || path.startsWith('/System/Library/');
}
function expandToken(path: string, owner: string, executable: string): string {
  if (path === '@loader_path' || path.startsWith('@loader_path/'))
    return resolve(dirname(owner), path.slice('@loader_path'.length).replace(/^\//, ''));
  if (path === '@executable_path' || path.startsWith('@executable_path/'))
    return resolve(dirname(executable), path.slice('@executable_path'.length).replace(/^\//, ''));
  if (isAbsolute(path)) return path;
  throw new TypeError(`unsupported Mach-O load path: ${path}`);
}

/** `runpaths` are expanded absolute directories from the loader ancestry. If
 * two different files match one @rpath name, refuse to guess dyld precedence. */
export function resolveNativeInstallName(name: string, loader: string,
  executable: string, runpaths: readonly string[]): string {
  if (isSystem(name)) return name;
  if (name.startsWith('@rpath/')) {
    const tail = name.slice('@rpath/'.length);
    const matches = runpaths.map(path => resolve(path, tail))
      .filter(path => isSystem(path) || existsSync(path))
      .map(path => isSystem(path) ? path : realpathSync(path));
    const distinct = [...new Set(matches)];
    if (distinct.length !== 1)
      throw new TypeError(`unresolved or ambiguous @rpath dependency: ${name} (${distinct.length} matches)`);
    return distinct[0];
  }
  const path = expandToken(name, loader, executable);
  if (isSystem(path)) return path;
  return realpathSync(path);
}

function dependencies(path: string): string[] {
  const lines = run(OTOOL, ['-arch', arch(), '-L', path]).split('\n').slice(1);
  const names = lines.filter(line => line.trim()).map(line => {
    const match = /^\s+(.+?) \(compatibility version [^)]+\)$/.exec(line);
    if (!match) throw new TypeError(`unparsed otool dependency for ${path}: ${line}`);
    return match[1];
  });
  return names;
}
function rpaths(path: string, executable: string): string[] {
  const lines = run(OTOOL, ['-arch', arch(), '-l', path]).split('\n');
  const entries: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*cmd LC_RPATH\s*$/.test(lines[i])) continue;
    const line = lines.slice(i + 1, i + 5).find(value => /^\s*path .+ \(offset \d+\)\s*$/.test(value));
    if (!line) throw new TypeError(`unparsed LC_RPATH in ${path}`);
    const match = /^\s*path (.+) \(offset \d+\)\s*$/.exec(line)!;
    entries.push(expandToken(match[1], path, executable));
  }
  return entries;
}

export function measureMacosNativeRuntime(executable = process.execPath): MacosNativeRuntimeV1 {
  if (process.platform !== 'darwin') throw new TypeError('macOS native runtime profile requires Darwin');
  if (Object.keys(process.env).some(name => name.startsWith('DYLD_')))
    throw new TypeError('DYLD environment overrides are forbidden for measured runtime');
  const probeBefore = measureNativeFile(OTOOL);
  const root = realpathSync(executable), files = new Map<string, NativeFile>();
  const links = new Map<string, NativeLink>(), system = new Set<string>();
  const contexts = new Set<string>(), rpathCache = new Map<string, string[]>();
  const getRpaths = (path: string) => {
    let value = rpathCache.get(path);
    if (!value) { value = rpaths(path, root); rpathCache.set(path, value); }
    return value;
  };
  const visit = (path: string, ancestry: readonly string[]): void => {
    const canonical = realpathSync(path);
    const owners = [canonical, ...ancestry];
    const search = owners.flatMap(getRpaths);
    const context = `${canonical}\n${search.join('\n')}`;
    if (contexts.has(context)) return;
    contexts.add(context);
    if (contexts.size > MAX_CONTEXTS) throw new RangeError('native loader context bound exceeded');
    if (!files.has(canonical)) {
      files.set(canonical, measureNativeFile(canonical));
      if (files.size > MAX_LIBRARIES) throw new RangeError('native library bound exceeded');
    }
    for (const installName of dependencies(canonical)) {
      const resolved = resolveNativeInstallName(installName, canonical, root, search);
      if (resolved === canonical) continue; // dylib LC_ID_DYLIB is not a dependency
      const classification = isSystem(resolved) ? 'system-cache' : 'non-system';
      const link: NativeLink = { loader: canonical, installName, resolved, classification };
      const key = `${canonical}\n${installName}`;
      const old = links.get(key);
      if (old && (old.resolved !== resolved || old.classification !== classification))
        throw new TypeError(`context-dependent native dependency: ${installName}`);
      links.set(key, link);
      if (links.size > MAX_LINKS) throw new RangeError('native link bound exceeded');
      if (classification === 'system-cache') system.add(resolved);
      else visit(resolved, owners);
    }
  };
  visit(root, []);
  for (const [path, before] of files) {
    const after = measureNativeFile(path);
    if (after.bytes !== before.bytes || after.sha256 !== before.sha256)
      throw new Error(`native library changed during closure measurement: ${path}`);
  }
  const probeAfter = measureNativeFile(OTOOL);
  if (probeBefore.bytes !== probeAfter.bytes || probeBefore.sha256 !== probeAfter.sha256)
    throw new Error('otool changed during native closure measurement');
  const cacheArch = process.arch === 'arm64' ? 'arm64e' : 'x86_64';
  const header = measureNativeFile(join(CACHE_DIR, `dyld_shared_cache_${cacheArch}`));
  const mapPath = join(CACHE_DIR, `dyld_shared_cache_${cacheArch}.map`);
  const cacheMap = measureNativeFile(mapPath);
  const mappedNames = new Set(readFileSync(mapPath, 'utf8').split('\n').map(line => line.trim()));
  for (const name of system) {
    if (!mappedNames.has(name)) throw new TypeError(`system install name absent from dyld cache map: ${name}`);
  }
  const libraries = [...files.values()].filter(file => file.path !== root)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { format: 'aether.macos-node-static-link-closure/1',
    scope: 'mach-o-static-links-only', architecture: arch(),
    macos: { productVersion: run(SW_VERS, ['-productVersion']).trim(),
      buildVersion: run(SW_VERS, ['-buildVersion']).trim(), darwinKernel: release() },
    dyldCache: { coverage: 'header-and-map-identity-only', header, map: cacheMap },
    probeTool: probeAfter, executable: files.get(root)!, libraries,
    systemInstallNames: [...system].sort(),
    links: [...links.values()].sort((a, b) =>
      a.loader.localeCompare(b.loader) || a.installName.localeCompare(b.installName)) };
}
