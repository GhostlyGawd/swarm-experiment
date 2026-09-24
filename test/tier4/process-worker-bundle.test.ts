import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { build as esbuild } from 'esbuild';
import { domainDigest } from '../../src/fabric/identity.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { ProcessAuthenticator } from '../../src/tier4/process-values.ts';
import { assertClosedImportGraph, assertNoDynamicImports,
  verifyWorkerBundle, writeWorkerBundle } from '../../scripts/process-worker-bundle.ts';

function frame(bytes: Uint8Array): Buffer {
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

function responseFrame(stream: NodeJS.ReadableStream, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('worker protocol response timed out')), timeoutMs);
    const onData = (bytes: Buffer) => {
      pending = Buffer.concat([pending, bytes]);
      if (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0))
        finish(null, pending.subarray(4, 4 + pending.readUInt32BE(0)));
    };
    const onEnd = () => finish(new Error('worker exited before protocol response'));
    function finish(error: Error | null, value?: Buffer) {
      clearTimeout(timer); stream.off('data', onData); stream.off('end', onEnd);
      if (error) reject(error); else resolve(value!);
    }
    stream.on('data', onData); stream.on('end', onEnd);
  });
}

async function exitCode(child: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker did not exit')); }, timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

test('worker bundle is rebuilt from a closed input graph and refuses stale or tampered bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aether-worker-bundle-'));
  const bundle = join(dir, 'worker.mjs'), manifestPath = join(dir, 'worker.json');
  try {
    const built = await writeWorkerBundle(bundle, manifestPath);
    assert.equal(built.format, 'aether.process-worker-bundle/2');
    assert.ok(built.inputs.length > 20);
    assert.equal(built.bundle.bytes, readFileSync(bundle).length);
    assert.ok(built.externalNodeImports.every(name => name.startsWith('node:')));
    assert.deepEqual(await verifyWorkerBundle(bundle, manifestPath), built);
    const originalBundle = readFileSync(bundle);
    writeFileSync(bundle, Buffer.concat([originalBundle, Buffer.from('\n// changed\n')]));
    await assert.rejects(verifyWorkerBundle(bundle, manifestPath), /stale|changed/);
    writeFileSync(bundle, originalBundle);
    const originalManifest = readFileSync(manifestPath);
    const changed = JSON.parse(originalManifest.toString());
    changed.inputs[0].sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(changed));
    await assert.rejects(verifyWorkerBundle(bundle, manifestPath), /input closure changed/);
    changed.inputs = changed.inputs.slice(1);
    writeFileSync(manifestPath, JSON.stringify(changed));
    await assert.rejects(verifyWorkerBundle(bundle, manifestPath), /input closure changed/);
    const changedTool = JSON.parse(originalManifest.toString());
    changedTool.tool.binary.sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(changedTool));
    await assert.rejects(verifyWorkerBundle(bundle, manifestPath), /input closure changed/);
    const changedNode = JSON.parse(originalManifest.toString());
    changedNode.node.sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(changedNode));
    await assert.rejects(verifyWorkerBundle(bundle, manifestPath), /input closure changed/);
    writeFileSync(manifestPath, originalManifest);
    assert.deepEqual(await verifyWorkerBundle(bundle, manifestPath), built);
    const oldOverride = process.env.ESBUILD_BINARY_PATH;
    process.env.ESBUILD_BINARY_PATH = join(dir, 'unapproved-esbuild');
    try {
      await assert.rejects(verifyWorkerBundle(bundle, manifestPath), /ESBUILD_BINARY_PATH/);
    } finally {
      if (oldOverride === undefined) delete process.env.ESBUILD_BINARY_PATH;
      else process.env.ESBUILD_BINARY_PATH = oldOverride;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('worker graph rejects missing and tree-shaken dynamic imports before measurement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aether-worker-graph-'));
  try {
    writeFileSync(join(dir, 'entry.ts'), 'export const entry = 1;\n');
    assert.throws(() => assertNoDynamicImports('entry.ts',
      'export async function run() { return await import("./late.ts"); }'), /dynamic import/);
    assert.throws(() => assertNoDynamicImports('entry.ts',
      'export function run() { return require("./late.js"); }'), /dynamic import/);
    const meta = { inputs: { 'entry.ts': { bytes: 1,
      imports: [{ path: 'missing.ts', kind: 'import-statement' }] } }, outputs: {} } as never;
    assert.throws(() => assertClosedImportGraph(meta, dir), /missing executable import/);
    const dynamic = { inputs: { 'entry.ts': { bytes: 1,
      imports: [{ path: './late.ts', kind: 'dynamic-import', external: true }] } }, outputs: {} } as never;
    assert.throws(() => assertClosedImportGraph(dynamic, dir), /dynamic import edge/);
    writeFileSync(join(dir, 'late.ts'), 'export const late = 2;\n');
    writeFileSync(join(dir, 'dep.ts'),
      'export const kept = 1; export async function unused() { return import("./late.ts"); }\n');
    writeFileSync(join(dir, 'entry.ts'), 'import { kept } from "./dep.ts"; console.log(kept);\n');
    const pruned = await esbuild({ absWorkingDir: dir, entryPoints: ['entry.ts'],
      outfile: join(dir, 'out.mjs'), bundle: true, platform: 'node', format: 'esm',
      treeShaking: true, metafile: true, write: false });
    assert.ok(!pruned.outputFiles[0].text.includes('import("./late.ts")'));
    assert.throws(() => assertClosedImportGraph(pruned.metafile, dir), /dynamic import\/require/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('actual bundled worker launches and returns an authenticated pre-init refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aether-worker-launch-'));
  const bundle = join(dir, 'worker.mjs'), manifestPath = join(dir, 'worker.json');
  try {
    await writeWorkerBundle(bundle, manifestPath);
    await verifyWorkerBundle(bundle, manifestPath);
    const key = Buffer.alloc(32, 7);
    const session = { sessionId: 'bundle-probe',
      executionManifest: domainDigest('aether.execution/1', 'bundle-probe'),
      ownershipEpoch: '1', maxFrameBytes: 65536 };
    const parent = new ProcessAuthenticator(key, session, 'parent');
    const child = spawn(process.execPath, [bundle],
      { cwd: dir, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    try {
      const bootstrap = encodeCanonical({ key: key.toString('base64'), session });
      (child.stdio[3] as Writable).write(frame(bootstrap));
      const reply = responseFrame(child.stdout!);
      child.stdin!.write(parent.encode({ kind: 'request', id: 'probe',
        method: 'snapshot', payload: null }));
      const body = parent.decode(await reply) as { kind: string; id: string; ok: boolean; value: string };
      assert.deepEqual({ ...body }, { kind: 'response', id: 'probe', ok: false,
        value: 'worker is not initialized' });
      child.stdin!.end();
      assert.equal(await exitCode(child), 1);
      assert.equal((await verifyWorkerBundle(bundle, manifestPath)).bundle.bytes,
        readFileSync(bundle).length);
    } finally { child.kill(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
