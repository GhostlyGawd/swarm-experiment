import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditExternalFault, shrinkExternalFault } from './fault-shrink.ts';

const roots: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'aether-external-shrink-test-')); roots.push(path); return path; };
after(() => roots.forEach(path => rmSync(path, { recursive: true, force: true })));

test('real signed external-sink unknown fault shrinks and replays after candidate restart', async () => {
  const base = temporary(), directory = join(base, 'campaign');
  const witness = await shrinkExternalFault(directory, 'shrink-test-seed', ['malformed-command'], 2);
  assert.deepEqual(witness.original.actions, ['malformed-command']);
  assert.deepEqual(witness.shrunk.actions, []);
  assert.equal(witness.attempts, 1); assert.equal(witness.reductions, 1);
  assert.equal(witness.original.candidateRoot, witness.shrunk.candidateRoot);
  auditExternalFault(directory, witness);
  const raw = join(directory, 'observations', '0', 'partition-preheal-effect.json');
  const before = readFileSync(raw, 'utf8');
  writeFileSync(raw, before.replace('indeterminate', 'committed'));
  assert.throws(() => auditExternalFault(directory, witness), /partition evidence|external broker|external fault/);
});
