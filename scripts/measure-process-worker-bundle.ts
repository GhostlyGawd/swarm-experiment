/** Local raw measurement of the rebuilt executable and its protocol launch. */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../src/fabric/encoding.ts';
import { domainDigest } from '../src/fabric/identity.ts';
import { ProcessAuthenticator } from '../src/tier4/process-values.ts';
import { writeWorkerBundle, verifyWorkerBundle } from './process-worker-bundle.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function framed(bytes: Uint8Array): Buffer {
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}
async function launch(bundle: string) {
  const key = Buffer.alloc(32, 7);
  const session = { sessionId: 'bundle-measurement',
    executionManifest: domainDigest('aether.execution/1', 'bundle-measurement'),
    ownershipEpoch: '1', maxFrameBytes: 65536 };
  const parent = new ProcessAuthenticator(key, session, 'parent');
  const started = performance.now();
  const child = spawn(process.execPath, [bundle],
    { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
  try {
    const bootstrap = encodeCanonical({ key: key.toString('base64'), session });
    child.stdio[3]!.write(framed(bootstrap));
    const response = new Promise<Buffer>((resolve, reject) => {
      let pending = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('worker response timeout')), 5000);
      child.stdout!.on('data', (bytes: Buffer) => {
        pending = Buffer.concat([pending, bytes]);
        if (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
          clearTimeout(timer);
          resolve(pending.subarray(4, pending.readUInt32BE(0) + 4));
        }
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('worker exited before authenticated response')));
    });
    child.stdin!.write(parent.encode({ kind: 'request', id: 'measurement',
      method: 'snapshot', payload: null }));
    const body = parent.decode(await response) as Record<string, unknown>;
    const responseMs = +(performance.now() - started).toFixed(3);
    if (body.kind !== 'response' || body.id !== 'measurement' || body.ok !== false
      || body.value !== 'worker is not initialized')
      throw new Error('unexpected worker protocol response');
    child.stdin!.end();
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('worker exit timeout')); }, 5000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    if (exitCode !== 1) throw new Error(`unexpected worker EOF exit: ${exitCode}`);
    return { authenticatedResponse: { kind: body.kind, id: body.id,
      ok: body.ok, value: body.value }, responseMs, exitCode };
  } finally { child.kill(); }
}

const durations: number[] = [];
let manifest: Awaited<ReturnType<typeof writeWorkerBundle>> | undefined;
for (let i = 0; i < 5; i++) {
  const start = performance.now();
  manifest = await writeWorkerBundle();
  durations.push(+(performance.now() - start).toFixed(3));
}
const verifyStart = performance.now();
await verifyWorkerBundle();
const verifyMs = +(performance.now() - verifyStart).toFixed(3);
const protocol = await launch(manifest!.bundle.path);
const local = (file: { path: string; bytes: number; sha256: string }) =>
  ({ ...file, path: relative(ROOT, file.path) });
const raw = { format: 'aether.process-worker-measurement/2',
  platform: process.platform, architecture: process.arch,
  nodeVersion: process.version, node: manifest!.node,
  tool: { version: manifest!.tool.version,
    nativePackage: manifest!.tool.nativePackage,
    projectPackage: local(manifest!.tool.projectPackage),
    package: local(manifest!.tool.package), api: local(manifest!.tool.api),
    binary: local(manifest!.tool.binary),
    selectedNativePackage: local(manifest!.tool.selectedNativePackage),
    selectedNativeBinary: local(manifest!.tool.selectedNativeBinary),
    scanner: { version: manifest!.tool.scanner.version,
      api: local(manifest!.tool.scanner.api) },
    recipe: local(manifest!.tool.recipe),
    nativeProbeRecipe: local(manifest!.tool.nativeProbeRecipe),
    lockfile: local(manifest!.tool.lockfile) },
  bundle: local(manifest!.bundle), inputCount: manifest!.inputs.length,
  inputs: manifest!.inputs.map(local),
  nativeRuntime: manifest!.nativeRuntime,
  externalNodeImports: manifest!.externalNodeImports,
  buildSamplesMs: durations, verifyMs, protocol };
const text = `${JSON.stringify(raw, null, 2)}\n`;
if (process.argv[2]) {
  mkdirSync(dirname(process.argv[2]), { recursive: true });
  writeFileSync(process.argv[2], text);
}
process.stdout.write(text);
