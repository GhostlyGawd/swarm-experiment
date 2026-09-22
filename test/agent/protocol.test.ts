import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { AetherRepository } from '../../src/tier1/repository.ts';
import { AgentSession, FrameDecoder, LeaseManager, encodeFrame } from '../../src/agent/protocol.ts';

const directories: string[] = [];
after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

test('G1: agent protocol frames survive arbitrary stream chunking', () => {
  const request = { id: '1', op: 'intern' as const, term: b.int(42) };
  const frame = encodeFrame(request);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame.slice(0, 3)), []);
  assert.deepEqual(decoder.push(frame.slice(3)), [request]);

  const directory = mkdtempSync(join(tmpdir(), 'aether-agent-'));
  directories.push(directory);
  const session = new AgentSession(new AetherRepository(directory));
  const interned = session.handle(request);
  assert.equal(interned.ok, true);
  if (!interned.ok) return;
  const hydrated = session.handle({ id: '2', op: 'hydrate', root: interned.value as never });
  assert.equal(hydrated.ok, true);
  if (hydrated.ok) assert.deepEqual(hydrated.value, b.int(42));
});

test('G2: durable leases exclude competing agents and expire', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-leases-'));
  directories.push(directory);
  let now = 0;
  const repository = new AetherRepository(directory);
  const root = repository.store.intern(b.int(1));
  const leases = new LeaseManager(directory, () => now);
  const first = leases.acquire(root, 'agent-a', 10);
  assert.throws(() => leases.acquire(root, 'agent-b', 10), /leased by agent-a/);
  now = 11;
  const second = leases.acquire(root, 'agent-b', 10);
  assert.notEqual(second.token, first.token);
});
