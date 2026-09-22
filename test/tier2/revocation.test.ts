import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RevocationConsole, RevocationList } from '../../src/tier2/ocap.ts';
import { CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';

const directories: string[] = [];
after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

test('F3: the operator console persists revocation state and its audit trail', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-revocations-'));
  directories.push(directory);
  const console = new RevocationConsole(new RevocationList({ directory, clock: () => 42 }));
  console.revoke(CAP_LEDGER_APPEND, 'sre@example.com', 'ledger');
  assert.equal(console.status(CAP_LEDGER_APPEND, 'ledger'), true);
  const reopened = new RevocationConsole(new RevocationList({ directory, clock: () => 43 }));
  assert.equal(reopened.status(CAP_LEDGER_APPEND, 'ledger'), true);
  reopened.restore(CAP_LEDGER_APPEND, 'ledger');
  const final = new RevocationConsole(new RevocationList({ directory }));
  assert.equal(final.status(CAP_LEDGER_APPEND, 'ledger'), false);
  assert.deepEqual(final.history().map((entry) => entry.action), ['revoke', 'restore']);
});
