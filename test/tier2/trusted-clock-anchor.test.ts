import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertBeforeDeadline, assertGrantLifetime, assertTrustedClockAnchor,
  createTrustedClockAnchor, readTrustedClock,
} from '../../src/tier2/trusted-clock-anchor.ts';

test('clock identity binds the operator authority and domain, and cannot be forged structurally', () => {
  const options = { authorityId: 'operator-clock', clockDomain: 'broker-ms/1',
    nowMs: () => 100, revision: () => '9' };
  const a = createTrustedClockAnchor(options);
  const b = createTrustedClockAnchor(options);
  const otherAuthority = createTrustedClockAnchor({ ...options, authorityId: 'another-clock' });
  const otherDomain = createTrustedClockAnchor({ ...options, clockDomain: 'other-ms/1' });
  assert.equal(a.format, 'aether.trusted-clock-anchor/1');
  assert.equal(a.digest, b.digest);
  assert.equal(a.clockDomainDigest, b.clockDomainDigest);
  assert.notEqual(a.digest, otherAuthority.digest);
  assert.notEqual(a.clockDomainDigest, otherAuthority.clockDomainDigest);
  assert.notEqual(a.clockDomainDigest, otherDomain.clockDomainDigest);
  assert.ok(Object.isFrozen(a));
  assertTrustedClockAnchor(a);
  assert.throws(() => assertTrustedClockAnchor({ ...a }), /independently provisioned/);
});

test('grant interval and signed broker deadline use the independent ms clock at exact boundaries', () => {
  let trustedMs = 100;
  let revision = 1;
  const factoryClock = () => 100; // An untrusted factory may keep its own time frozen.
  const anchor = createTrustedClockAnchor({ authorityId: 'operator', clockDomain: 'broker-ms/1',
    nowMs: () => trustedMs, revision: () => String(revision) });
  assertGrantLifetime(anchor, 100, 102);
  assertBeforeDeadline(anchor, '100', 'broker-ms/1');
  trustedMs = 101; revision++;
  assertGrantLifetime(anchor, 100, 102);
  assert.throws(() => assertBeforeDeadline(anchor, '100', 'broker-ms/1'), /deadline exceeded/);
  trustedMs = 102; revision++;
  assert.equal(factoryClock(), 100);
  assert.throws(() => assertGrantLifetime(anchor, 100, 102), /outside trusted lifetime/);
  assertBeforeDeadline(anchor, '102', 'broker-ms/1');
  assert.throws(() => assertBeforeDeadline(anchor, '103', 'wrong-ms/1'), /domain mismatch/);
  assert.throws(() => assertBeforeDeadline(anchor, '0103', 'broker-ms/1'), /canonical decimal/);
  assert.throws(() => assertBeforeDeadline(anchor, String(BigInt(Number.MAX_SAFE_INTEGER) + 1n), 'broker-ms/1'), /safe ms range/);
  assert.throws(() => assertGrantLifetime(anchor, 102, 102), /invalid trusted grant lifetime/);
  assert.throws(() => assertGrantLifetime(anchor, -1, 103), /invalid trusted grant lifetime/);
});

test('each check reads one synchronous independent time and revision sample', () => {
  let timeReads = 0;
  let revisionReads = 0;
  const anchor = createTrustedClockAnchor({ authorityId: 'operator', clockDomain: 'broker-ms/1',
    nowMs: () => { timeReads++; return 100; },
    revision: () => { revisionReads++; return '1'; } });
  assert.deepEqual([timeReads, revisionReads], [1, 1]);
  assertGrantLifetime(anchor, 99, 101);
  assert.deepEqual([timeReads, revisionReads], [2, 2]);
  assertBeforeDeadline(anchor, '100', 'broker-ms/1');
  assert.deepEqual([timeReads, revisionReads], [3, 3]);
});

test('unavailable, asynchronous and invalid clock sources fail closed', () => {
  for (const nowMs of [() => -1, () => -0, () => Number.POSITIVE_INFINITY,
    () => Number.MAX_SAFE_INTEGER + 1, () => Promise.resolve(1) as unknown as number,
    () => { throw new Error('clock unavailable'); }]) {
    assert.throws(() => createTrustedClockAnchor({ authorityId: 'operator', clockDomain: 'broker-ms/1',
      nowMs, revision: () => '1' }));
  }
  for (const revision of [() => '01', () => '-1', () => 'x',
    () => Promise.resolve('1') as unknown as string,
    () => { throw new Error('revision unavailable'); }]) {
    assert.throws(() => createTrustedClockAnchor({ authorityId: 'operator', clockDomain: 'broker-ms/1',
      nowMs: () => 100, revision }));
  }
  let available = true;
  const anchor = createTrustedClockAnchor({ authorityId: 'operator', clockDomain: 'broker-ms/1',
    nowMs: () => { if (!available) throw new Error('provider unavailable'); return 100; }, revision: () => '1' });
  available = false;
  assert.throws(() => assertGrantLifetime(anchor, 0, 101), /provider unavailable/);
  assert.throws(() => assertBeforeDeadline(anchor, '101', 'broker-ms/1'), /provider unavailable/);
});

test('time and revision rollback fail closed without accepting the bad sample', () => {
  let nowMs = 100;
  let revision = '5';
  const anchor = createTrustedClockAnchor({ authorityId: 'operator', clockDomain: 'broker-ms/1',
    nowMs: () => nowMs, revision: () => revision });
  nowMs = 101; revision = '6';
  assert.deepEqual(readTrustedClock(anchor), { nowMs: 101, revision: '6' });
  nowMs = 99; revision = '7';
  assert.throws(() => assertBeforeDeadline(anchor, '200', 'broker-ms/1'), /time rolled back/);
  nowMs = 101; revision = '5';
  assert.throws(() => assertGrantLifetime(anchor, 100, 200), /revision rolled back/);
  nowMs = 102; revision = '8';
  assert.deepEqual(readTrustedClock(anchor), { nowMs: 102, revision: '8' });
});

test('an already provisioned anchor retains its operator callbacks', () => {
  let trustedMs = 100;
  const options = { authorityId: 'operator', clockDomain: 'broker-ms/1',
    nowMs: () => trustedMs, revision: () => '1' };
  const anchor = createTrustedClockAnchor(options);
  options.nowMs = () => 0;
  options.revision = () => '0';
  trustedMs = 102;
  assert.throws(() => assertGrantLifetime(anchor, 100, 102), /outside trusted lifetime/);
});
