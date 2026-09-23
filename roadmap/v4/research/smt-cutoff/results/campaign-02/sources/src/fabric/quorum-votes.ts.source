/** Durable vote admission and equivocation evidence for the T2-06 quorum.
 *
 * This journal does not implement HotStuff's honest voting, locks, view changes
 * or membership handoff. It only prevents a stored equivocation from being
 * counted twice (or at all) in a local certificate candidate.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCanonical, encodeCanonical, exactObject } from './encoding.ts';
import { domainDigest, type Digest } from './identity.ts';
import { JournalLock } from './journal-lock.ts';
import { assembleQuorumCertificate, quorumRosterDigest, verifyQuorumVote, type QuorumCertificateV1, type QuorumRosterV1, type QuorumVoteBodyV1, type SignedQuorumVoteV1 } from './quorum-crypto.ts';

interface JournalState {
  readonly format: 'aether.quorum-votes/1'; readonly roster: Digest;
  readonly revision: number; readonly votes: readonly SignedQuorumVoteV1[];
}
export interface QuorumVoteJournalOptions { readonly directory: string; readonly roster: QuorumRosterV1; readonly maxVotes?: number; readonly waitMs?: number }
export interface QuorumEquivocation { readonly signer: string; readonly view: string; readonly phase: QuorumVoteBodyV1['phase']; readonly votes: readonly SignedQuorumVoteV1[] }
const LIMITS = { maxFrameBytes: 8 * 1024 * 1024, maxDecompressedBytes: 8 * 1024 * 1024, maxObjects: 100_000, maxDepth: 64 };
const voteId = (vote: SignedQuorumVoteV1): Digest => domainDigest('aether.quorum-signed-vote/1', vote, LIMITS);
const same = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a, LIMITS)).equals(Buffer.from(encodeCanonical(b, LIMITS)));
const slot = (vote: SignedQuorumVoteV1): string => JSON.stringify([vote.signer, vote.body.view, vote.body.phase]);
function sync(directory: string): void { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

export class QuorumVoteJournal {
  private readonly options: QuorumVoteJournalOptions;
  private readonly lock: JournalLock;
  private readonly roster: QuorumRosterV1;
  private readonly rosterDigest: Digest;
  private readonly maxVotes: number;
  private readonly waitMs: number;
  constructor(options: QuorumVoteJournalOptions) {
    this.rosterDigest = quorumRosterDigest(options.roster);
    this.roster = decodeCanonical(encodeCanonical(options.roster)) as unknown as QuorumRosterV1;
    this.options = options; this.maxVotes = options.maxVotes ?? 10_000; this.waitMs = options.waitMs ?? 10_000;
    if (!Number.isSafeInteger(this.maxVotes) || this.maxVotes < 1 || this.maxVotes > 100_000 || !Number.isSafeInteger(this.waitMs) || this.waitMs < 0) throw new TypeError('invalid quorum vote journal limits');
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const lockDirectory = join(options.directory, 'lock'); mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    this.lock = new JournalLock({ directory: lockDirectory, domain: 'aether.quorum-votes', maxTickets: 100_000 });
    this.run(() => this.initialize());
  }
  private statePath(): string { return join(this.options.directory, 'votes.json'); }
  private sealPath(): string { return join(this.options.directory, 'initialized.json'); }
  private markerPath(): string { return join(this.options.directory, 'initializing.json'); }
  private publish(path: string, value: unknown): void {
    const temporary = join(this.options.directory, `.quorum-${process.pid}-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, encodeCanonical(value, LIMITS)); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, path); sync(this.options.directory); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private validate(state: unknown): asserts state is JournalState {
    const record = exactObject(state, ['format', 'roster', 'revision', 'votes']);
    if (record.format !== 'aether.quorum-votes/1' || record.roster !== this.rosterDigest || !Array.isArray(record.votes) || record.votes.length > this.maxVotes || record.revision !== record.votes.length) throw new TypeError('quorum vote journal profile/revision mismatch');
    const ids = new Set<Digest>();
    for (const vote of record.votes) {
      if (!verifyQuorumVote(vote, this.roster)) throw new TypeError('invalid persisted quorum vote');
      const id = voteId(vote); if (ids.has(id)) throw new TypeError('duplicate persisted quorum vote'); ids.add(id);
    }
  }
  private read(): JournalState {
    if (statSync(this.statePath()).size > LIMITS.maxFrameBytes) throw new RangeError('quorum vote journal byte limit');
    const record = exactObject(decodeCanonical(readFileSync(this.statePath()), LIMITS), ['format', 'state', 'checksum']);
    if (record.format !== 'aether.quorum-votes-record/1' || record.checksum !== domainDigest('aether.quorum-votes-record/1', record.state, LIMITS)) throw new TypeError('corrupt quorum vote journal');
    this.validate(record.state); return record.state;
  }
  private save(state: JournalState): void {
    this.validate(state);
    this.publish(this.statePath(), { format: 'aether.quorum-votes-record/1', state, checksum: domainDigest('aether.quorum-votes-record/1', state, LIMITS) });
  }
  private initialize(): void {
    const sealed = existsSync(this.sealPath()), state = existsSync(this.statePath()), marker = existsSync(this.markerPath());
    const empty: JournalState = { format: 'aether.quorum-votes/1', roster: this.rosterDigest, revision: 0, votes: [] };
    if (marker) {
      const record = exactObject(decodeCanonical(readFileSync(this.markerPath())), ['format', 'roster']);
      if (record.format !== 'aether.quorum-votes-initializing/1' || record.roster !== this.rosterDigest) throw new TypeError('quorum vote initialization marker mismatch');
    }
    if (sealed) {
      const record = exactObject(decodeCanonical(readFileSync(this.sealPath())), ['format', 'roster']);
      if (record.format !== 'aether.quorum-votes-initialized/1' || record.roster !== this.rosterDigest || !state) throw new TypeError('quorum vote initialization receipt mismatch');
      this.read(); if (marker) this.clearMarker(); return;
    }
    if (state && !marker) throw new Error('missing quorum vote completion receipt; explicit recovery required');
    if (!marker) this.publish(this.markerPath(), { format: 'aether.quorum-votes-initializing/1', roster: this.rosterDigest });
    if (!state) this.save(empty); else if (!same(this.read(), empty)) throw new Error('quorum vote initialization cannot reset nonempty journal');
    this.publish(this.sealPath(), { format: 'aether.quorum-votes-initialized/1', roster: this.rosterDigest }); this.clearMarker();
  }
  private clearMarker(): void { unlinkSync(this.markerPath()); sync(this.options.directory); }
  private run<T>(operation: () => T): T { this.lock.recoverDeadWriter(false); return this.lock.run(operation, this.waitMs); }
  ingest(value: SignedQuorumVoteV1): Digest {
    if (!verifyQuorumVote(value, this.roster)) throw new TypeError('invalid or foreign quorum vote');
    const vote = decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as unknown as SignedQuorumVoteV1, id = voteId(vote);
    return this.run(() => {
      const state = this.read(); if (state.votes.some(prior => voteId(prior) === id)) return id;
      if (state.votes.length >= this.maxVotes) throw new RangeError('quorum vote journal capacity');
      this.save({ ...state, revision: state.revision + 1, votes: [...state.votes, vote] }); return id;
    });
  }
  votes(): readonly SignedQuorumVoteV1[] { return this.read().votes; }
  equivocations(): readonly QuorumEquivocation[] {
    const grouped = new Map<string, SignedQuorumVoteV1[]>();
    for (const vote of this.read().votes) grouped.set(slot(vote), [...(grouped.get(slot(vote)) ?? []), vote]);
    return [...grouped.values()].filter(votes => new Set(votes.map(vote => vote.body.block)).size > 1)
      .map(votes => ({ signer: votes[0].signer, view: votes[0].body.view, phase: votes[0].body.phase, votes }));
  }
  certificateFor(body: QuorumVoteBodyV1): QuorumCertificateV1 | null {
    const votes = this.read().votes, bySlot = new Map<string, Set<string>>();
    for (const vote of votes) {
      const key = slot(vote), blocks = bySlot.get(key) ?? new Set<string>(); blocks.add(vote.body.block); bySlot.set(key, blocks);
    }
    const eligible = votes.filter(vote => bySlot.get(slot(vote))?.size === 1 && same(vote.body, body));
    if (eligible.length < this.roster.validators.length - this.roster.faultBound) return null;
    return assembleQuorumCertificate(body, eligible, this.roster);
  }
}
