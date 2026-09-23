/** Replay a retained native locality report with its exact registered source.
 * A later ABI change must not make an older result unverifiable or silently
 * replace the binary used for its measurements. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportPath = resolve(process.argv[2] ?? join(root, 'roadmap/v4/research/packed-native-locality/results/local-01/report.json'));
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (report.format !== 'aether.packed-native-locality/1' || !/^[0-9a-f]{40}$/.test(report.source?.gitHead))
  throw new TypeError('invalid historical native locality source pin');
const folder = mkdtempSync(join(tmpdir(), 'aether-packed-locality-history-')), checkout = join(folder, 'source');
try {
  execFileSync('git', ['worktree', 'add', '--detach', checkout, report.source.gitHead], {cwd: root, stdio: 'ignore'});
  symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  const output = execFileSync(process.execPath, ['--experimental-strip-types',
    join(checkout, 'roadmap/v4/research/packed-native-locality/verify.ts'), reportPath],
    {cwd: checkout, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024});
  process.stdout.write(output);
} finally {
  try { execFileSync('git', ['worktree', 'remove', '--force', checkout], {cwd: root, stdio: 'ignore'}); }
  finally { rmSync(folder, {recursive: true, force: true}); }
}
