import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { domainDigest } from '../../src/fabric/identity.ts';
import { promotionDigest, type PromotionProposalV1 } from '../../src/fabric/promotion.ts';
import { assembleQuorumCertificate, enrollValidator, quorumRosterDigest, quorumVoteBody, signQuorumVote, validateQuorumRoster, verifyPromotionCommitCertificate, verifyQuorumCertificate, verifyQuorumVote, type QuorumRosterV1 } from '../../src/fabric/quorum-crypto.ts';

function fixture() {
  const keys = Array.from({ length: 4 }, () => generateKeyPairSync('ed25519'));
  const roster: QuorumRosterV1 = { format: 'aether.quorum-roster/1', repositoryId: 'repository', membershipEpoch: '3', policyEpoch: '8', faultBound: 1,
    validators: keys.map((key, index) => enrollValidator(`validator-${index}`, index < 2 ? 'family-a' : 'family-b', index % 2 ? 'proof' : 'security', key.publicKey)) };
  const d = (name: string) => domainDigest('aether.quorum-fixture/1', name);
  const proposal: PromotionProposalV1 = { format: 'aether.promotion/1', repositoryId: 'repository', expectedParent: domainDigest('aether.execution/1', 'parent'), candidateManifest: domainDigest('aether.execution/1', 'candidate'),
    evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', 'evidence'), migrationPlanDigest: domainDigest('aether.migration-plan/1', 'migration'), effectPlanDigest: domainDigest('aether.effect-plan/1', 'effects'),
    membershipEpoch: '3', policyEpoch: '8', expiresAt: '999999' };
  const body = quorumVoteBody(roster, proposal, '4', 'commit', d('parent-block'));
  const vote = (index: number, selected = body) => signQuorumVote(selected, `validator-${index}`, keys[index].privateKey, roster);
  return { roster, keys, proposal, body, vote, d };
}

test('independent signatures form an exact-root, heterogeneous commit certificate', () => {
  const f = fixture(), votes = [f.vote(0), f.vote(1), f.vote(2)];
  const certificate = assembleQuorumCertificate(f.body, votes, f.roster);
  assert.equal(quorumRosterDigest(f.roster), f.body.roster);
  assert.equal(verifyQuorumCertificate(certificate, f.roster, f.proposal), true);
  assert.equal(verifyPromotionCommitCertificate(certificate, f.roster, f.proposal, f.proposal.expectedParent, f.body.parentBlock), true);
  assert.equal(certificate.votes.length, 3);
  assert.throws(() => assembleQuorumCertificate(f.body, votes.slice(0, 2), f.roster), /invalid quorum certificate/);
  assert.throws(() => assembleQuorumCertificate(f.body, [votes[0], votes[0], votes[2]], f.roster), /invalid quorum certificate/);
});

test('forgery, wrong signer, phase, root, policy and epoch cannot authorize promotion', () => {
  const f = fixture(), votes = [f.vote(0), f.vote(1), f.vote(2)], certificate = assembleQuorumCertificate(f.body, votes, f.roster);
  assert.equal(verifyQuorumVote({ ...votes[0], signature: 'A'.repeat(88) }, f.roster), false);
  assert.equal(verifyQuorumVote({ ...votes[0], signer: 'validator-3' }, f.roster), false);
  assert.equal(verifyQuorumCertificate({ ...certificate, votes: [{ ...votes[0], signature: 'A'.repeat(88) }, ...votes.slice(1)] }, f.roster), false);
  assert.equal(verifyPromotionCommitCertificate(certificate, f.roster, f.proposal, domainDigest('aether.execution/1', 'stale-parent'), f.body.parentBlock), false);
  assert.equal(verifyPromotionCommitCertificate(certificate, f.roster, f.proposal, f.proposal.expectedParent, f.d('different-block')), false);
  assert.equal(verifyPromotionCommitCertificate(certificate, f.roster, { ...f.proposal, candidateManifest: domainDigest('aether.execution/1', 'other') }, f.proposal.expectedParent, f.body.parentBlock), false);
  const prepare = quorumVoteBody(f.roster, f.proposal, '4', 'prepare', f.body.parentBlock);
  const prepared = assembleQuorumCertificate(prepare, [0, 1, 2].map(index => f.vote(index, prepare)), f.roster);
  assert.equal(verifyPromotionCommitCertificate(prepared, f.roster, f.proposal, f.proposal.expectedParent, f.body.parentBlock), false);
  const changedPolicy = { ...f.roster, policyEpoch: '9' };
  assert.equal(verifyQuorumCertificate(certificate, changedPolicy), false);
  const changedEpoch = { ...f.roster, membershipEpoch: '4' };
  assert.equal(verifyQuorumCertificate(certificate, changedEpoch), false);
  assert.notEqual(promotionDigest(f.proposal), promotionDigest({ ...f.proposal, policyEpoch: '9' }));
});

test('enrollment refuses one-family dominance, duplicate keys and too few validators', () => {
  const f = fixture();
  assert.doesNotThrow(() => validateQuorumRoster(f.roster));
  const dominated = { ...f.roster, validators: f.roster.validators.map((member, index) => index === 2 ? { ...member, family: 'family-a' } : member) };
  assert.throws(() => validateQuorumRoster(dominated), /heterogeneous/);
  const duplicateKey = { ...f.roster, validators: f.roster.validators.map((member, index) => index === 3 ? { ...member, publicKey: f.roster.validators[0].publicKey } : member) };
  assert.throws(() => validateQuorumRoster(duplicateKey), /one key/);
  assert.throws(() => validateQuorumRoster({ ...f.roster, validators: f.roster.validators.slice(0, 3) }), /3f/);
  assert.throws(() => signQuorumVote(f.body, 'validator-0', f.keys[1].privateKey, f.roster), /unenrolled/);
});

test('one equivocating validator cannot reach two conflicting three-of-four certificates from disjoint honest votes', () => {
  const f = fixture(), alternate = quorumVoteBody(f.roster, { ...f.proposal, candidateManifest: domainDigest('aether.execution/1', 'other') }, '4', 'commit', f.body.parentBlock);
  const first = [f.vote(0), f.vote(1), f.vote(2)];
  assert.equal(verifyQuorumCertificate(assembleQuorumCertificate(f.body, first, f.roster), f.roster), true);
  const conflicting = [f.vote(0, alternate), f.vote(3, alternate)];
  assert.throws(() => assembleQuorumCertificate(alternate, conflicting, f.roster), /invalid quorum certificate/);
});
