/** Basic HotStuff honest-validator profile, following Algorithm 2 of
 * https://arxiv.org/pdf/1803.05069 (2019), with independent Ed25519 signatures.
 *
 * Persistence and writer exclusion are SAME-HOST guarantees. One key must have
 * one durable directory; copying/rolling back that directory is outside this
 * profile. Safety assumes <= f Byzantine keys, collision-resistant hashes and
 * durable honest state. Progress additionally needs eventual bounded delivery,
 * fair message retries, available heterogeneous quorums, synchronized views
 * with an honest leader, and a trusted monotonic clock that retains its domain
 * across restart. Exponential timeouts do not decide or unlock anything.
 * Resource limits fail closed; no unbounded liveness or WAN claim is made.
 * Decisions are ordered consensus commands, NOT activated production changes.
 */
import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';
import { promotionDigest, validatePromotionProposal, type PromotionProposalV1 } from './promotion.ts';
import { JournalLock } from './journal-lock.ts';
import { enrollValidator, quorumBlockDigest, quorumRosterDigest, quorumVoteBody, signQuorumVote, verifyQuorumCertificate, verifyQuorumVote, type QuorumCertificateV1, type QuorumRosterV1, type QuorumVoteBodyV1, type SignedQuorumVoteV1 } from './quorum-crypto.ts';

const LIMITS = { maxFrameBytes: 8 * 1024 * 1024, maxDecompressedBytes: 8 * 1024 * 1024, maxObjects: 200_000, maxDepth: 64, maxIntegerDigits: 4096 };
const PROFILE = 'aether.basic-hotstuff/1';
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T;
const same = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a, LIMITS)).equals(Buffer.from(encodeCanonical(b, LIMITS)));
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function sync(directory: string): void { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensure(directory: string): void { if (existsSync(directory)) return; ensure(dirname(directory)); try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } sync(directory); sync(dirname(directory)); }

export interface HotStuffBlockV1 { readonly format: 'aether.hotstuff-block/1'; readonly id: Digest; readonly parent: Digest; readonly proposal: PromotionProposalV1 }
export interface NewViewBodyV1 { readonly format: 'aether.hotstuff-new-view/1'; readonly context: Digest; readonly targetView: string; readonly highQC: QuorumCertificateV1 | null }
export interface SignedNewViewV1 { readonly body: NewViewBodyV1; readonly signer: string; readonly signature: string }
export type LeaderBodyV1 =
  { readonly format: 'aether.hotstuff-leader/1'; readonly context: Digest; readonly view: string; readonly phase: 'prepare'; readonly block: HotStuffBlockV1; readonly highQC: QuorumCertificateV1 | null; readonly reports: readonly SignedNewViewV1[] } |
  { readonly format: 'aether.hotstuff-leader/1'; readonly context: Digest; readonly view: string; readonly phase: 'precommit' | 'commit' | 'decide'; readonly qc: QuorumCertificateV1 };
export interface SignedLeaderMessageV1 { readonly body: LeaderBodyV1; readonly signer: string; readonly signature: string }
export interface HotStuffDecision { readonly certificate: QuorumCertificateV1; readonly blocks: readonly HotStuffBlockV1[] }
export interface DurableQuorumNodeOptions {
  readonly directory: string; readonly roster: QuorumRosterV1; readonly validatorId: string; readonly privateKey: KeyObject | string;
  readonly genesisManifest: Digest; readonly clockDomain: string; readonly clock: () => bigint; readonly initialTimeoutNs: bigint;
  /** Trusted application validity check; this module does not check proof bundles or activate deployments. */
  readonly validateProposal: (proposal: PromotionProposalV1) => boolean;
  readonly maxEvents?: number; readonly maxBlocks?: number; readonly maxView?: number; readonly waitMs?: number;
  readonly fault?: (point: 'before-state-publish' | 'after-state-publish') => void;
}
type Input = { kind: 'blocks'; blocks: readonly HotStuffBlockV1[] } | { kind: 'report' } | { kind: 'new-view'; report: SignedNewViewV1 } |
  { kind: 'propose'; proposal: PromotionProposalV1 } | { kind: 'leader-phase'; phase: 'precommit' | 'commit' | 'decide'; qc: QuorumCertificateV1 } |
  { kind: 'receive'; message: SignedLeaderMessageV1 } | { kind: 'timeout'; expectedView: string };
type Output = null | SignedNewViewV1 | SignedLeaderMessageV1 | SignedQuorumVoteV1 | HotStuffDecision;
interface Event { readonly input: Input; readonly output: Output; readonly at: string }
interface Journal { readonly format: 'aether.hotstuff-journal/1'; readonly context: Digest; readonly validator: string; readonly started: string; readonly events: readonly Event[] }
interface Core {
  view: string; started: bigint; clock: bigint; phase: 'prepare' | 'precommit' | 'commit' | 'decide'; highQC: QuorumCertificateV1 | null; entryQC: QuorumCertificateV1 | null; lockedQC: QuorumCertificateV1 | null;
  decidedHead: Digest; blocks: Map<Digest, HotStuffBlockV1>; votes: Map<string, SignedQuorumVoteV1>; reports: SignedNewViewV1[];
  ownReports: Map<string, SignedNewViewV1>; proposals: Map<string, SignedLeaderMessageV1>; decisions: HotStuffDecision[];
}
export interface HotStuffStatus { readonly view: string; readonly leader: string; readonly phase: Core['phase']; readonly highQC: QuorumCertificateV1 | null; readonly lockedQC: QuorumCertificateV1 | null; readonly decidedHead: Digest; readonly deadline: string; readonly votes: readonly SignedQuorumVoteV1[]; readonly decisions: readonly HotStuffDecision[] }

export class DurableQuorumNode {
  readonly context: Digest; readonly genesisBlock: Digest;
  private readonly options: DurableQuorumNodeOptions; private readonly roster: QuorumRosterV1; private readonly rosterId: Digest; private readonly key: KeyObject; private readonly lock: JournalLock;
  private readonly maxEvents: number; private readonly maxBlocks: number; private readonly maxView: number;
  constructor(options: DurableQuorumNodeOptions) {
    this.rosterId = quorumRosterDigest(options.roster); this.roster = clone(options.roster);
    if (this.roster.validators.length !== 3 * this.roster.faultBound + 1) throw new TypeError('D04 Basic HotStuff profile requires exactly n=3f+1');
    identifier(options.validatorId); identifier(options.clockDomain); validateDigest(options.genesisManifest, 'aether.execution/1');
    if (typeof options.initialTimeoutNs !== 'bigint' || options.initialTimeoutNs < 1n || typeof options.validateProposal !== 'function') throw new TypeError('invalid HotStuff clock/application policy'); decimal(String(options.initialTimeoutNs));
    this.maxEvents = options.maxEvents ?? 2048; this.maxBlocks = options.maxBlocks ?? 512; this.maxView = options.maxView ?? 1024;
    for (const [value, max] of [[this.maxEvents, 4096], [this.maxBlocks, 2048], [this.maxView, 4096]]) if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('invalid HotStuff resource bound');
    if (options.waitMs !== undefined && (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0)) throw new TypeError('invalid HotStuff lock wait');
    this.key = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
    const member = this.roster.validators.find(member => member.id === options.validatorId);
    if (!member || this.key.type !== 'private' || enrollValidator(member.id, member.family, member.role, this.key).publicKey !== member.publicKey) throw new TypeError('unenrolled HotStuff private key');
    this.options = { ...options };
    this.genesisBlock = domainDigest('aether.hotstuff-genesis/1', { roster: this.rosterId, manifest: options.genesisManifest });
    this.context = domainDigest(PROFILE, { roster: this.rosterId, genesis: this.genesisBlock, clockDomain: options.clockDomain, initialTimeoutNs: String(options.initialTimeoutNs) });
    ensure(options.directory); ensure(join(options.directory, 'lock')); this.lock = new JournalLock({ directory: join(options.directory, 'lock'), domain: 'aether.hotstuff-node', maxTickets: 100_000 });
    this.runLocked(() => this.initialize());
  }
  leader(view: string): string { this.view(view); return this.roster.validators[Number((BigInt(view) - 1n) % BigInt(this.roster.validators.length))].id; }
  private view(value: string): void { decimal(value); if (BigInt(value) < 1n || BigInt(value) > BigInt(this.maxView)) throw new RangeError('HotStuff view limit'); }
  private now(): bigint { const time = this.options.clock(); if (typeof time !== 'bigint' || time < 0n) throw new TypeError('invalid HotStuff monotonic clock'); decimal(String(time)); return time; }
  private deadline(core: Core): bigint { return core.started + this.options.initialTimeoutNs * (1n << (BigInt(core.view) - 1n)); }
  private initial(started: string): Core { decimal(started); return { view: '1', started: BigInt(started), clock: BigInt(started), phase: 'prepare', highQC: null, entryQC: null, lockedQC: null, decidedHead: this.genesisBlock, blocks: new Map(), votes: new Map(), reports: [], ownReports: new Map(), proposals: new Map(), decisions: [] }; }
  private path(name: string): string { return join(this.options.directory, name); }
  private publish(name: string, value: unknown, hooks = false): void {
    const file = this.path(name), temp = this.path(`.node-${process.pid}-${randomUUID()}`), bytes = encodeCanonical(value, LIMITS), fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { if (hooks) this.options.fault?.('before-state-publish'); renameSync(temp, file); sync(this.options.directory); if (hooks) this.options.fault?.('after-state-publish'); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private initialize(): void {
    const seal = existsSync(this.path('initialized.json')), state = existsSync(this.path('state.json')), marker = existsSync(this.path('initializing.json'));
    const identity = { format: 'aether.hotstuff-initialization/1', context: this.context, validator: this.options.validatorId };
    for (const file of ['initialized.json', 'initializing.json']) if (existsSync(this.path(file)) && !same(decodeCanonical(readFileSync(this.path(file)), LIMITS), identity)) throw new Error('HotStuff initialization identity mismatch');
    if (seal) { if (!state) throw new Error('missing established HotStuff vote state'); this.read(); if (marker) { unlinkSync(this.path('initializing.json')); sync(this.options.directory); } return; }
    if (state && !marker) throw new Error('missing HotStuff completion receipt; explicit recovery required');
    if (!marker) this.publish('initializing.json', identity);
    if (!state) this.save({ format: 'aether.hotstuff-journal/1', context: this.context, validator: this.options.validatorId, started: String(this.now()), events: [] }, false);
    else if (this.read().journal.events.length) throw new Error('initialization cannot reset nonempty HotStuff history');
    this.publish('initialized.json', identity); unlinkSync(this.path('initializing.json')); sync(this.options.directory);
  }
  private save(journal: Journal, hooks = true): void { this.publish('state.json', { journal, checksum: domainDigest('aether.hotstuff-state/1', journal, LIMITS) }, hooks); }
  private read(): { journal: Journal; core: Core } {
    if (statSync(this.path('state.json')).size > LIMITS.maxFrameBytes) throw new RangeError('HotStuff journal byte limit');
    const record = exactObject(decodeCanonical(readFileSync(this.path('state.json')), LIMITS), ['journal', 'checksum']), journal = exactObject(record.journal, ['format', 'context', 'validator', 'started', 'events']) as unknown as Journal;
    if (record.checksum !== domainDigest('aether.hotstuff-state/1', journal, LIMITS) || journal.format !== 'aether.hotstuff-journal/1' || journal.context !== this.context || journal.validator !== this.options.validatorId || !Array.isArray(journal.events) || journal.events.length > this.maxEvents) throw new TypeError('corrupt or mismatched HotStuff journal');
    const core = this.initial(journal.started);
    for (const event of journal.events) { exactObject(event, ['input', 'output', 'at']); decimal(event.at); this.apply(core, event.input, BigInt(event.at), event.output, true); }
    return { journal, core };
  }
  private runLocked<T>(operation: () => T): T { this.lock.recoverDeadWriter(false); return this.lock.run(operation, this.options.waitMs ?? 10_000); }
  private messageBytes(body: unknown, signer: string): Uint8Array { return encodeCanonical({ domain: 'aether.hotstuff-message-signature/1', body, signer }, LIMITS); }
  private signature(value: unknown): void {
    const signed = exactObject(value, ['body', 'signer', 'signature']), member = this.roster.validators.find(member => member.id === signed.signer);
    if (!member || typeof signed.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signed.signature)) throw new TypeError('unauthenticated HotStuff message');
    const bytes = Buffer.from(signed.signature, 'base64');
    if (bytes.toString('base64') !== signed.signature || !verify(null, this.messageBytes(signed.body, member.id), createPublicKey({ key: Buffer.from(member.publicKey, 'base64'), format: 'der', type: 'spki' }), bytes)) throw new TypeError('unauthenticated HotStuff message');
  }
  private signed<T extends NewViewBodyV1 | LeaderBodyV1>(body: T): { body: T; signer: string; signature: string } { return { body, signer: this.options.validatorId, signature: sign(null, this.messageBytes(body, this.options.validatorId), this.key).toString('base64') }; }
  private block(core: Core, value: HotStuffBlockV1): void {
    exactObject(value, ['format', 'id', 'parent', 'proposal']); validatePromotionProposal(value.proposal); validateDigest(value.parent);
    if (value.format !== 'aether.hotstuff-block/1' || value.id !== quorumBlockDigest(this.rosterId, value.parent, promotionDigest(value.proposal)) || value.proposal.repositoryId !== this.roster.repositoryId || value.proposal.membershipEpoch !== this.roster.membershipEpoch || value.proposal.policyEpoch !== this.roster.policyEpoch) throw new TypeError('foreign or corrupt HotStuff block');
    if (value.parent !== this.genesisBlock && !core.blocks.has(value.parent)) throw new TypeError('missing HotStuff ancestry; synchronize parents first');
    const expectedParent = value.parent === this.genesisBlock ? this.options.genesisManifest : core.blocks.get(value.parent)!.proposal.candidateManifest;
    if (value.proposal.expectedParent !== expectedParent) throw new TypeError('HotStuff block skips or rewrites its production parent root');
    const prior = core.blocks.get(value.id); if (prior && !same(prior, value)) throw new TypeError('HotStuff block address conflict');
    if (!prior && core.blocks.size >= this.maxBlocks) throw new RangeError('HotStuff block capacity'); core.blocks.set(value.id, clone(value));
  }
  private extends(core: Core, child: Digest, ancestor: Digest): boolean {
    for (let remaining = this.maxBlocks + 1; remaining > 0; remaining--) { if (child === ancestor) return true; if (child === this.genesisBlock) return false; const block = core.blocks.get(child); if (!block) throw new TypeError('missing HotStuff ancestry'); child = block.parent; }
    throw new TypeError('cyclic or oversized HotStuff ancestry');
  }
  private qc(core: Core, value: QuorumCertificateV1, phase?: QuorumVoteBodyV1['phase'], view?: string): void {
    if (!verifyQuorumCertificate(value, this.roster) || phase && value.body.phase !== phase || view && value.body.view !== view) throw new TypeError('invalid HotStuff phase/view certificate');
    const block = core.blocks.get(value.body.block);
    if (!block || block.parent !== value.body.parentBlock || !verifyQuorumCertificate(value, this.roster, block.proposal)) throw new TypeError('certificate lacks exact known block/proposal ancestry');
    this.view(value.body.view);
  }
  private report(core: Core, value: SignedNewViewV1, target?: string): void {
    this.signature(value); exactObject(value.body, ['format', 'context', 'targetView', 'highQC']); this.view(value.body.targetView);
    if (value.body.format !== 'aether.hotstuff-new-view/1' || value.body.context !== this.context || target && value.body.targetView !== target) throw new TypeError('stale or foreign new-view report');
    if (value.body.highQC !== null) { this.qc(core, value.body.highQC, 'prepare'); if (BigInt(value.body.highQC.body.view) >= BigInt(value.body.targetView)) throw new TypeError('new-view report contains future QC'); }
  }
  private highQC(core: Core, reports: readonly SignedNewViewV1[], target: string): QuorumCertificateV1 | null {
    if (!Array.isArray(reports) || reports.length > this.roster.validators.length) throw new TypeError('invalid new-view quorum size');
    const signers = new Set<string>(); let high: QuorumCertificateV1 | null = null;
    for (const report of reports) { this.report(core, report, target); if (signers.has(report.signer)) throw new TypeError('duplicate new-view signer'); signers.add(report.signer); const qc = report.body.highQC;
      if (qc && high && qc.body.view === high.body.view && qc.body.block !== high.body.block) throw new TypeError('conflicting equal-view prepare certificates');
      if (qc && (!high || BigInt(qc.body.view) > BigInt(high.body.view) || qc.body.view === high.body.view && qc.id < high.id)) high = qc;
    }
    if (signers.size < this.roster.validators.length - this.roster.faultBound) throw new Error('new-view quorum unavailable');
    return high;
  }
  private eligibleReports(core: Core): SignedNewViewV1[] {
    const groups = new Map<string, SignedNewViewV1[]>(); for (const report of core.reports) if (report.body.targetView === core.view) groups.set(report.signer, [...(groups.get(report.signer) ?? []), report]);
    return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : 1).filter(([, reports]) => new Set(reports.map(report => report.body.highQC ? `${report.body.highQC.body.view}/${report.body.highQC.body.block}` : 'genesis')).size === 1).map(([, reports]) => reports[0]);
  }
  private message(core: Core, value: SignedLeaderMessageV1): void {
    this.signature(value); const body = value.body;
    exactObject(body, body.phase === 'prepare' ? ['format', 'context', 'view', 'phase', 'block', 'highQC', 'reports'] : ['format', 'context', 'view', 'phase', 'qc']); this.view(body.view);
    if (body.format !== 'aether.hotstuff-leader/1' || body.context !== this.context || value.signer !== this.leader(body.view) || body.view !== core.view) throw new TypeError('stale or unauthenticated leader/view');
    if (body.phase === 'prepare') {
      this.block(core, body.block); const high = this.highQC(core, body.reports, body.view);
      if (!same(high, body.highQC) || body.block.parent !== (high?.body.block ?? this.genesisBlock)) throw new TypeError('leader did not extend the highest new-view prepare certificate');
    } else if (['precommit', 'commit', 'decide'].includes(body.phase)) this.qc(core, body.qc, body.phase === 'precommit' ? 'prepare' : body.phase === 'commit' ? 'precommit' : 'commit', body.view);
    else throw new TypeError('invalid HotStuff leader phase');
  }
  private application(proposal: PromotionProposalV1, replay: boolean): void { if (!replay && this.options.validateProposal(freeze(clone(proposal))) !== true) throw new Error('HotStuff application rejected proposal'); }
  private apply(core: Core, input: Input, now: bigint, retained: Output | undefined, replay: boolean): Output {
    if (now < core.clock) throw new Error('HotStuff monotonic clock moved backwards'); core.clock = now;
    const output = (value: Output): Output => { if (replay && !same(value, retained)) throw new TypeError('persisted HotStuff output violates state-machine rules'); return value; };
    const signed = (body: NewViewBodyV1 | LeaderBodyV1): SignedNewViewV1 | SignedLeaderMessageV1 => {
      if (replay) { this.signature(retained); const value = retained as SignedLeaderMessageV1; if (value.signer !== this.options.validatorId || !same(value.body, body)) throw new TypeError('persisted HotStuff signed response mismatch'); return value; }
      return this.signed(body) as SignedNewViewV1 | SignedLeaderMessageV1;
    };
    const vote = (body: QuorumVoteBodyV1): SignedQuorumVoteV1 => {
      const key = `${core.view}/${body.phase}`, prior = core.votes.get(key); if (prior && !same(prior.body, body)) throw new Error('honest validator refuses double vote');
      const value = prior ?? (replay ? retained as SignedQuorumVoteV1 : signQuorumVote(body, this.options.validatorId, this.key, this.roster));
      if (!verifyQuorumVote(value, this.roster) || value.signer !== this.options.validatorId || !same(value.body, body)) throw new TypeError('invalid persisted honest vote'); core.votes.set(key, value); return value;
    };
    switch (input.kind) {
      case 'blocks': exactObject(input, ['kind', 'blocks']); if (!Array.isArray(input.blocks) || input.blocks.length > this.maxBlocks) throw new RangeError('HotStuff block batch limit'); input.blocks.forEach(block => this.block(core, block)); return output(null);
      case 'report': {
        exactObject(input, ['kind']); const prior = core.ownReports.get(core.view); const value = prior ?? signed({ format: 'aether.hotstuff-new-view/1', context: this.context, targetView: core.view, highQC: core.entryQC }) as SignedNewViewV1;
        core.ownReports.set(core.view, value); return output(value);
      }
      case 'new-view': exactObject(input, ['kind', 'report']); this.report(core, input.report, core.view); if (!core.reports.some(report => same(report, input.report))) core.reports.push(clone(input.report)); return output(null);
      case 'timeout': exactObject(input, ['kind', 'expectedView']); if (input.expectedView !== core.view || now < this.deadline(core)) throw new Error('HotStuff timeout is stale or not due'); this.view(String(BigInt(core.view) + 1n)); core.view = String(BigInt(core.view) + 1n); core.entryQC = core.highQC; core.started = now; core.phase = 'prepare'; return output(null);
      case 'propose': {
        exactObject(input, ['kind', 'proposal']); if (this.leader(core.view) !== this.options.validatorId) throw new Error('only the current leader may propose'); this.application(input.proposal, replay);
        const reports = this.eligibleReports(core), highQC = this.highQC(core, reports, core.view), parent = highQC?.body.block ?? this.genesisBlock;
        const block: HotStuffBlockV1 = { format: 'aether.hotstuff-block/1', id: quorumBlockDigest(this.rosterId, parent, promotionDigest(input.proposal)), parent, proposal: input.proposal }; this.block(core, block);
        const body: LeaderBodyV1 = { format: 'aether.hotstuff-leader/1', context: this.context, view: core.view, phase: 'prepare', block, highQC, reports }, prior = core.proposals.get(core.view);
        if (prior && prior.body.phase === 'prepare' && prior.body.block.id !== block.id) throw new Error('honest leader refuses proposal equivocation');
        const value = prior ?? signed(body) as SignedLeaderMessageV1; core.proposals.set(core.view, value); return output(value);
      }
      case 'leader-phase': {
        exactObject(input, ['kind', 'phase', 'qc']); if (this.leader(core.view) !== this.options.validatorId || !['precommit', 'commit', 'decide'].includes(input.phase)) throw new Error('invalid phase leader');
        const body: LeaderBodyV1 = { format: 'aether.hotstuff-leader/1', context: this.context, view: core.view, phase: input.phase, qc: input.qc };
        this.qc(core, input.qc, input.phase === 'precommit' ? 'prepare' : input.phase === 'commit' ? 'precommit' : 'commit', core.view);
        const proposal = core.proposals.get(core.view); if (proposal?.body.phase !== 'prepare' || proposal.body.block.id !== input.qc.body.block) throw new Error('phase certificate differs from leader proposal');
        return output(signed(body));
      }
      case 'receive': {
        exactObject(input, ['kind', 'message']); this.message(core, input.message); const body = input.message.body;
        if (body.phase === 'prepare') {
          this.application(body.block.proposal, replay);
          if (!this.extends(core, body.block.id, core.decidedHead) || core.lockedQC && !this.extends(core, body.block.id, core.lockedQC.body.block) && BigInt(body.highQC?.body.view ?? '0') <= BigInt(core.lockedQC.body.view)) throw new Error('HotStuff safe-node lock rejects conflicting proposal');
          const value = vote(quorumVoteBody(this.roster, body.block.proposal, core.view, 'prepare', body.block.parent)); if (core.phase === 'prepare') core.phase = 'precommit'; return output(value);
        }
        const qc = body.qc, preceding = body.phase === 'precommit' ? 'prepare' : body.phase === 'commit' ? 'precommit' : 'commit', prior = core.votes.get(`${core.view}/${preceding}`);
        if (!prior || prior.body.block !== qc.body.block || prior.body.proposal !== qc.body.proposal) throw new Error('HotStuff phase requires the matching prior local vote');
        if (body.phase === 'precommit') { core.highQC = qc; if (core.phase !== 'decide') core.phase = 'commit'; return output(vote({ ...qc.body, phase: 'precommit' })); }
        if (body.phase === 'commit') { core.lockedQC = qc; core.phase = 'decide'; return output(vote({ ...qc.body, phase: 'commit' })); }
        if (!this.extends(core, qc.body.block, core.decidedHead)) throw new Error('HotStuff cannot decide a conflicting branch');
        const blocks: HotStuffBlockV1[] = []; let cursor = qc.body.block;
        while (cursor !== core.decidedHead) { const block = core.blocks.get(cursor)!; blocks.unshift(block); cursor = block.parent; }
        const decision = { certificate: qc, blocks }; this.view(String(BigInt(core.view) + 1n)); core.decisions.push(decision); core.decidedHead = qc.body.block; core.view = String(BigInt(core.view) + 1n); core.entryQC = core.highQC; core.phase = 'prepare'; core.started = now; return output(decision);
      }
      default: throw new TypeError('unknown HotStuff state transition');
    }
  }
  private command(input: Input): Output {
    input = clone(input);
    return this.runLocked(() => {
      const { journal, core } = this.read();
      // Retrying the identical received envelope is an outbox retransmission,
      // never a newly signed vote. Locally generated commands are view-scoped.
      if (input.kind === 'receive' || input.kind === 'new-view' || input.kind === 'blocks') { const prior = journal.events.find(event => same(event.input, input)); if (prior) return clone(prior.output); }
      if (journal.events.length >= this.maxEvents) throw new RangeError('HotStuff transition capacity');
      const now = this.now(), value = this.apply(core, input, now, undefined, false);
      this.save({ ...journal, events: [...journal.events, { input, output: value, at: String(now) }] }); return clone(value);
    });
  }
  ingestBlocks(blocks: readonly HotStuffBlockV1[]): void { this.command({ kind: 'blocks', blocks }); }
  newView(): SignedNewViewV1 { return this.command({ kind: 'report' }) as SignedNewViewV1; }
  receiveNewView(report: SignedNewViewV1): void { this.command({ kind: 'new-view', report }); }
  propose(proposal: PromotionProposalV1): SignedLeaderMessageV1 { return this.command({ kind: 'propose', proposal }) as SignedLeaderMessageV1; }
  phaseMessage(phase: 'precommit' | 'commit' | 'decide', qc: QuorumCertificateV1): SignedLeaderMessageV1 { return this.command({ kind: 'leader-phase', phase, qc }) as SignedLeaderMessageV1; }
  receivePrepare(message: SignedLeaderMessageV1): SignedQuorumVoteV1 { if (message.body.phase !== 'prepare') throw new TypeError('prepare message required'); return this.command({ kind: 'receive', message }) as SignedQuorumVoteV1; }
  receivePrecommit(message: SignedLeaderMessageV1): SignedQuorumVoteV1 { if (message.body.phase !== 'precommit') throw new TypeError('precommit message required'); return this.command({ kind: 'receive', message }) as SignedQuorumVoteV1; }
  receiveCommit(message: SignedLeaderMessageV1): SignedQuorumVoteV1 { if (message.body.phase !== 'commit') throw new TypeError('commit message required'); return this.command({ kind: 'receive', message }) as SignedQuorumVoteV1; }
  receiveDecide(message: SignedLeaderMessageV1): HotStuffDecision { if (message.body.phase !== 'decide') throw new TypeError('decide message required'); return this.command({ kind: 'receive', message }) as HotStuffDecision; }
  timeout(expectedView: string): void { this.command({ kind: 'timeout', expectedView }); }
  /** Immutable, already persisted transmissions for retry after process death.
   * Reading the outbox does not sign again or advance any phase/view. */
  outbox(): readonly (SignedNewViewV1 | SignedLeaderMessageV1 | SignedQuorumVoteV1)[] {
    const { journal } = this.read(), messages: (SignedNewViewV1 | SignedLeaderMessageV1 | SignedQuorumVoteV1)[] = [], ids = new Set<Digest>();
    for (const event of journal.events) if (event.output && 'signature' in event.output) { const id = domainDigest('aether.hotstuff-outbox/1', event.output, LIMITS); if (!ids.has(id)) { ids.add(id); messages.push(clone(event.output)); } }
    return messages;
  }
  status(): HotStuffStatus { const { core } = this.read(); return clone({ view: core.view, leader: this.leader(core.view), phase: core.phase, highQC: core.highQC, lockedQC: core.lockedQC, decidedHead: core.decidedHead, deadline: String(this.deadline(core)), votes: [...core.votes.values()], decisions: core.decisions }); }
  newViewEquivocations(): readonly { signer: string; targetView: string; reports: readonly SignedNewViewV1[] }[] {
    const { core } = this.read(), groups = new Map<string, SignedNewViewV1[]>();
    for (const report of core.reports) { const key = `${report.signer}/${report.body.targetView}`; groups.set(key, [...(groups.get(key) ?? []), report]); }
    return [...groups.values()].filter(reports => new Set(reports.map(report => report.body.highQC ? `${report.body.highQC.body.view}/${report.body.highQC.body.block}` : 'genesis')).size > 1).map(reports => ({ signer: reports[0].signer, targetView: reports[0].body.targetView, reports: clone(reports) }));
  }
}
