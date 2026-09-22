/** R01 finite research model. No sockets, production votes, cryptography or timing claims. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export interface TreeOp {
  readonly id: string;
  readonly clock: number;
  readonly dependencies: readonly string[];
  readonly kind: 'insert' | 'move' | 'delete' | 'replace';
  readonly occurrence: string;
  readonly parent: string;
  readonly anchor: string | null;
  readonly content: string;
}
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const order = (a: TreeOp, b: TreeOp): number => a.clock - b.clock || lexical(a.id, b.id);
const body = (op: TreeOp): string => JSON.stringify([op.id, op.clock, [...op.dependencies].sort(), op.kind, op.occurrence, op.parent, op.anchor, op.content]);
export function joinOperations(...sets: readonly (readonly TreeOp[])[]): TreeOp[] {
  const variants = new Map<string, TreeOp>();
  for (const set of sets) for (const op of set) variants.set(body(op), op);
  return [...variants.values()].sort((a, b) => order(a, b) || lexical(body(a), body(b)));
}
export interface TreeProjection {
  readonly parents: Readonly<Record<string, string>>;
  readonly contents: Readonly<Record<string, string>>;
  readonly visible: readonly string[];
  readonly childOrder: Readonly<Record<string, readonly string[]>>;
  readonly suppressed: readonly string[];
  readonly quarantined: readonly string[];
  readonly pending: readonly string[];
}
/** Sequential specification over a union of operation variants. Recompute after equivocation. */
export function projectTree(operations: readonly TreeOp[]): TreeProjection {
  const union = joinOperations(operations);
  const groups = new Map<string, TreeOp[]>();
  for (const op of union) groups.set(op.id, [...(groups.get(op.id) ?? []), op]);
  const quarantined = new Set([...groups].filter(([, variants]) => variants.length !== 1).map(([id]) => id));
  const accepted = new Set<string>(); const pending = new Set<string>();
  const parents: Record<string, string> = {}; const contents: Record<string, string> = {};
  const currentPlacement = new Map<string, string>();
  const placements = new Map<string, TreeOp>(); const suppressed: string[] = [];
  for (const op of union) {
    if (quarantined.has(op.id)) continue;
    if (!Number.isSafeInteger(op.clock) || op.clock < 1 || op.occurrence === 'root' || op.occurrence === 'trash') { quarantined.add(op.id); continue; }
    if (op.dependencies.some(id => quarantined.has(id))) { quarantined.add(op.id); continue; }
    if (op.dependencies.some(id => !accepted.has(id))) { pending.add(op.id); continue; }
    accepted.add(op.id);
    if (op.kind === 'replace') {
      if (!Object.hasOwn(contents, op.occurrence)) suppressed.push(`${op.id}:missing-occurrence`);
      else contents[op.occurrence] = op.content;
      continue;
    }
    if (op.kind === 'insert' && Object.hasOwn(contents, op.occurrence)) { suppressed.push(`${op.id}:duplicate-creation`); continue; }
    if (op.kind !== 'insert' && !Object.hasOwn(contents, op.occurrence)) { suppressed.push(`${op.id}:missing-occurrence`); continue; }
    const parent = op.kind === 'delete' ? 'trash' : op.parent;
    if (!['root', 'trash'].includes(parent) && !Object.hasOwn(contents, parent)) { suppressed.push(`${op.id}:missing-parent`); continue; }
    if (op.kind !== 'delete' && op.anchor !== null) {
      const anchor = placements.get(op.anchor);
      if (!anchor || anchor.parent !== parent || !op.dependencies.includes(op.anchor)) { suppressed.push(`${op.id}:invalid-anchor`); continue; }
    }
    let cursor: string | undefined = parent; let cycle = false;
    while (cursor !== undefined) { if (cursor === op.occurrence) { cycle = true; break; } cursor = parents[cursor]; }
    if (cycle) { suppressed.push(`${op.id}:cycle`); continue; }
    if (op.kind === 'insert') contents[op.occurrence] = op.content;
    parents[op.occurrence] = parent;
    const placement = { ...op, parent, anchor: op.kind === 'delete' ? null : op.anchor };
    placements.set(op.id, placement); currentPlacement.set(op.occurrence, op.id);
  }
  const childOrder: Record<string, string[]> = {};
  for (const parent of ['root', 'trash', ...Object.keys(contents)].sort()) {
    const children: string[] = [];
    const emit = (anchor: string | null): void => {
      // RGA placements remain ordering anchors even after the occurrence moves away.
      const next = [...placements.values()].filter(p => p.parent === parent && p.anchor === anchor).sort((a, b) => order(b, a));
      for (const placement of next) {
        if (currentPlacement.get(placement.occurrence) === placement.id) children.push(placement.occurrence);
        emit(placement.id);
      }
    };
    emit(null); childOrder[parent] = children;
  }
  const visible: string[] = [];
  const visit = (parent: string): void => { for (const child of childOrder[parent] ?? []) { visible.push(child); visit(child); } };
  visit('root');
  const sorted = <T>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a < b ? -1 : 1));
  return { parents: sorted(parents), contents: sorted(contents), visible, childOrder: sorted(childOrder), suppressed: suppressed.sort(), quarantined: [...quarantined].sort(), pending: [...pending].sort() };
}
export function assertTreeInvariant(tree: TreeProjection): void {
  for (const occurrence of Object.keys(tree.parents)) {
    const seen = new Set<string>(); let cursor: string | undefined = occurrence;
    while (cursor !== undefined) { assert(!seen.has(cursor), 'cycle'); seen.add(cursor); cursor = tree.parents[cursor]; }
  }
  const placed = Object.values(tree.childOrder).flat();
  assert.equal(placed.length, new Set(placed).size, 'one placement per occurrence');
  assert.equal(placed.length, Object.keys(tree.contents).length, 'no lost occurrences, including trash');
}
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(tail => [item, ...tail]));
}
export function subsets<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  return [...subsets(items.slice(1), size - 1).map(tail => [items[0], ...tail]), ...subsets(items.slice(1), size)];
}

export type Phase = 'prepare' | 'precommit' | 'commit' | 'ready';
export interface Committee { epoch: number; f: number; members: readonly { id: string; family: string }[] }
export interface Vote { signer: string; epoch: number; view: number; phase: Phase; block: string }
export interface QC { epoch: number; view: number; phase: Phase; block: string; votes: readonly Vote[] }
export interface Block { id: string; parent: string | null; epoch: number; nextEpoch: number | null }
export function threshold(committee: Committee): number {
  if (committee.members.length !== 3 * committee.f + 1 || new Set(committee.members.map(m => m.id)).size !== committee.members.length) throw new Error('invalid committee');
  return 2 * committee.f + 1;
}
export function validQC(qc: QC, committee: Committee): boolean {
  const q = threshold(committee);
  if (qc.epoch !== committee.epoch || qc.votes.length < q || new Set(qc.votes.map(v => v.signer)).size !== qc.votes.length) return false;
  const families = new Set<string>();
  for (const vote of qc.votes) {
    const member = committee.members.find(m => m.id === vote.signer);
    if (!member || vote.epoch !== qc.epoch || vote.view !== qc.view || vote.phase !== qc.phase || vote.block !== qc.block) return false;
    families.add(member.family);
  }
  return families.size >= 2;
}
export class HotStuffModel {
  readonly blocks = new Map<string, Block>([['genesis', { id: 'genesis', parent: null, epoch: 0, nextEpoch: null }]]);
  readonly votes: Vote[] = [];
  readonly nodes: Map<string, { view: number; prepareQC: QC; lockedQC: QC; lastVotes: Map<string, string>; closedEpoch: boolean }>;
  readonly genesis: QC;
  readonly committee: Committee;
  constructor(committee: Committee) {
    this.committee = committee;
    threshold(committee);
    this.genesis = { epoch: committee.epoch, view: 0, phase: 'prepare', block: 'genesis', votes: [] };
    this.nodes = new Map(committee.members.map(member => [member.id, { view: 1, prepareQC: this.genesis, lockedQC: this.genesis, lastVotes: new Map(), closedEpoch: false }]));
  }
  addBlock(block: Block): void {
    assert(block.id !== 'genesis' && !this.blocks.has(block.id)); assert(block.parent !== null && this.blocks.has(block.parent));
    this.blocks.set(block.id, block);
  }
  private certificate(qc: QC): boolean {
    if (qc === this.genesis) return true;
    return validQC(qc, this.committee) && qc.votes.every(v => this.votes.some(record => JSON.stringify(record) === JSON.stringify(v)));
  }
  extends(block: string, ancestor: string): boolean {
    let current: string | null = block;
    while (current !== null) { if (current === ancestor) return true; current = this.blocks.get(current)?.parent ?? null; }
    return false;
  }
  advanceView(view: number): void { for (const node of this.nodes.values()) if (node.view < view) node.view = view; }
  newView(signers: readonly string[]): QC {
    if (new Set(signers).size < threshold(this.committee)) throw new Error('new-view quorum missing');
    const reports = signers.map(id => { const node = this.nodes.get(id); if (!node) throw new Error('unknown member'); return node.prepareQC; });
    return reports.sort((a, b) => b.view - a.view)[0];
  }
  vote(signer: string, phase: Exclude<Phase, 'ready'>, blockId: string, justify: QC): Vote | null {
    const node = this.nodes.get(signer)!; const block = this.blocks.get(blockId);
    if (!node || !block || block.epoch !== this.committee.epoch || node.closedEpoch || !this.certificate(justify)) return null;
    // A committed membership checkpoint is terminal in its old epoch.
    let ancestor = block.parent;
    while (ancestor !== null) { const prior = this.blocks.get(ancestor)!; if (prior.nextEpoch !== null && prior.epoch === block.epoch) return null; ancestor = prior.parent; }
    const key = `${node.view}:${phase}`;
    if (node.lastVotes.has(key)) return null;
    if (phase === 'prepare') {
      if (justify.phase !== 'prepare' || justify.view >= node.view || !this.extends(blockId, justify.block)) return null;
      if (!this.extends(blockId, node.lockedQC.block) && justify.view <= node.lockedQC.view) return null;
    } else {
      if (justify.view !== node.view || justify.block !== blockId || justify.phase !== (phase === 'precommit' ? 'prepare' : 'precommit')) return null;
      if (phase === 'precommit') node.prepareQC = justify;
      else node.lockedQC = justify;
    }
    node.lastVotes.set(key, blockId);
    const vote: Vote = { signer, epoch: this.committee.epoch, view: node.view, phase, block: blockId };
    this.votes.push(vote); return vote;
  }
  /** Byzantine senders may double-vote; authenticated identity and epoch remain fixed. */
  byzantineVote(signer: string, view: number, phase: Exclude<Phase, 'ready'>, block: string): Vote {
    assert(this.nodes.has(signer)); const vote = { signer, epoch: this.committee.epoch, view, phase, block }; this.votes.push(vote); return vote;
  }
  qc(view: number, phase: Exclude<Phase, 'ready'>, block: string): QC | null {
    const votes = [...new Map(this.votes.filter(v => v.view === view && v.phase === phase && v.block === block).map(v => [v.signer, v])).values()];
    const qc = { epoch: this.committee.epoch, view, phase, block, votes };
    return this.certificate(qc) ? qc : null;
  }
  decide(qc: QC, recipients: readonly string[] = [...this.nodes.keys()]): string {
    if (qc.phase !== 'commit' || !this.certificate(qc)) throw new Error('invalid decision certificate');
    const block = this.blocks.get(qc.block)!;
    if (block.nextEpoch !== null) for (const id of recipients) this.nodes.get(id)!.closedEpoch = true;
    return block.id;
  }
}

/** Old consensus commits a terminal checkpoint; new members separately certify its installed state. */
export function activateMembership(checkpoint: Block, oldCommit: QC, old: Committee, next: Committee, ready: QC): boolean {
  return checkpoint.epoch === old.epoch && checkpoint.nextEpoch === next.epoch && next.epoch === old.epoch + 1
    && oldCommit.block === checkpoint.id && oldCommit.phase === 'commit' && validQC(oldCommit, old)
    && ready.block === checkpoint.id && ready.phase === 'ready' && ready.view === 0 && validQC(ready, next);
}

export function runReplicationModel(): Record<string, number | string> {
  const create = (id: string, occurrence: string): TreeOp => ({ id, clock: 1, dependencies: [], kind: 'insert', occurrence, parent: 'root', anchor: null, content: occurrence });
  const a = create('A:1', 'a'), b = create('B:1', 'b'), c = create('C:1', 'c');
  const ab: TreeOp = { id: 'A:2', clock: 2, dependencies: [a.id,b.id], kind: 'move', occurrence: 'a', parent: 'b', anchor: null, content: '' };
  const ba: TreeOp = { ...ab, id: 'B:2', occurrence: 'b', parent: 'a' };
  const del: TreeOp = { ...ab, id: 'C:2', kind: 'delete', occurrence: 'a', parent: 'trash' };
  const replace: TreeOp = { ...ab, id: 'C:3', clock: 3, dependencies: [a.id,del.id], kind: 'replace', content: 'replaced' };
  const operations = [a,b,c,ab,ba,del,replace]; const expected = projectTree(operations);
  let deliverySchedules = 0;
  for (const schedule of permutations(operations)) {
    let replica: TreeOp[] = [];
    for (const operation of schedule) { replica = joinOperations(replica, [operation,operation]); assertTreeInvariant(projectTree(replica)); }
    assert.deepEqual(projectTree(replica), expected); deliverySchedules++;
  }
  let mergePartitions = 0;
  for (let split = 0; split < 1 << operations.length; split++) {
    const left = operations.filter((_, i) => (split & (1 << i)) !== 0); const right = operations.filter((_, i) => (split & (1 << i)) === 0);
    assert.deepEqual(projectTree(joinOperations(left,right)), expected);
    assert.deepEqual(joinOperations(left,right), joinOperations(right,left));
    assert.deepEqual(joinOperations(left,left), joinOperations(left));
    assert.deepEqual(joinOperations(joinOperations(left,right),[a]), joinOperations(left,joinOperations(right,[a]))); mergePartitions++;
  }
  const committee: Committee = { epoch: 1, f: 1, members: ['0','1','2','3'].map(id => ({ id, family: `family:${id}` })) };
  const quorums = subsets(committee.members.map(m => m.id), threshold(committee));
  let quorumPairs = 0;
  for (const left of quorums) for (const right of quorums) { assert(left.filter(id => right.includes(id)).length > committee.f); quorumPairs++; }
  // Every honest vote allocation to two conflicting proposals or abstention; Byzantine member 0 equivocates.
  let equivocationSchedules = 0;
  for (let assignment = 0; assignment < 27; assignment++) {
    const model = new HotStuffModel(committee);
    model.addBlock({ id: 'x', parent: 'genesis', epoch: 1, nextEpoch: null }); model.addBlock({ id: 'y', parent: 'genesis', epoch: 1, nextEpoch: null });
    model.byzantineVote('0',1,'prepare','x'); model.byzantineVote('0',1,'prepare','y');
    let digits = assignment;
    for (const id of ['1','2','3']) { const choice = digits % 3; digits = Math.floor(digits / 3); if (choice < 2) model.vote(id,'prepare',choice === 0 ? 'x' : 'y',model.genesis); }
    assert(!(model.qc(1,'prepare','x') && model.qc(1,'prepare','y'))); equivocationSchedules++;
  }
  return { kind: 'bounded-research-model', deliverySchedules, mergePartitions, quorumPairs, equivocationSchedules, maxTreeOperations: 7, committeeSize: 4, faultBound: 1 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(runReplicationModel(), null, 2));
