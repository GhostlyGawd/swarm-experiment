import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { domainDigest } from '../../src/fabric/identity.ts';
import { type PromotionProposalV1 } from '../../src/fabric/promotion.ts';
import { enrollValidator, quorumVoteBody, signQuorumVote, type QuorumRosterV1 } from '../../src/fabric/quorum-crypto.ts';
import { QuorumVoteJournal } from '../../src/fabric/quorum-votes.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';

const directories: string[] = [];
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-quorum-votes-')); directories.push(directory);
  const keys = Array.from({ length: 4 }, () => generateKeyPairSync('ed25519'));
  const roster: QuorumRosterV1 = { format: 'aether.quorum-roster/1', repositoryId: 'repository', membershipEpoch: '2', policyEpoch: '5', faultBound: 1,
    validators: keys.map((key, index) => enrollValidator(`validator-${index}`, index < 2 ? 'family-a' : 'family-b', index % 2 ? 'proof' : 'security', key.publicKey)) };
  const d = (name: string) => domainDigest('aether.quorum-vote-fixture/1', name);
  const proposal: PromotionProposalV1 = { format: 'aether.promotion/1', repositoryId: 'repository', expectedParent: domainDigest('aether.execution/1', 'parent'), candidateManifest: domainDigest('aether.execution/1', 'candidate'), evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', 'evidence'), migrationPlanDigest: domainDigest('aether.migration-plan/1', 'migration'), effectPlanDigest: domainDigest('aether.effect-plan/1', 'effect'), membershipEpoch: '2', policyEpoch: '5', expiresAt: '999999' };
  const body = quorumVoteBody(roster, proposal, '3', 'commit', d('parent-block'));
  const vote = (index: number, selected = body) => signQuorumVote(selected, `validator-${index}`, keys[index].privateKey, roster);
  const options = { directory, roster };
  return { directory, keys, roster, proposal, body, vote, options };
}

test('durable vote admission survives restart and never counts one signer twice', () => {
  const f = fixture(), journal = new QuorumVoteJournal(f.options);
  const first = f.vote(0); assert.equal(journal.ingest(first), journal.ingest(first));
  assert.equal(journal.votes().length, 1);
  journal.ingest(f.vote(1)); assert.equal(journal.certificateFor(f.body), null);
  journal.ingest(f.vote(2)); const certificate = journal.certificateFor(f.body);
  assert.ok(certificate); assert.equal(certificate.votes.length, 3);
  const reopened = new QuorumVoteJournal(f.options);
  assert.equal(reopened.certificateFor(f.body)?.id, certificate.id);
});

test('equivocation is retained and quarantines the signer slot without hiding an honest quorum', () => {
  const f = fixture(), journal = new QuorumVoteJournal(f.options);
  const alternate = quorumVoteBody(f.roster, { ...f.proposal, candidateManifest: domainDigest('aether.execution/1', 'other') }, '3', 'commit', f.body.parentBlock);
  journal.ingest(f.vote(0)); journal.ingest(f.vote(1)); journal.ingest(f.vote(2));
  journal.ingest(f.vote(0, alternate));
  assert.equal(journal.certificateFor(f.body), null);
  assert.equal(journal.equivocations().length, 1);
  assert.equal(journal.equivocations()[0].votes.length, 2);
  journal.ingest(f.vote(3));
  const certificate = journal.certificateFor(f.body); assert.ok(certificate);
  assert.deepEqual(certificate.votes.map(vote => vote.signer), ['validator-1', 'validator-2', 'validator-3']);
  const reopened = new QuorumVoteJournal(f.options);
  assert.equal(reopened.equivocations().length, 1);
  assert.equal(reopened.certificateFor(f.body)?.id, certificate.id);
});

test('foreign or corrupted votes fail closed and missing established state cannot reset history', () => {
  const f = fixture(), journal = new QuorumVoteJournal(f.options), state = join(f.directory, 'votes.json'), seal = join(f.directory, 'initialized.json');
  const other = { ...f.roster, membershipEpoch: '3' }, body = quorumVoteBody(other, { ...f.proposal, membershipEpoch: '3' }, '3', 'commit', f.body.parentBlock);
  assert.throws(() => journal.ingest(signQuorumVote(body, 'validator-0', f.keys[0].privateKey, other)), /foreign/);
  journal.ingest(f.vote(0));
  const saved = readFileSync(state);
  writeFileSync(state, '{}'); assert.throws(() => new QuorumVoteJournal(f.options), /corrupt|profile|expected|fields/i);
  writeFileSync(state, saved); unlinkSync(state);
  assert.throws(() => new QuorumVoteJournal(f.options), /receipt mismatch/);
  writeFileSync(state, saved); unlinkSync(seal);
  assert.throws(() => new QuorumVoteJournal(f.options), /completion receipt/);
});

test('an interrupted empty journal initialization resumes only behind its marker', () => {
  const f = fixture(); new QuorumVoteJournal(f.options);
  unlinkSync(join(f.directory, 'initialized.json'));
  writeFileSync(join(f.directory, 'initializing.json'), encodeCanonical({ format: 'aether.quorum-votes-initializing/1', roster: quorumVoteBody(f.roster, f.proposal, '1', 'prepare', domainDigest('aether.quorum-genesis/1', 'seed')).roster }));
  const recovered = new QuorumVoteJournal(f.options);
  assert.deepEqual(recovered.votes(), []);
});
