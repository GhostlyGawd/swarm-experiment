import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign, verify, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import type { QuorumRosterV1 } from '../../src/fabric/quorum-crypto.ts';
import type { PromotionProposalV1 } from '../../src/fabric/promotion.ts';
import { MemoryThresholdResearchLedger, thresholdResearchCertificateDigest, thresholdResearchEnrollmentBytes, thresholdResearchEnrollmentDigest, thresholdResearchParticipationBytes, verifyThresholdResearchCertificate, type ThresholdResearchCertificateV1, type ThresholdResearchContext, type ThresholdResearchEnrollmentV1, type ThresholdResearchSubjectV1 } from '../../src/fabric/quorum-threshold.ts';

const artifacts = new URL('../../roadmap/v4/research/frost/results/campaign-02/', import.meta.url);
const roster = JSON.parse(readFileSync(new URL('roster.json', artifacts), 'utf8')) as QuorumRosterV1;
const keys = [1, 2, 3, 4].map(id => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, id)]), format: 'der', type: 'pkcs8' }));
const proposal: PromotionProposalV1 = { format: 'aether.promotion/1', repositoryId: roster.repositoryId, expectedParent: domainDigest('aether.execution/1', 'parent'), candidateManifest: domainDigest('aether.execution/1', 'candidate'), evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', 'evidence'), migrationPlanDigest: domainDigest('aether.migration-plan/1', 'migration'), effectPlanDigest: domainDigest('aether.effect-plan/1', 'effects'), membershipEpoch: roster.membershipEpoch, policyEpoch: roster.policyEpoch, expiresAt: '999999' };
interface Artifact { group_public_key: string; dkg: { session: string; public_package: string }; rounds: { envelope: ThresholdResearchSubjectV1; message_hex: string; transcript: { signing_package: string; signature_shares: Record<string, string>; signature: string } }[] }
function artifact(index = 0): Artifact { return JSON.parse(readFileSync(new URL(`trial-${index}.json`, artifacts), 'utf8')); }
function little(bytes: Buffer): bigint { return BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`); }
function scalar(value: bigint): string { return Buffer.from(value.toString(16).padStart(64, '0'), 'hex').reverse().toString('hex'); }
const order = (1n << 252n) + 27742317777372353535851937790883648493n;
// This parser is only a fixture adapter for pinned frost-ed25519 3.0.0 postcard
// artifacts. Production verifier accepts structured, versioned fields instead.
function decodePublic(value: Artifact) {
  const bytes = Buffer.from(value.dkg.public_package, 'hex'); assert.equal(bytes.subarray(0, 5).toString('hex'), '00b169f0da'); assert.equal(bytes[5], 4); let cursor = 6;
  const shares = [];
  for (let id = 1; id <= 4; id++) { assert.equal(little(bytes.subarray(cursor, cursor + 32)), BigInt(id)); cursor += 32; shares.push(bytes.subarray(cursor, cursor + 32).toString('hex')); cursor += 32; }
  assert.equal(bytes.subarray(cursor, cursor + 32).toString('hex'), value.group_public_key); cursor += 32; assert.equal(bytes.subarray(cursor).toString('hex'), '0103'); return shares;
}
function decodeCommitments(round: Artifact['rounds'][number]) {
  const bytes = Buffer.from(round.transcript.signing_package, 'hex'); assert.equal(bytes.subarray(0, 5).toString('hex'), '00b169f0da'); assert.equal(bytes[5], 3); let cursor = 6;
  const entries = [];
  for (let index = 0; index < 3; index++) {
    const identifier = little(bytes.subarray(cursor, cursor + 32)); cursor += 32; assert.equal(bytes.subarray(cursor, cursor + 5).toString('hex'), '00b169f0da'); cursor += 5;
    const hiding = bytes.subarray(cursor, cursor + 32).toString('hex'); cursor += 32; const binding = bytes.subarray(cursor, cursor + 32).toString('hex'); cursor += 32; entries.push({ identifier: String(identifier), hiding, binding });
  }
  let size = 0, shift = 0, byte: number; do { byte = bytes[cursor++]; size += (byte & 127) * 2 ** shift; shift += 7; assert.ok(shift <= 21); } while (byte & 128);
  assert.equal(bytes.length - cursor, size); assert.equal(bytes.subarray(cursor).toString('hex'), round.message_hex); return entries;
}
function endorse(group: ThresholdResearchEnrollmentV1) { return { enrollment: group, attestations: roster.validators.map((member, index) => ({ signer: member.id, signature: sign(null, thresholdResearchEnrollmentBytes(group, member.id), keys[index]).toString('base64') })) }; }
function authenticate(value: Omit<ThresholdResearchCertificateV1, 'id'>): ThresholdResearchCertificateV1 {
  const contributions = value.contributions.map(item => ({ ...item, authentication: sign(null, thresholdResearchParticipationBytes(value, item.validatorId), keys[Number(item.identifier) - 1]).toString('base64') }));
  const { id: _id, ...unsigned } = value as ThresholdResearchCertificateV1;
  const body = { ...unsigned, contributions }; return { ...body, id: thresholdResearchCertificateDigest(body) };
}
function fixture(trial = 0, roundIndex = 0) {
  const raw = artifact(trial), round = raw.rounds[roundIndex], publicShares = decodePublic(raw);
  const enrollment: ThresholdResearchEnrollmentV1 = { format: 'aether.threshold-research-enrollment/1', roster: round.envelope.body.roster, ciphersuite: 'FROST-ED25519-SHA512-v1', dkgSession: raw.dkg.session, groupPublicKey: raw.group_public_key, threshold: 3, participants: publicShares.map((verifyingShare, index) => ({ validatorId: roster.validators[index].id, identifier: String(index + 1), verifyingShare })) };
  const unsigned: Omit<ThresholdResearchCertificateV1, 'id'> = { format: 'aether.quorum-threshold-research-certificate/1', enrollment: thresholdResearchEnrollmentDigest(enrollment), subject: round.envelope, groupSignature: round.transcript.signature, contributions: decodeCommitments(round).map(entry => ({ ...entry, validatorId: roster.validators[Number(entry.identifier) - 1].id, share: round.transcript.signature_shares[entry.identifier], authentication: '' })) };
  const context: ThresholdResearchContext = { roster, group: endorse(enrollment), expectedEnrollment: unsigned.enrollment, proposal, view: '3', phase: 'commit', parentBlock: round.envelope.body.parentBlock, currentParent: proposal.expectedParent, now: '0' };
  return { certificate: authenticate(unsigned), context, raw, round, unsigned };
}
function addressed(value: ThresholdResearchCertificateV1): ThresholdResearchCertificateV1 { const { id: _id, ...unsigned } = value; return { ...unsigned, id: thresholdResearchCertificateDigest(unsigned) }; }

test('unaudited research checker independently verifies all 40 Rust-generated group and authenticated share transcripts', () => {
  for (let trial = 0; trial < 10; trial++) for (let round = 0; round < 4; round++) {
    const f = fixture(trial, round), result = verifyThresholdResearchCertificate(f.certificate, f.context);
    assert.ok(result, `trial ${trial} round ${round}`); assert.equal(result.profile, 'unaudited-ed25519-research-only/1'); assert.equal(result.participants.length, 3);
  }
});

test('group-signature-only and claimed family labels cannot replace enrolled participation attestations', () => {
  const f = fixture();
  assert.equal(verifyThresholdResearchCertificate(addressed({ ...f.certificate, contributions: [] }), f.context), null);
  const unsigned = { ...f.certificate, contributions: f.certificate.contributions.map(item => ({ ...item, authentication: '' })) };
  assert.equal(verifyThresholdResearchCertificate(addressed(unsigned), f.context), null);
  const forged = structuredClone(f.certificate); (forged.subject.participants[0] as { family: string }).family = 'other-family';
  assert.equal(verifyThresholdResearchCertificate(authenticate(forged), f.context), null);
  assert.equal(verifyThresholdResearchCertificate(f.certificate, { ...f.context, group: { ...f.context.group, attestations: f.context.group.attestations.slice(1) } }), null);
  assert.equal(verifyThresholdResearchCertificate(f.certificate, { ...f.context, expectedEnrollment: domainDigest('aether.threshold-research-enrollment/1', 'unapproved') }), null);
});

test('exact proposal, epoch, policy, phase, view, parent, expiry and enrollment bindings cannot be replayed', () => {
  const f = fixture();
  const contexts: ThresholdResearchContext[] = [{ ...f.context, view: '4' }, { ...f.context, phase: 'prepare' }, { ...f.context, parentBlock: domainDigest('aether.quorum-block/1', 'other') }, { ...f.context, currentParent: domainDigest('aether.execution/1', 'other') }, { ...f.context, now: '999999' }, { ...f.context, roster: { ...roster, membershipEpoch: '3' } }, { ...f.context, roster: { ...roster, policyEpoch: '6' } }, { ...f.context, proposal: { ...proposal, candidateManifest: domainDigest('aether.execution/1', 'other') } }, { ...f.context, group: fixture(1).context.group }];
  for (const context of contexts) assert.equal(verifyThresholdResearchCertificate(f.certificate, context), null);
});

test('authenticated cancelling false shares reject even when their sum and OpenSSL group signature remain valid', () => {
  const f = fixture(), forged = structuredClone(f.unsigned);
  (forged.contributions[0] as { share: string }).share = scalar((little(Buffer.from(forged.contributions[0].share, 'hex')) + 1n) % order);
  (forged.contributions[1] as { share: string }).share = scalar((little(Buffer.from(forged.contributions[1].share, 'hex')) - 1n + order) % order);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(f.raw.group_public_key, 'hex')]), format: 'der', type: 'spki' });
  assert.equal(verify(null, encodeCanonical(f.certificate.subject), key, Buffer.from(f.certificate.groupSignature, 'hex')), true);
  assert.equal(verifyThresholdResearchCertificate(authenticate(forged), f.context), null);
});

test('duplicate, stale, malformed scalar and non-prime-subgroup public contributions are rejected', () => {
  const f = fixture();
  for (const mutation of [
    (value: typeof f.unsigned) => { (value.contributions as unknown[])[1] = value.contributions[0]; },
    (value: typeof f.unsigned) => { (value.contributions[0] as { share: string }).share = fixture(0, 1).certificate.contributions[0].share; },
    (value: typeof f.unsigned) => { (value.contributions[0] as { share: string }).share = scalar(order); },
    ...['01' + '00'.repeat(31), 'ec' + 'ff'.repeat(30) + '7f', 'ed' + 'ff'.repeat(30) + '7f', '01' + '00'.repeat(30) + '80'].map(hiding => (value: typeof f.unsigned) => { (value.contributions[0] as { hiding: string }).hiding = hiding; }),
  ]) { const changed = structuredClone(f.unsigned); mutation(changed); assert.equal(verifyThresholdResearchCertificate(authenticate(changed), f.context), null); }
});

test('enrollment cannot substitute mixed verifying shares or one-family/one-role membership', () => {
  const f = fixture(), changed = structuredClone(f.context.group.enrollment);
  (changed.participants[3] as { verifyingShare: string }).verifyingShare = fixture(1).context.group.enrollment.participants[3].verifyingShare;
  const enrollment = thresholdResearchEnrollmentDigest(changed), context = { ...f.context, group: endorse(changed), expectedEnrollment: enrollment };
  assert.equal(verifyThresholdResearchCertificate(authenticate({ ...f.unsigned, enrollment }), context), null);
  for (const field of ['family', 'role'] as const) assert.equal(verifyThresholdResearchCertificate(f.certificate, { ...f.context, roster: { ...roster, validators: roster.validators.map(member => ({ ...member, [field]: 'all-the-same' })) } }), null);
});

test('research replay ledger rejects duplicates atomically and cannot imply durable replay protection', () => {
  const f = fixture(), ledger = new MemoryThresholdResearchLedger(1); ledger.accept(f.certificate, f.context); assert.equal(ledger.size, 1);
  assert.throws(() => ledger.accept(f.certificate, f.context), /replayed/);
  const other = fixture(0, 1); assert.throws(() => ledger.accept(other.certificate, other.context), /full/); assert.equal(ledger.size, 1);
  assert.ok(new MemoryThresholdResearchLedger().accept(f.certificate, f.context), 'new process/in-memory ledger is not a production replay defense');
  assert.equal(verifyThresholdResearchCertificate({ ...f.certificate, extra: true }, f.context), null);
  assert.equal(verifyThresholdResearchCertificate({ ...f.certificate, contributions: Array(1000).fill(f.certificate.contributions[0]) }, f.context), null);
});

test('pinned FROST 3.0.0 independently cross-checks valid, cancelling, changed and malformed public shares', { skip: process.env.AETHER_FROST_DIFFERENTIAL !== '1' }, context => {
  const manifest = fileURLToPath(new URL('fixtures/frost-share-oracle/Cargo.toml', import.meta.url));
  const built = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', manifest], { encoding: 'utf8', timeout: 120000 }); assert.equal(built.status, 0, built.stderr);
  const cases: { kind: string; input: { publicPackage: string; signingPackage: string; shares: Record<string, string> }; certificate: ThresholdResearchCertificateV1; context: ThresholdResearchContext }[] = [];
  for (let trial = 0; trial < 10; trial++) for (let round = 0; round < 4; round++) {
    const f = fixture(trial, round), base = { publicPackage: f.raw.dkg.public_package, signingPackage: f.round.transcript.signing_package, shares: f.round.transcript.signature_shares };
    cases.push({ kind: 'valid', input: base, certificate: f.certificate, context: f.context });
    for (const kind of ['changed', 'cancelling', 'malformed-scalar', 'non-subgroup-point']) {
      const input = structuredClone(base), unsigned = structuredClone(f.unsigned), first = unsigned.contributions[0], second = unsigned.contributions[1];
      if (kind === 'non-subgroup-point') {
        const bad = trial % 2 ? '01' + '00'.repeat(31) : 'ec' + 'ff'.repeat(30) + '7f', bytes = Buffer.from(input.signingPackage, 'hex'); Buffer.from(bad, 'hex').copy(bytes, 43); input.signingPackage = bytes.toString('hex'); (first as { hiding: string }).hiding = bad;
      } else {
        (first as { share: string }).share = kind === 'malformed-scalar' ? scalar(order) : scalar((little(Buffer.from(first.share, 'hex')) + 1n) % order); input.shares[first.identifier] = first.share;
        if (kind === 'cancelling') { (second as { share: string }).share = scalar((little(Buffer.from(second.share, 'hex')) + order - 1n) % order); input.shares[second.identifier] = second.share; }
      }
      cases.push({ kind, input, certificate: authenticate(unsigned), context: f.context });
    }
  }
  const binary = fileURLToPath(new URL('fixtures/frost-share-oracle/target/release/aether-frost-share-oracle', import.meta.url));
  const run = spawnSync(binary, [], { input: JSON.stringify(cases.map(item => item.input)), encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); assert.equal(run.status, 0, run.stderr);
  const results = JSON.parse(run.stdout) as { deserialized: boolean; sharesValid: boolean[]; aggregateValid: boolean }[]; assert.equal(results.length, cases.length);
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index], rust = results[index], validShares = rust.deserialized && rust.sharesValid.length === 3 && rust.sharesValid.every(Boolean);
    assert.equal(validShares, item.kind === 'valid', `${index} ${item.kind}: pinned FROST individual-share result`);
    assert.equal(verifyThresholdResearchCertificate(item.certificate, item.context) !== null, validShares, `${index} ${item.kind}: public checker disagreement`);
    if (item.kind === 'cancelling') assert.equal(rust.aggregateValid, true, 'valid aggregate alone does not establish every share');
  }
  context.diagnostic(`${cases.length} public transcripts cross-checked against pinned frost_core::verify_signature_share; 40 valid and 160 malformed/altered cases.`);
});
