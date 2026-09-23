/** Cryptographic substrate for D04's Basic HotStuff promotion quorum.
 *
 * This profile verifies independent Ed25519 signatures, not a threshold-group
 * signature or distributed key generation. Durable voting/locks, view change,
 * membership handoff and production admission are separate T2-06 work.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { encodeCanonical, exactObject, identifier, decimal } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';
import { promotionDigest, validatePromotionProposal, type PromotionProposalV1 } from './promotion.ts';

export interface ValidatorEnrollmentV1 {
  readonly id: string; readonly family: string; readonly role: string; readonly publicKey: string;
}
export interface QuorumRosterV1 {
  readonly format: 'aether.quorum-roster/1'; readonly repositoryId: string;
  readonly membershipEpoch: string; readonly policyEpoch: string; readonly faultBound: number;
  readonly validators: readonly ValidatorEnrollmentV1[];
}
export type QuorumPhase = 'prepare' | 'precommit' | 'commit';
export interface QuorumVoteBodyV1 {
  readonly format: 'aether.quorum-vote/1'; readonly roster: Digest;
  readonly repositoryId: string; readonly membershipEpoch: string; readonly policyEpoch: string;
  readonly view: string; readonly phase: QuorumPhase; readonly parentBlock: Digest;
  readonly proposal: Digest; readonly expectedParent: Digest; readonly candidateManifest: Digest; readonly block: Digest;
}
export interface SignedQuorumVoteV1 { readonly body: QuorumVoteBodyV1; readonly signer: string; readonly signature: string }
export interface QuorumCertificateV1 { readonly format: 'aether.quorum-certificate/1'; readonly body: QuorumVoteBodyV1; readonly votes: readonly SignedQuorumVoteV1[]; readonly id: Digest }
const LIMITS = { maxFrameBytes: 1024 * 1024, maxDecompressedBytes: 1024 * 1024, maxObjects: 20_000, maxDepth: 64 };
function publicKey(value: unknown): KeyObject {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new TypeError('invalid validator public key');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new TypeError('noncanonical validator public key');
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 validator key required');
  return key;
}
export function enrollValidator(id: string, family: string, role: string, key: KeyObject | string): ValidatorEnrollmentV1 {
  identifier(id); identifier(family); identifier(role);
  const resolved = typeof key === 'string' ? createPublicKey(key) : key.type === 'private' ? createPublicKey(key) : key;
  if (resolved.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 validator key required');
  return { id, family, role, publicKey: resolved.export({ format: 'der', type: 'spki' }).toString('base64') };
}
export function validateQuorumRoster(value: unknown): asserts value is QuorumRosterV1 {
  encodeCanonical(value, LIMITS);
  const roster = exactObject(value, ['format', 'repositoryId', 'membershipEpoch', 'policyEpoch', 'faultBound', 'validators']);
  if (roster.format !== 'aether.quorum-roster/1') throw new TypeError('unsupported quorum roster');
  identifier(roster.repositoryId); decimal(roster.membershipEpoch); decimal(roster.policyEpoch);
  if (!Number.isSafeInteger(roster.faultBound) || (roster.faultBound as number) < 1 || !Array.isArray(roster.validators) || roster.validators.length > 64 || roster.validators.length < 3 * (roster.faultBound as number) + 1) throw new TypeError('quorum requires n >= 3f + 1');
  let previous = '', families = new Map<string, number>(), roles = new Map<string, number>(), keys = new Set<string>();
  for (const member of roster.validators) {
    const entry = exactObject(member, ['id', 'family', 'role', 'publicKey']); identifier(entry.id); identifier(entry.family); identifier(entry.role);
    if ((entry.id as string) <= previous) throw new TypeError('noncanonical or duplicate validator identity');
    previous = entry.id as string; publicKey(entry.publicKey);
    if (keys.has(entry.publicKey as string)) throw new TypeError('one key cannot enroll as multiple validators');
    keys.add(entry.publicKey as string);
    families.set(entry.family as string, (families.get(entry.family as string) ?? 0) + 1);
    roles.set(entry.role as string, (roles.get(entry.role as string) ?? 0) + 1);
  }
  const quorum = roster.validators.length - (roster.faultBound as number);
  if (families.size < 2 || [...families.values()].some(count => count >= quorum) || roles.size < 2 || [...roles.values()].some(count => count >= quorum)) throw new TypeError('eligible quorum must require heterogeneous families and roles');
}
export function quorumRosterDigest(roster: QuorumRosterV1): Digest { validateQuorumRoster(roster); return domainDigest('aether.quorum-roster/1', roster, LIMITS); }
export function quorumBlockDigest(roster: Digest, parentBlock: Digest, proposal: Digest): Digest {
  validateDigest(roster, 'aether.quorum-roster/1'); validateDigest(parentBlock); validateDigest(proposal, 'aether.promotion/1');
  return domainDigest('aether.quorum-block/1', { roster, parentBlock, proposal });
}
export function quorumVoteBody(roster: QuorumRosterV1, proposal: PromotionProposalV1, view: string, phase: QuorumPhase, parentBlock: Digest): QuorumVoteBodyV1 {
  validateQuorumRoster(roster); validatePromotionProposal(proposal); decimal(view); validateDigest(parentBlock);
  if (BigInt(view) < 1n || !['prepare', 'precommit', 'commit'].includes(phase) || proposal.repositoryId !== roster.repositoryId || proposal.membershipEpoch !== roster.membershipEpoch || proposal.policyEpoch !== roster.policyEpoch) throw new TypeError('stale or mismatched quorum proposal context');
  const rosterDigest = quorumRosterDigest(roster), proposalId = promotionDigest(proposal);
  return { format: 'aether.quorum-vote/1', roster: rosterDigest, repositoryId: roster.repositoryId, membershipEpoch: roster.membershipEpoch,
    policyEpoch: roster.policyEpoch, view, phase, parentBlock, proposal: proposalId, expectedParent: proposal.expectedParent,
    candidateManifest: proposal.candidateManifest, block: quorumBlockDigest(rosterDigest, parentBlock, proposalId) };
}
function validateBody(value: unknown): asserts value is QuorumVoteBodyV1 {
  encodeCanonical(value, LIMITS);
  const body = exactObject(value, ['format', 'roster', 'repositoryId', 'membershipEpoch', 'policyEpoch', 'view', 'phase', 'parentBlock', 'proposal', 'expectedParent', 'candidateManifest', 'block']);
  if (body.format !== 'aether.quorum-vote/1' || !['prepare', 'precommit', 'commit'].includes(String(body.phase))) throw new TypeError('unsupported quorum vote');
  identifier(body.repositoryId); decimal(body.membershipEpoch); decimal(body.policyEpoch); decimal(body.view);
  if (BigInt(body.view as string) < 1n) throw new TypeError('invalid quorum view');
  validateDigest(body.roster, 'aether.quorum-roster/1'); validateDigest(body.parentBlock);
  validateDigest(body.proposal, 'aether.promotion/1'); validateDigest(body.expectedParent, 'aether.execution/1'); validateDigest(body.candidateManifest, 'aether.execution/1');
  if (body.block !== quorumBlockDigest(body.roster as Digest, body.parentBlock as Digest, body.proposal as Digest)) throw new TypeError('quorum block identity mismatch');
}
function voteBytes(body: QuorumVoteBodyV1, signer: string): Uint8Array { return encodeCanonical({ domain: 'aether.quorum-vote-signature/1', body, signer }, LIMITS); }
function privateKey(value: KeyObject | string): KeyObject {
  const key = typeof value === 'string' ? createPrivateKey(value) : value;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 validator private key required'); return key;
}
export function signQuorumVote(body: QuorumVoteBodyV1, signer: string, key: KeyObject | string, roster: QuorumRosterV1): SignedQuorumVoteV1 {
  validateBody(body); validateQuorumRoster(roster); identifier(signer);
  if (body.roster !== quorumRosterDigest(roster) || body.repositoryId !== roster.repositoryId || body.membershipEpoch !== roster.membershipEpoch || body.policyEpoch !== roster.policyEpoch) throw new TypeError('quorum vote roster mismatch');
  const member = roster.validators.find(entry => entry.id === signer);
  if (!member || enrollValidator(signer, member.family, member.role, privateKey(key)).publicKey !== member.publicKey) throw new TypeError('unenrolled validator signer');
  return { body, signer, signature: sign(null, voteBytes(body, signer), privateKey(key)).toString('base64') };
}
export function verifyQuorumVote(value: unknown, roster: QuorumRosterV1): value is SignedQuorumVoteV1 {
  try {
    encodeCanonical(value, LIMITS); validateQuorumRoster(roster);
    const vote = exactObject(value, ['body', 'signer', 'signature']); validateBody(vote.body); identifier(vote.signer);
    const body = vote.body as QuorumVoteBodyV1, member = roster.validators.find(entry => entry.id === vote.signer);
    if (!member || body.roster !== quorumRosterDigest(roster) || body.repositoryId !== roster.repositoryId || body.membershipEpoch !== roster.membershipEpoch || body.policyEpoch !== roster.policyEpoch || typeof vote.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(vote.signature)) return false;
    const bytes = Buffer.from(vote.signature, 'base64');
    return bytes.toString('base64') === vote.signature && verify(null, voteBytes(body, vote.signer as string), publicKey(member.publicKey), bytes);
  } catch { return false; }
}
export function assembleQuorumCertificate(body: QuorumVoteBodyV1, votes: readonly SignedQuorumVoteV1[], roster: QuorumRosterV1): QuorumCertificateV1 {
  validateBody(body); validateQuorumRoster(roster); encodeCanonical(votes, LIMITS);
  const sorted = [...votes].sort((a, b) => a.signer < b.signer ? -1 : a.signer > b.signer ? 1 : 0);
  const envelope = { format: 'aether.quorum-certificate/1' as const, body, votes: sorted };
  const certificate = { ...envelope, id: domainDigest('aether.quorum-certificate/1', envelope, LIMITS) };
  if (!verifyQuorumCertificate(certificate, roster)) throw new TypeError('invalid quorum certificate'); return certificate;
}
export function verifyQuorumCertificate(value: unknown, roster: QuorumRosterV1, proposal?: PromotionProposalV1): value is QuorumCertificateV1 {
  try {
    encodeCanonical(value, LIMITS); validateQuorumRoster(roster);
    const qc = exactObject(value, ['format', 'body', 'votes', 'id']); validateBody(qc.body);
    if (qc.format !== 'aether.quorum-certificate/1' || !Array.isArray(qc.votes)) return false;
    const body = qc.body as QuorumVoteBodyV1;
    if (body.roster !== quorumRosterDigest(roster) || body.repositoryId !== roster.repositoryId || body.membershipEpoch !== roster.membershipEpoch || body.policyEpoch !== roster.policyEpoch) return false;
    if (proposal && (body.proposal !== promotionDigest(proposal) || body.expectedParent !== proposal.expectedParent || body.candidateManifest !== proposal.candidateManifest)) return false;
    if (qc.votes.length < roster.validators.length - roster.faultBound || qc.votes.length > roster.validators.length) return false;
    let previous = '', families = new Set<string>(), roles = new Set<string>();
    for (const vote of qc.votes) {
      if (!verifyQuorumVote(vote, roster) || vote.signer <= previous || Buffer.compare(Buffer.from(encodeCanonical(vote.body, LIMITS)), Buffer.from(encodeCanonical(body, LIMITS))) !== 0) return false;
      previous = vote.signer; const member = roster.validators.find(entry => entry.id === vote.signer)!;
      families.add(member.family); roles.add(member.role);
    }
    if (families.size < 2 || roles.size < 2) return false;
    const { id, ...envelope } = qc;
    return id === domainDigest('aether.quorum-certificate/1', envelope, LIMITS);
  } catch { return false; }
}
/** Cryptographic final-phase check against the caller's current production
 * parent. This still does not establish HotStuff vote/lock/view safety. */
export function verifyPromotionCommitCertificate(value: unknown, roster: QuorumRosterV1, proposal: PromotionProposalV1, currentParent: Digest, expectedParentBlock: Digest): value is QuorumCertificateV1 {
  try {
    validateDigest(currentParent, 'aether.execution/1'); validateDigest(expectedParentBlock);
    return proposal.expectedParent === currentParent && verifyQuorumCertificate(value, roster, proposal)
      && (value as QuorumCertificateV1).body.phase === 'commit'
      && (value as QuorumCertificateV1).body.expectedParent === currentParent
      && (value as QuorumCertificateV1).body.parentBlock === expectedParentBlock;
  } catch { return false; }
}
