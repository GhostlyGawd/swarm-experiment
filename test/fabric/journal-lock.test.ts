import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalLock } from '../../src/fabric/journal-lock.ts';

test('F07 async journal ownership survives awaits and does not block response delivery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-async-lock-'));
  try {
    const lock = new JournalLock({ directory });
    const events: string[] = [];
    let release!: () => void;
    const signal = new Promise<void>(resolve => { release = resolve; });
    const first = lock.runAsync(async () => { events.push('first-start'); await signal; events.push('first-end'); });
    const second = lock.runAsync(async () => { events.push('second'); });
    assert.deepEqual(events, ['first-start']);
    assert.throws(() => lock.run(() => events.push('illegal')), /busy/);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second']);
    await assert.rejects(lock.runAsync(async () => { throw new Error('abort'); }), /abort/);
    assert.equal(await lock.runAsync(async () => 42), 42);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
