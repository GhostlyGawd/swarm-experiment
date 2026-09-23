import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { nodeRef } from '../../../../src/tier1/ids.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { effectResourcePolicyDigestV2, signEffectResourcePolicyV2 } from '../../../../src/tier2/effect-resource-policy.ts';
import { createEffectSignerAnchor, assertPinnedEffectService, assertPinnedAnchorRecord } from './anchor.mjs';

const repositoryId = 'anchor-research';
const signer = 'policy-officer';
const astRoot = nodeRef('a'.repeat(64));
const adapterDigest = domainDigest('aether.effect-adapter/1', 'sink');
const adapterArtifactDigest = domainDigest('aether.effect-adapter-artifact/1', 'sink bytes');
const policy = (epoch, target = 'ledger') => ({
  format: 'aether.effect-resource-policy/2', repositoryId, astRoot, policyEpoch: epoch,
  rules: [{ capability: 'cap:db:append', prefix: [target], argument: 0,
    adapterId: 'ledger-sink', adapterDigest, adapterArtifactDigest }],
});
const manifest = body => ({ astRoot, capabilityPolicyDigest: effectResourcePolicyDigestV2(body) });
const services = signedEffectResourcePolicy => ({
  scopedGrants: { repositoryId }, signedEffectResourcePolicy,
  effectRouterFactory: () => { throw new Error('no sink invoked by trust preflight'); },
});
function fixture() {
  const trusted = generateKeyPairSync('ed25519'), attacker = generateKeyPairSync('ed25519');
  let epoch = '0';
  const anchor = createEffectSignerAnchor({ repositoryId, signer, publicKey: trusted.publicKey, currentEpoch: () => epoch });
  return { trusted, attacker, anchor, advance: () => { epoch = String(BigInt(epoch) + 1n); }, epoch: () => epoch };
}

test('independently pinned key admits exact policy and survives equivalent reopen', () => {
  const f = fixture(), body = policy(f.epoch());
  const supplied = services(signEffectResourcePolicyV2(body, signer, f.trusted.privateKey));
  const first = assertPinnedEffectService(f.anchor, manifest(body), supplied, f.anchor.digest);
  assert.equal(first.effectResourceSignerKey.export({ type: 'spki', format: 'der' }).toString('base64'), f.anchor.identity.keySpki);
  assert.equal(first.currentEffectPolicyEpoch(), '0');
  const reopened = createEffectSignerAnchor({ repositoryId, signer, publicKey: f.trusted.publicKey, currentEpoch: f.epoch });
  assert.equal(reopened.digest, f.anchor.digest);
  assert.equal(assertPinnedAnchorRecord({ effectSignerAnchorDigest: f.anchor.digest }, reopened), true);
  assertPinnedEffectService(reopened, manifest(body), supplied, f.anchor.digest);
});

test('factory key swap cannot make the same policy body trustworthy on reopen', () => {
  const f = fixture(), body = policy(f.epoch()), signed = signEffectResourcePolicyV2(body, signer, f.attacker.privateKey);
  assert.throws(() => assertPinnedEffectService(f.anchor, manifest(body), services(signed), f.anchor.digest), /untrusted effect resource policy v2 signer/);
  assert.throws(() => assertPinnedEffectService(f.anchor, manifest(body), {
    ...services(signed), effectResourceSignerKey: f.attacker.publicKey,
  }, f.anchor.digest), /factory must not supply/);
});

test('promotion cannot admit attacker-signed candidate even when approved manifest binds its digest', () => {
  const f = fixture(), original = policy('0'), candidate = policy('0', 'payments');
  const good = services(signEffectResourcePolicyV2(original, signer, f.trusted.privateKey));
  assertPinnedEffectService(f.anchor, manifest(original), good, f.anchor.digest);
  const substituted = services(signEffectResourcePolicyV2(candidate, signer, f.attacker.privateKey));
  assert.throws(() => assertPinnedEffectService(f.anchor, manifest(candidate), substituted, f.anchor.digest), /untrusted effect resource policy v2 signer/);
  const approved = services(signEffectResourcePolicyV2(candidate, signer, f.trusted.privateKey));
  assertPinnedEffectService(f.anchor, manifest(candidate), approved, f.anchor.digest);
});

test('wrong signer ID, repository, digest, and independent epoch fail closed', () => {
  const f = fixture(), body = policy('0'), signed = signEffectResourcePolicyV2(body, signer, f.trusted.privateKey);
  assert.throws(() => assertPinnedEffectService(f.anchor, manifest(body), services({ ...signed, signer: 'replacement' }), f.anchor.digest), /policy signer differs/);
  assert.throws(() => assertPinnedEffectService(f.anchor, manifest(body), { ...services(signed), scopedGrants: { repositoryId: 'elsewhere' } }, f.anchor.digest), /repository differs/);
  assert.throws(() => assertPinnedEffectService(f.anchor, { ...manifest(body), capabilityPolicyDigest: domainDigest('aether.effect-resource-policy/2', 'different') }, services(signed), f.anchor.digest), /stale or foreign/);
  f.advance();
  assert.throws(() => assertPinnedEffectService(f.anchor, manifest(body), services(signed), f.anchor.digest), /stale or foreign/);
  assert.throws(() => assertPinnedEffectService(f.anchor, manifest(body), { ...services(signed), currentEffectPolicyEpoch: () => '0' }, f.anchor.digest), /factory must not supply/);
});

test('missing pin, changed pin, record tampering, and key rotation require explicit migration', () => {
  const f = fixture(), body = policy('0'), supplied = services(signEffectResourcePolicyV2(body, signer, f.trusted.privateKey));
  assert.throws(() => assertPinnedEffectService(null, manifest(body), supplied, f.anchor.digest), /missing or changed/);
  assert.throws(() => assertPinnedEffectService(f.anchor, manifest(body), supplied, domainDigest('aether.effect-signer-anchor/1', 'forged')), /missing or changed/);
  assert.throws(() => assertPinnedAnchorRecord({ effectSignerAnchorDigest: domainDigest('aether.effect-signer-anchor/1', 'forged') }, f.anchor), /mismatch/);
  const replacement = createEffectSignerAnchor({ repositoryId, signer, publicKey: f.attacker.publicKey, currentEpoch: f.epoch });
  assert.notEqual(replacement.digest, f.anchor.digest);
  assert.throws(() => assertPinnedAnchorRecord({ effectSignerAnchorDigest: f.anchor.digest }, replacement), /mismatch/);
  assert.throws(() => assertPinnedEffectService(replacement, manifest(body), supplied, f.anchor.digest), /missing or changed/);
});

test('input rejects non-public, non-Ed25519, and invalid epoch anchors', () => {
  const f = fixture();
  assert.throws(() => createEffectSignerAnchor({ repositoryId, signer, publicKey: f.trusted.privateKey, currentEpoch: f.epoch }), /external Ed25519 public key/);
  assert.throws(() => createEffectSignerAnchor({ repositoryId, signer, publicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey, currentEpoch: f.epoch }), /external Ed25519 public key/);
  assert.throws(() => createEffectSignerAnchor({ repositoryId, signer, publicKey: f.trusted.publicKey, currentEpoch: () => '01' }), /canonical decimal/);
});
