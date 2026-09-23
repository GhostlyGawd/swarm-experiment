/** RESEARCH ONLY. D04 selects ristretto255 for production, not this Ed25519
 * prototype profile. The public Edwards/FROST equations here are UNAUDITED;
 * they are not a production signing or admission authority. Future admission
 * should prefer the pinned FROST library's share verifier and an approved key
 * ceremony. RFC 9591 sections 4-6 define the public share checks used here:
 * https://www.rfc-editor.org/rfc/rfc9591.html
 *
 * OpenSSL independently checks the final Ed25519 signature. Every selected
 * enrolled validator must additionally authenticate the complete transcript.
 * Caller-supplied trusted enrollment and subject bindings remain mandatory.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';
import { quorumRosterDigest, quorumVoteBody, type QuorumPhase, type QuorumRosterV1, type QuorumVoteBodyV1 } from './quorum-crypto.ts';
import type { PromotionProposalV1 } from './promotion.ts';

const LIMITS = Object.freeze({ maxFrameBytes: 128 * 1024, maxDecompressedBytes: 128 * 1024, maxObjects: 5000, maxDepth: 24, maxIntegerDigits: 128 });
const SUITE = 'FROST-ED25519-SHA512-v1';
const P = (1n << 255n) - 19n, L = (1n << 252n) + 27742317777372353535851937790883648493n;
const mod = (value: bigint, order = P): bigint => ((value % order) + order) % order;
function power(value: bigint, exponent: bigint, order = P): bigint { let result = 1n; for (value = mod(value, order); exponent; exponent >>= 1n, value = mod(value * value, order)) if (exponent & 1n) result = mod(result * value, order); return result; }
function inverse(value: bigint, order = P): bigint { value = mod(value, order); if (!value) throw new TypeError('zero divisor'); return power(value, order - 2n, order); }
const D = mod(-121665n * inverse(121666n)), SQRT_MINUS_ONE = power(2n, (P - 1n) / 4n);
type Point = readonly [bigint, bigint, bigint, bigint];
const IDENTITY: Point = [0n, 1n, 1n, 0n];
function add(a: Point, b: Point): Point {
  const aa = mod((a[1] - a[0]) * (b[1] - b[0])), bb = mod((a[1] + a[0]) * (b[1] + b[0])), cc = mod(2n * D * a[3] * b[3]), dd = mod(2n * a[2] * b[2]);
  const e = mod(bb - aa), f = mod(dd - cc), g = mod(dd + cc), h = mod(bb + aa);
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}
function multiply(point: Point, scalar: bigint): Point { if (scalar < 0n || scalar >= (1n << 256n)) throw new RangeError('public scalar bound'); let result = IDENTITY; for (; scalar; scalar >>= 1n, point = add(point, point)) if (scalar & 1n) result = add(result, point); return result; }
const equalPoint = (a: Point, b: Point): boolean => mod(a[0] * b[2] - b[0] * a[2]) === 0n && mod(a[1] * b[2] - b[1] * a[2]) === 0n;
function hex(value: unknown, length: number): Buffer { if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) throw new TypeError('noncanonical cryptographic bytes'); return Buffer.from(value, 'hex'); }
function little(bytes: Uint8Array): bigint { let result = 0n; for (let i = bytes.length - 1; i >= 0; i--) result = (result << 8n) + BigInt(bytes[i]); return result; }
function scalarBytes(value: bigint): Buffer { const result = Buffer.alloc(32); for (let i = 0; i < 32; i++, value >>= 8n) result[i] = Number(value & 255n); if (value) throw new RangeError('scalar serialization bound'); return result; }
function scalar(value: unknown): bigint { const result = little(hex(value, 32)); if (result >= L) throw new TypeError('noncanonical FROST scalar'); return result; }
function point(value: unknown): Point {
  const encoded = little(hex(value, 32)), sign = encoded >> 255n, y = encoded & ((1n << 255n) - 1n); if (y >= P) throw new TypeError('noncanonical Edwards y');
  const square = mod((y * y - 1n) * inverse(D * y * y + 1n)); let x = power(square, (P + 3n) / 8n);
  if (mod(x * x) !== square) x = mod(x * SQRT_MINUS_ONE);
  if (mod(x * x) !== square || x === 0n && sign !== 0n) throw new TypeError('invalid Edwards point');
  if ((x & 1n) !== sign) x = mod(-x); const decoded: Point = [x, y, 1n, mod(x * y)];
  if (equalPoint(decoded, IDENTITY) || !equalPoint(multiply(decoded, L), IDENTITY)) throw new TypeError('identity or non-prime-subgroup Edwards point'); return decoded;
}
function pointBytes(value: Point): Buffer { const reciprocal = inverse(value[2]), x = mod(value[0] * reciprocal), y = mod(value[1] * reciprocal); return scalarBytes(y | ((x & 1n) << 255n)); }
const BASE = point(`58${'66'.repeat(31)}`);
const hash = (...values: Uint8Array[]): Buffer => { const digest = createHash('sha512'); values.forEach(value => digest.update(value)); return digest.digest(); };
const suiteHash = (label: string, ...values: Uint8Array[]): Buffer => hash(Buffer.from(SUITE), Buffer.from(label), ...values);
const same = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a, LIMITS)).equals(Buffer.from(encodeCanonical(b, LIMITS)));
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T;
function interpolation(xs: readonly bigint[], index: number, at: bigint): bigint { let numerator = 1n, denominator = 1n; for (let j = 0; j < xs.length; j++) if (j !== index) { numerator = mod(numerator * (at - xs[j]), L); denominator = mod(denominator * (xs[index] - xs[j]), L); } return mod(numerator * inverse(denominator, L), L); }
function authentic(bytes: Uint8Array, signature: unknown, publicKey: string): boolean {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false; const raw = Buffer.from(signature, 'base64');
  return raw.toString('base64') === signature && verify(null, bytes, createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), raw);
}

export interface ThresholdResearchEnrollmentV1 {
  readonly format: 'aether.threshold-research-enrollment/1'; readonly roster: Digest; readonly ciphersuite: typeof SUITE;
  readonly dkgSession: string; readonly groupPublicKey: string; readonly threshold: number;
  readonly participants: readonly { readonly validatorId: string; readonly identifier: string; readonly verifyingShare: string }[];
}
export interface SignedThresholdResearchEnrollmentV1 { readonly enrollment: ThresholdResearchEnrollmentV1; readonly attestations: readonly { readonly signer: string; readonly signature: string }[] }
export interface ThresholdResearchSubjectV1 {
  readonly domain: 'aether.quorum-threshold-vote-prototype/1'; readonly body: QuorumVoteBodyV1; readonly groupSigner: string;
  readonly dkgSession: string; readonly ciphersuite: typeof SUITE; readonly threshold: number;
  readonly participants: readonly { readonly participant: number; readonly validatorId: string; readonly family: string; readonly role: string; readonly enrolledPublicKey: string }[];
}
export interface ThresholdResearchContributionV1 {
  readonly validatorId: string; readonly identifier: string; readonly hiding: string; readonly binding: string; readonly share: string; readonly authentication: string;
}
export interface ThresholdResearchCertificateV1 {
  readonly format: 'aether.quorum-threshold-research-certificate/1'; readonly enrollment: Digest; readonly subject: ThresholdResearchSubjectV1;
  readonly groupSignature: string; readonly contributions: readonly ThresholdResearchContributionV1[]; readonly id: Digest;
}
export interface ThresholdResearchContext {
  readonly roster: QuorumRosterV1; readonly group: SignedThresholdResearchEnrollmentV1; readonly expectedEnrollment: Digest;
  readonly proposal: PromotionProposalV1; readonly view: string; readonly phase: QuorumPhase; readonly parentBlock: Digest; readonly currentParent: Digest; readonly now: string;
}
export interface CheckedThresholdResearchCertificate {
  readonly profile: 'unaudited-ed25519-research-only/1'; readonly certificate: Digest; readonly subject: Digest;
  readonly participants: readonly string[]; readonly nonceKeys: readonly Digest[]; readonly shareKeys: readonly Digest[];
}
export const thresholdResearchEnrollmentDigest = (value: ThresholdResearchEnrollmentV1): Digest => domainDigest('aether.threshold-research-enrollment/1', value, LIMITS);
export const thresholdResearchEnrollmentBytes = (value: ThresholdResearchEnrollmentV1, signer: string): Uint8Array => encodeCanonical({ domain: 'aether.threshold-research-enrollment-signature/1', enrollment: thresholdResearchEnrollmentDigest(value), signer }, LIMITS);
export function thresholdResearchTranscriptDigest(value: Omit<ThresholdResearchCertificateV1, 'id'>): Digest {
  return domainDigest('aether.threshold-research-transcript/1', { format: value.format, enrollment: value.enrollment, subject: value.subject, groupSignature: value.groupSignature, contributions: value.contributions.map(({ authentication: _authentication, ...contribution }) => contribution) }, LIMITS);
}
export const thresholdResearchParticipationBytes = (value: Omit<ThresholdResearchCertificateV1, 'id'>, signer: string): Uint8Array => encodeCanonical({ domain: 'aether.threshold-research-participation/1', transcript: thresholdResearchTranscriptDigest(value), signer }, LIMITS);
export const thresholdResearchCertificateDigest = (value: Omit<ThresholdResearchCertificateV1, 'id'>): Digest => domainDigest('aether.quorum-threshold-research-certificate/1', value, LIMITS);

function enrollment(context: ThresholdResearchContext): { group: ThresholdResearchEnrollmentV1; points: Point[]; groupPoint: Point } {
  exactObject(context.group, ['enrollment', 'attestations']); const group = context.group.enrollment;
  exactObject(group, ['format', 'roster', 'ciphersuite', 'dkgSession', 'groupPublicKey', 'threshold', 'participants']);
  const rosterId = quorumRosterDigest(context.roster), n = context.roster.validators.length, f = context.roster.faultBound;
  if (n !== 3 * f + 1 || n > 16 || group.format !== 'aether.threshold-research-enrollment/1' || group.ciphersuite !== SUITE || group.roster !== rosterId || group.threshold !== 2 * f + 1 || !Array.isArray(group.participants) || group.participants.length !== n || !Array.isArray(context.group.attestations) || context.group.attestations.length !== n) throw new TypeError('research group/roster/threshold mismatch');
  hex(group.dkgSession, 16); validateDigest(context.expectedEnrollment, 'aether.threshold-research-enrollment/1');
  if (thresholdResearchEnrollmentDigest(group) !== context.expectedEnrollment) throw new TypeError('untrusted group enrollment');
  const points: Point[] = [], seen = new Set<string>();
  for (let index = 0; index < n; index++) {
    const member = context.roster.validators[index], entry = group.participants[index], attestation = context.group.attestations[index];
    exactObject(entry, ['validatorId', 'identifier', 'verifyingShare']); exactObject(attestation, ['signer', 'signature']);
    if (entry.validatorId !== member.id || entry.identifier !== String(index + 1) || attestation.signer !== member.id || !authentic(thresholdResearchEnrollmentBytes(group, member.id), attestation.signature, member.publicKey) || seen.has(entry.verifyingShare)) throw new TypeError('unauthenticated or duplicate group enrollment');
    seen.add(entry.verifyingShare); points.push(point(entry.verifyingShare));
  }
  const groupPoint = point(group.groupPublicKey), basis = points.slice(0, group.threshold), xs = basis.map((_, index) => BigInt(index + 1));
  const evaluate = (at: bigint): Point => basis.reduce((sum, value, index) => add(sum, multiply(value, interpolation(xs, index, at))), IDENTITY);
  const leading = basis.reduce((sum, value, index) => { const denominator = xs.reduce((product, x, j) => j === index ? product : mod(product * (xs[index] - x), L), 1n); return add(sum, multiply(value, inverse(denominator, L))); }, IDENTITY);
  if (equalPoint(leading, IDENTITY)) throw new TypeError('enrolled polynomial has a lower threshold degree');
  if (!equalPoint(evaluate(0n), groupPoint) || points.some((value, index) => index >= group.threshold && !equalPoint(evaluate(BigInt(index + 1)), value))) throw new TypeError('verifying shares do not interpolate to the enrolled threshold group');
  return { group, points, groupPoint };
}
function check(value: unknown, context: ThresholdResearchContext): CheckedThresholdResearchCertificate {
  encodeCanonical(value, LIMITS); encodeCanonical(context, LIMITS);
  exactObject(context, ['roster', 'group', 'expectedEnrollment', 'proposal', 'view', 'phase', 'parentBlock', 'currentParent', 'now']); decimal(context.now); decimal(context.view); validateDigest(context.currentParent, 'aether.execution/1');
  if (context.proposal.expectedParent !== context.currentParent || BigInt(context.now) >= BigInt(context.proposal.expiresAt)) throw new TypeError('stale threshold proposal');
  const certificate = exactObject(value, ['format', 'enrollment', 'subject', 'groupSignature', 'contributions', 'id']) as unknown as ThresholdResearchCertificateV1;
  if (certificate.format !== 'aether.quorum-threshold-research-certificate/1' || certificate.enrollment !== context.expectedEnrollment || !Array.isArray(certificate.contributions) || certificate.contributions.length > 16) throw new TypeError('unsupported research certificate');
  const { id: certificateId, ...unsigned } = certificate; if (thresholdResearchCertificateDigest(unsigned) !== certificateId) throw new TypeError('research certificate address mismatch');
  const subject = certificate.subject; exactObject(subject, ['domain', 'body', 'groupSigner', 'dkgSession', 'ciphersuite', 'threshold', 'participants']);
  if (subject.domain !== 'aether.quorum-threshold-vote-prototype/1' || subject.ciphersuite !== SUITE || !same(subject.body, quorumVoteBody(context.roster, context.proposal, context.view, context.phase, context.parentBlock))) throw new TypeError('threshold subject context mismatch');
  const { group, points, groupPoint } = enrollment(context);
  if (subject.groupSigner !== `frost-ed25519:${group.groupPublicKey}` || subject.dkgSession !== group.dkgSession || subject.threshold !== group.threshold || !Array.isArray(subject.participants) || subject.participants.length !== certificate.contributions.length || certificate.contributions.length < group.threshold || certificate.contributions.length > group.participants.length) throw new TypeError('group signature lacks an eligible participant transcript');
  const message = encodeCanonical(subject, LIMITS), signature = hex(certificate.groupSignature, 64), signatureR = point(signature.subarray(0, 32).toString('hex')), signatureZ = scalar(signature.subarray(32).toString('hex'));
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), hex(group.groupPublicKey, 32)]), format: 'der', type: 'spki' });
  if (!verify(null, message, key, signature)) throw new TypeError('invalid independent Ed25519 group signature');
  const families = new Set<string>(), roles = new Set<string>(), shares = new Set<string>(), nonces = new Set<string>();
  const parsed: { identifier: bigint; hiding: Point; binding: Point; scalar: bigint; public: Point }[] = [];
  let previous = 0;
  for (let index = 0; index < certificate.contributions.length; index++) {
    const contribution = certificate.contributions[index]; exactObject(contribution, ['validatorId', 'identifier', 'hiding', 'binding', 'share', 'authentication']);
    decimal(contribution.identifier); const ordinal = Number(contribution.identifier);
    if (!Number.isSafeInteger(ordinal) || ordinal <= previous || ordinal > group.participants.length) throw new TypeError('duplicate or unordered threshold signer'); previous = ordinal;
    const registered = group.participants[ordinal - 1], member = context.roster.validators[ordinal - 1], claimed = subject.participants[index];
    exactObject(claimed, ['participant', 'validatorId', 'family', 'role', 'enrolledPublicKey']);
    if (registered.validatorId !== contribution.validatorId || !same(claimed, { participant: ordinal, validatorId: member.id, family: member.family, role: member.role, enrolledPublicKey: member.publicKey }) || !authentic(thresholdResearchParticipationBytes(unsigned, member.id), contribution.authentication, member.publicKey)) throw new TypeError('unauthenticated enrolled participant/family');
    const pair = `${contribution.hiding}/${contribution.binding}`;
    if (shares.has(contribution.share) || nonces.has(pair)) throw new TypeError('duplicate threshold share or nonce'); shares.add(contribution.share); nonces.add(pair);
    families.add(member.family); roles.add(member.role);
    parsed.push({ identifier: BigInt(ordinal), hiding: point(contribution.hiding), binding: point(contribution.binding), scalar: scalar(contribution.share), public: points[ordinal - 1] });
  }
  if (families.size < 2 || roles.size < 2) throw new TypeError('homogeneous threshold transcript');
  const encodedCommitments = Buffer.concat(certificate.contributions.flatMap(contribution => [scalarBytes(BigInt(contribution.identifier)), hex(contribution.hiding, 32), hex(contribution.binding, 32)]));
  const prefix = Buffer.concat([hex(group.groupPublicKey, 32), suiteHash('msg', message), suiteHash('com', encodedCommitments)]);
  const factors = parsed.map(entry => mod(little(suiteHash('rho', prefix, scalarBytes(entry.identifier))), L));
  const commitments = parsed.map((entry, index) => add(entry.hiding, multiply(entry.binding, factors[index]))), groupCommitment = commitments.reduce(add, IDENTITY);
  const challenge = mod(little(hash(pointBytes(groupCommitment), hex(group.groupPublicKey, 32), message)), L), xs = parsed.map(entry => entry.identifier);
  if (!equalPoint(groupCommitment, signatureR) || parsed.reduce((sum, entry) => mod(sum + entry.scalar, L), 0n) !== signatureZ) throw new TypeError('group signature does not aggregate this share transcript');
  for (let index = 0; index < parsed.length; index++) {
    const entry = parsed[index], expected = add(commitments[index], multiply(entry.public, mod(challenge * interpolation(xs, index, 0n), L)));
    if (!equalPoint(multiply(BASE, entry.scalar), expected)) throw new TypeError('invalid authenticated FROST signature share');
  }
  // Verify full group equation as a cross-check of the public arithmetic too.
  if (!equalPoint(multiply(BASE, signatureZ), add(groupCommitment, multiply(groupPoint, challenge)))) throw new TypeError('public group equation mismatch');
  return { profile: 'unaudited-ed25519-research-only/1', certificate: certificateId, subject: domainDigest('aether.threshold-research-subject/1', subject, LIMITS), participants: certificate.contributions.map(item => item.validatorId), nonceKeys: certificate.contributions.map(item => domainDigest('aether.threshold-research-nonce/1', { groupPublicKey: group.groupPublicKey, verifyingShare: group.participants[Number(item.identifier) - 1].verifyingShare, hiding: item.hiding, binding: item.binding })), shareKeys: certificate.contributions.map(item => domainDigest('aether.threshold-research-share/1', { groupPublicKey: group.groupPublicKey, verifyingShare: group.participants[Number(item.identifier) - 1].verifyingShare, share: item.share })) };
}
export function verifyThresholdResearchCertificate(value: unknown, context: ThresholdResearchContext): CheckedThresholdResearchCertificate | null { try { return check(value, context); } catch { return null; } }

/** In-memory experiment ledger only. This is not durable replay protection,
 * HotStuff lock enforcement, membership handoff, or production admission. */
export class MemoryThresholdResearchLedger {
  private readonly certificates = new Set<Digest>(); private readonly nonces = new Set<Digest>(); private readonly shares = new Set<Digest>(); private readonly capacity: number;
  constructor(capacity = 128) { if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new RangeError('research replay ledger capacity'); this.capacity = capacity; }
  accept(value: unknown, context: ThresholdResearchContext): CheckedThresholdResearchCertificate {
    const result = verifyThresholdResearchCertificate(value, context); if (!result) throw new TypeError('invalid research threshold certificate');
    if (this.certificates.has(result.certificate) || result.nonceKeys.some(key => this.nonces.has(key)) || result.shareKeys.some(key => this.shares.has(key))) throw new Error('replayed research certificate/share/nonce');
    if (this.certificates.size >= this.capacity) throw new RangeError('research replay ledger full');
    this.certificates.add(result.certificate); result.nonceKeys.forEach(key => this.nonces.add(key)); result.shareKeys.forEach(key => this.shares.add(key)); return clone(result);
  }
  get size(): number { return this.certificates.size; }
}
