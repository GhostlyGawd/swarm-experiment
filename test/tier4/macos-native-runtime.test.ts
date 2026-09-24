import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureNativeFile, resolveNativeInstallName } from '../../scripts/macos-native-runtime.ts';
import { verifyWorkerBundle, writeWorkerBundle } from '../../scripts/process-worker-bundle.ts';

test('Mach-O load-path resolution rejects missing and ambiguous native dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aether-native-rpath-'));
  try {
    const bin = join(dir, 'bin'), lib = join(dir, 'lib'), other = join(dir, 'other');
    mkdirSync(bin); mkdirSync(lib); mkdirSync(other);
    const executable = join(bin, 'node');
    writeFileSync(executable, 'test');
    const library = join(lib, 'libprobe.dylib');
    writeFileSync(library, 'first');
    assert.equal(resolveNativeInstallName('@rpath/libprobe.dylib', executable,
      executable, [lib]), realpathSync(library));
    assert.equal(resolveNativeInstallName('@loader_path/../lib/libprobe.dylib',
      executable, executable, []), realpathSync(library));
    assert.equal(resolveNativeInstallName('@executable_path/../lib/libprobe.dylib',
      executable, executable, []), realpathSync(library));
    assert.throws(() => resolveNativeInstallName('@rpath/missing.dylib', executable,
      executable, [lib]), /unresolved/);
    writeFileSync(join(other, 'libprobe.dylib'), 'second');
    assert.throws(() => resolveNativeInstallName('@rpath/libprobe.dylib', executable,
      executable, [lib, other]), /ambiguous/);
    const before = measureNativeFile(library);
    writeFileSync(library, 'changed');
    assert.notEqual(measureNativeFile(library).sha256, before.sha256);
    rmSync(library);
    assert.throws(() => resolveNativeInstallName('@loader_path/../lib/libprobe.dylib',
      executable, executable, []), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('worker manifest pins transitive non-system libraries and macOS cache identity',
  { skip: process.platform !== 'darwin' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-native-worker-'));
    const bundle = join(dir, 'worker.mjs'), manifestPath = join(dir, 'worker.json');
    try {
      const built = await writeWorkerBundle(bundle, manifestPath);
      const native = built.nativeRuntime;
      if (native.format !== 'aether.macos-node-static-link-closure/1')
        throw new Error('Darwin build lacks native link closure');
      assert.equal(native.scope, 'mach-o-static-links-only');
      assert.ok(native.libraries.length >= 20);
      assert.ok(native.libraries.some(file => file.path.endsWith('/libnode.147.dylib')));
      assert.ok(native.links.some(link => link.installName === '@rpath/libnode.147.dylib'
        && link.classification === 'non-system'));
      assert.ok(native.links.some(link => link.installName.includes('libcrypto.3.dylib')
        && link.loader.includes('libssl.3.dylib')));
      assert.ok(native.systemInstallNames.includes('/usr/lib/libSystem.B.dylib'));
      assert.equal(native.dyldCache.coverage, 'header-and-map-identity-only');
      assert.match(native.macos.buildVersion, /^[0-9]+[A-Z][0-9]+$/);
      assert.deepEqual(await verifyWorkerBundle(bundle, manifestPath), built);
      const original = readFileSync(manifestPath);
      const tamper = async (change: (manifest: any) => void) => {
        const modified = JSON.parse(original.toString());
        change(modified);
        writeFileSync(manifestPath, JSON.stringify(modified));
        await assert.rejects(verifyWorkerBundle(bundle, manifestPath), /input closure changed/);
      };
      await tamper(manifest => { manifest.nativeRuntime.libraries[0].sha256 = '0'.repeat(64); });
      await tamper(manifest => { manifest.nativeRuntime.libraries.splice(0, 1); });
      await tamper(manifest => { manifest.nativeRuntime.dyldCache.header.sha256 = '0'.repeat(64); });
      await tamper(manifest => { manifest.nativeRuntime.dyldCache.map.sha256 = '0'.repeat(64); });
      await tamper(manifest => { manifest.nativeRuntime.macos.buildVersion = '0A0'; });
      writeFileSync(manifestPath, original);
      const old = process.env.DYLD_LIBRARY_PATH;
      process.env.DYLD_LIBRARY_PATH = dir;
      try {
        await assert.rejects(verifyWorkerBundle(bundle, manifestPath), /DYLD environment overrides/);
      } finally {
        if (old === undefined) delete process.env.DYLD_LIBRARY_PATH;
        else process.env.DYLD_LIBRARY_PATH = old;
      }
      assert.deepEqual(await verifyWorkerBundle(bundle, manifestPath), built);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
