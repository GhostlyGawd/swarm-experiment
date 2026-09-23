import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { capability } from '../../src/tier1/ids.ts';

const CAP = capability('cap:db:append'), OTHER = capability('cap:net:send');
function setup() {
  const key = new Uint8Array(32).fill(13);
  let now = 100, policy = '4', globalEpoch = '7', childEpoch = '7';
  let allowIssue = true, allowDelegate = true, revoked = false;
  const options = {
    key, repositoryId: 'repository', clock: () => now, policyEpoch: () => policy,
    revocationEpoch: (_cap: typeof CAP, path: readonly string[]) => path.at(-1) === 'restricted' ? childEpoch : globalEpoch,
    isRevoked: () => revoked,
    authorizeIssue: () => allowIssue,
    authorizeDelegate: (from: string, to: string) => allowDelegate && (from === to || from === 'caller' && to === 'callee'),
    maxTtlMs: 1000,
  };
  const authority = new ScopedGrantAuthority(options);
  const request = { capability: CAP, audience: 'caller', path: ['ledger'] } as const;
  return { authority, request, key, setNow: (value: number) => { now = value; }, setPolicy: (value: string) => { policy = value; },
    setGlobalEpoch: (value: string) => { globalEpoch = value; }, setChildEpoch: (value: string) => { childEpoch = value; },
    setIssue: (value: boolean) => { allowIssue = value; }, setDelegate: (value: boolean) => { allowDelegate = value; },
    setRevoked: (value: boolean) => { revoked = value; } };
}

test('v2 grants bind audience, resource, lifetime and policy before dispatch', () => {
  const f = setup(), token = f.authority.issue(f.request, 50);
  f.key.fill(0); // caller retaining its input key cannot mutate the authority's sealed copy
  assert.equal(f.authority.verify(token, f.request), true);
  assert.equal(f.authority.verify(token, { ...f.request, audience: 'callee' }), false);
  assert.equal(f.authority.verify(token, { ...f.request, path: ['other'] }), false);
  assert.equal(f.authority.verify(token, { ...f.request, capability: OTHER }), false);
  assert.equal(f.authority.verify({ ...token, signature: '0'.repeat(64) }, f.request), false);
  assert.equal(f.authority.verify({ ...token, injected: true }, f.request), false);
  assert.equal(f.authority.verify(new Proxy(token, {}), f.request), false);
  f.setNow(150); assert.equal(f.authority.verify(token, f.request), false);
});

test('attenuation requires a declared call edge, narrower scope and no longer lifetime', () => {
  const f = setup(), parent = f.authority.issue(f.request, 100);
  const childRequest = { capability: CAP, audience: 'callee', path: ['ledger', 'account'] } as const;
  const child = f.authority.attenuate(parent, childRequest, 40);
  assert.equal(child.body.parent, parent.id);
  assert.equal(f.authority.verify(child, childRequest), true);
  assert.equal(f.authority.verify(child, { ...childRequest, path: ['ledger', 'other'] }), false);
  assert.throws(() => f.authority.attenuate(parent, { ...childRequest, capability: OTHER }, 40), /widen/);
  assert.throws(() => f.authority.attenuate(parent, { ...childRequest, path: ['other'] }, 40), /widen/);
  assert.throws(() => f.authority.attenuate(parent, childRequest, 101), /extend lifetime/);
  f.setDelegate(false);
  assert.throws(() => f.authority.attenuate(parent, childRequest, 40), /delegation denied/);
});

test('forged, revoked, narrowed-scope revoked and stale-policy grants fail before a sink action', () => {
  const f = setup(), broad = f.authority.issue(f.request, 100);
  let actions = 0;
  const sink = (token: unknown, path: readonly string[]) => {
    if (!f.authority.verify(token, { capability: CAP, audience: 'caller', path })) throw new Error('authority denied');
    actions++;
  };
  sink(broad, ['ledger', 'account']); assert.equal(actions, 1);
  f.setChildEpoch('8');
  assert.throws(() => sink(broad, ['ledger', 'restricted']), /denied/);
  assert.equal(actions, 1);
  f.setGlobalEpoch('8');
  assert.throws(() => sink(broad, ['ledger', 'account']), /denied/);
  f.setGlobalEpoch('7'); f.setPolicy('5');
  assert.throws(() => sink(broad, ['ledger', 'account']), /denied/);
  f.setPolicy('4'); f.setRevoked(true);
  assert.throws(() => sink(broad, ['ledger', 'account']), /denied/);
  assert.throws(() => f.authority.issue(f.request, 10), /issuance denied/);
  f.setRevoked(false); f.setIssue(false);
  assert.throws(() => f.authority.issue(f.request, 10), /issuance denied/);
  assert.equal(actions, 1);
});

test('malformed grants and invalid issuance inputs fail closed', () => {
  const f = setup(), token = f.authority.issue(f.request, 50);
  assert.equal(f.authority.verify({ ...token, body: { ...token.body, path: ['..'] } }, f.request), false);
  assert.equal(f.authority.verify({ ...token, body: { ...token.body, expiresAt: Number.MAX_SAFE_INTEGER + 1 } }, f.request), false);
  assert.equal(f.authority.verify({ ...token, body: { ...token.body, nonce: 'not-hex' } }, f.request), false);
  assert.throws(() => f.authority.issue({ ...f.request, path: ['..'] }, 10), /path/);
  assert.throws(() => f.authority.issue(f.request, 0), /lifetime/);
  assert.throws(() => f.authority.issue(f.request, 1001), /lifetime/);
});
