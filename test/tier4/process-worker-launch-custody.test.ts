import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareProcessWorkerLaunchV1,
  PROCESS_WORKER_LAUNCH_CUSTODY_V1 } from '../../src/tier4/process-worker-launch-custody.ts';

test('Artifact/4 launch custody executes measured pipe JS across a real pathname swap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-worker-path-swap-'));
  const entry = join(directory, 'worker.mjs'), attacker = join(directory, 'attacker.mjs');
  const sentinel = join(directory, 'attacker-ran');
  try {
    const original = Buffer.from('process.stdout.write(`trusted:${process.argv[3]}`);');
    writeFileSync(entry, original);
    writeFileSync(attacker, 'import { writeFileSync } from "node:fs"; '
      + `writeFileSync(${JSON.stringify(sentinel)}, "executed"); process.stdout.write("attacker");`);
    const measured = { path: entry, bytes: original.length,
      sha256: createHash('sha256').update(original).digest('hex') };
    const custody = prepareProcessWorkerLaunchV1(measured);

    // The adversary acts in the exact interval after trusted byte custody and
    // before spawn. A normal path-based launch would run its replacement.
    const attack = spawnSync(process.execPath, ['-e',
      'require("node:fs").renameSync(process.argv[1], process.argv[2])',
      attacker, entry], { encoding: 'utf8' });
    assert.equal(attack.status, 0, attack.stderr);
    assert.equal(readFileSync(entry, 'utf8').includes('attacker'), true);
    const vulnerable = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
    assert.equal(vulnerable.status, 0, vulnerable.stderr);
    assert.equal(vulnerable.stdout, 'attacker');
    assert.equal(readFileSync(sentinel, 'utf8'), 'executed');
    rmSync(sentinel);

    const child = custody.spawn({ env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('custodied launch timed out')); }, 5000);
      child.stdout!.on('data', bytes => { stdout += bytes.toString(); });
      child.stderr!.on('data', bytes => { stderr += bytes.toString(); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    });
    assert.deepEqual(output, { code: 0,
      stdout: `trusted:${PROCESS_WORKER_LAUNCH_CUSTODY_V1}`, stderr: '' });
    assert.equal(readFileSync(entry, 'utf8').includes('attacker'), true);
    assert.throws(() => custody.spawn({}), /one-shot/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Artifact/4 launch custody rejects bytes changed before acquisition', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-worker-path-precheck-'));
  try {
    const entry = join(directory, 'worker.mjs');
    const original = Buffer.from('process.stdout.write("trusted")');
    writeFileSync(entry, original);
    const measured = { path: entry, bytes: original.length,
      sha256: createHash('sha256').update(original).digest('hex') };
    writeFileSync(entry, Buffer.from('process.stdout.write("untrust")'));
    assert.throws(() => prepareProcessWorkerLaunchV1(measured),
      /changed before launch custody|changed during launch custody/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
