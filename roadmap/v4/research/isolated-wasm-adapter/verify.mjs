import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = dirname(fileURLToPath(import.meta.url));
const root = resolve(home, '../../../..');
const folder = resolve(process.argv[2] ?? join(home, 'results/local-01'));
const registration = JSON.parse(readFileSync(join(folder, 'registration.json'), 'utf8'));
const result = JSON.parse(readFileSync(join(folder, 'results.json'), 'utf8'));
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function check(value, message) { if (!value) throw new Error(message); }
check(registration.format === 'aether.isolated-wasm-evidence/1' && /^[0-9a-f]{40}$/.test(registration.commit), 'registration');
check(result.format === 'aether.isolated-wasm-result/1' && result.releaseClaim === false, 'result format');
check(Object.keys(registration.files).length === 6, 'source list');
for (const [path, expected] of Object.entries(registration.files)) {
  check(!path.startsWith('/') && !path.includes('..'), 'source path');
  const bytes = execFileSync('git', ['show', `${registration.commit}:${path}`], { cwd: root, maxBuffer: 1024 * 1024 });
  check(digest(bytes) === expected, `source differs from pinned commit: ${path}`);
}
for (const [key, file] of [['tests', 'tests.log'], ['typecheck', 'typecheck.log'], ['build', 'build.log']]) {
  check(result.exitCodes[key] === 0, `${key} failed`);
  check(digest(readFileSync(join(folder, file))) === result.logs[file], `${file} digest`);
}
const tests = readFileSync(join(folder, 'tests.log'), 'utf8');
check(/ℹ tests 14\n/.test(tests) && /ℹ pass 14\n/.test(tests) && /ℹ fail 0\n/.test(tests)
  && /ℹ skipped 0\n/.test(tests) && result.targetedTests.passed === 14 && result.targetedTests.failed === 0,
  'targeted test totals');
check(/typecheck\n> tsc -p tsconfig.check.json/.test(readFileSync(join(folder, 'typecheck.log'), 'utf8')), 'typecheck log');
check(/build\n> tsc -p tsconfig.json/.test(readFileSync(join(folder, 'build.log'), 'utf8')), 'build log');
console.log(JSON.stringify({ verified: true, commit: registration.commit, sourceFiles: 6, targetedTests: 14, releaseEligible: false }));
