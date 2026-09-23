import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilitySealer } from '../../src/tier2/ocap.ts';
import { capability } from '../../src/tier1/ids.ts';

const cap = capability('cap:db:append');
test('legacy sealed tokens reject malformed shape, wrong scope and exact expiry', () => {
  let now = 100;
  const key = new Uint8Array(32).fill(7), sealer = new CapabilitySealer(key, () => now);
  const token = sealer.issue(cap, 'unit', 10);
  key.fill(0); assert.equal(sealer.verify(token, 'unit'), true);
  assert.equal(sealer.verify(token, 'other'), false);
  assert.equal(sealer.verify({ ...token, extra: true } as unknown as typeof token), false);
  assert.equal(sealer.verify({ ...token, signature: 'bad' }), false);
  assert.equal(sealer.verify({ ...token, nonce: 'bad' }), false);
  assert.equal(sealer.verify(null as unknown as typeof token), false);
  assert.equal(sealer.verify(new Proxy(token, {})), false);
  now = 110; assert.equal(sealer.verify(token), false);
});

test('legacy opaque scope attenuation cannot mint a different audience or outlive parent', () => {
  let now = 100;
  const sealer = new CapabilitySealer(new Uint8Array(32).fill(7), () => now), token = sealer.issue(cap, 'unit', 50);
  assert.throws(() => sealer.attenuate([token], [cap], 'other'), /scope cannot be changed/);
  const child = sealer.attenuate([token], [cap], 'unit')[0];
  assert.equal(child.scope, token.scope); assert.equal(child.expiresAt, token.expiresAt);
  now = 151; assert.equal(sealer.verify(child), false);
  assert.throws(() => sealer.issue(cap, 'unit', 0), /lifetime/);
});

test('invalid trusted clocks fail closed before token issue or verification', () => {
  const sealer = new CapabilitySealer(new Uint8Array(32).fill(7), () => Number.NaN);
  assert.throws(() => sealer.issue(cap, 'unit'), /clock/);
  const valid = new CapabilitySealer(new Uint8Array(32).fill(7), () => 100).issue(cap, 'unit');
  assert.equal(sealer.verify(valid), false);
});
