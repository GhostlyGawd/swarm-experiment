/** Fresh-process byte/count check for the bounded M01 research result. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./virtual-prototype.ts', import.meta.url));
const retained = readFileSync(fileURLToPath(new URL('./prototype-results.json', import.meta.url)));
const current = execFileSync(process.execPath, ['--experimental-strip-types', source]);
assert.deepEqual(current, retained, 'virtual-frame raw result differs on fresh process');
const result = JSON.parse(current.toString());
assert.equal(result.format, 'aether.gc-virtual-forwarder-prototype/1');
assert.equal(result.wrapperArchived, true);
assert.equal(result.compared, 192);
assert.equal(result.equal, 192);
assert.equal(result.fullFailureCount, 0);
assert.match(result.descriptorDigest, /^aether\.gc-virtual-forward-script\/1:b3:[0-9a-f]{64}$/);
process.stdout.write(JSON.stringify({ verified: true,
  sourceRoot: result.sourceRoot, candidateRoot: result.candidateRoot,
  descriptorDigest: result.descriptorDigest,
  exactCases: result.equal, failures: result.fullFailureCount }) + '\n');
