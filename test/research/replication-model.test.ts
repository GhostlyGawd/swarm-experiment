import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activateMembership, assertTreeInvariant, HotStuffModel, joinOperations, permutations, projectTree, runReplicationModel, subsets, validQC, type Block, type Committee, type QC, type TreeOp } from '../../roadmap/v4/research/replication-model.ts';

const committee: Committee = { epoch: 1, f: 1, members: ['0','1','2','3'].map(id => ({ id, family: `family:${id}` })) };
const signers = ['0','1','2'];
const create = (id: string, occurrence: string, content = occurrence): TreeOp => ({ id, clock: 1, dependencies: [], kind: 'insert', occurrence, parent: 'root', anchor: null, content });
const a = create('A:1','a'), b = create('B:1','b');
const move = (id: string, occurrence: string, parent: string): TreeOp => ({ id, clock: 2, dependencies: [a.id,b.id], kind: 'move', occurrence, parent, anchor: null, content: '' });
function certify(model: HotStuffModel, block: string, high = model.genesis, voters = signers): QC {
  const view = model.nodes.get(voters[0])!.view;
  for (const id of voters) assert(model.vote(id,'prepare',block,high));
  const prepare = model.qc(view,'prepare',block)!; assert(prepare);
  for (const id of voters) assert(model.vote(id,'precommit',block,prepare));
  const precommit = model.qc(view,'precommit',block)!; assert(precommit);
  for (const id of voters) assert(model.vote(id,'commit',block,precommit));
  const commit = model.qc(view,'commit',block)!; assert(commit); return commit;
}

test('R01 finite OpSet schedules, merge algebra and quorum/equivocation campaign', () => {
  assert.deepEqual(runReplicationModel(), {
    kind: 'bounded-research-model', deliverySchedules: 5040, mergePartitions: 128, quorumPairs: 16,
    equivocationSchedules: 27, maxTreeOperations: 7, committeeSize: 4, faultBound: 1,
  });
});

test('R01 cycles are suppressed, concurrent moves keep one occurrence, and content sharing does not alias occurrences', () => {
  const ops = [a,b,move('A:2','a','b'),move('B:2','b','a')];
  const tree = projectTree(ops); assertTreeInvariant(tree);
  assert.equal(tree.parents.a, 'b'); assert.equal(tree.parents.b, 'root'); assert.deepEqual(tree.suppressed, ['B:2:cycle']);
  const shared = projectTree([create('A:1','a','shared-ast'),create('B:1','b','shared-ast'),move('A:2','a','b')]);
  assert.equal(shared.contents.a, shared.contents.b); assert.notEqual(shared.parents.a, shared.parents.b);
  const duplicate = projectTree([a,b,move('A:2','a','b'),move('C:2','a','root')]);
  assert.equal(duplicate.parents.a,'root'); assert.equal(Object.keys(duplicate.contents).length,2); assertTreeInvariant(duplicate);
});

test('R01 trash deletion, concurrent replacement and restoration have explicit deterministic precedence', () => {
  const deletion: TreeOp = { ...move('Z:2','a','trash'), kind:'delete' };
  const replacement: TreeOp = { ...move('A:3','a','root'), clock:3, dependencies:[a.id,b.id,deletion.id], kind:'replace', content:'updated' };
  const hidden = projectTree([a,b,move('A:2','a','b'),deletion,replacement]);
  assert.equal(hidden.parents.a,'trash'); assert.equal(hidden.contents.a,'updated'); assert(!hidden.visible.includes('a'));
  const restore: TreeOp = { ...move('A:4','a','root'), clock:4, dependencies:[a.id,b.id,deletion.id,replacement.id] };
  const restored = projectTree([a,b,deletion,replacement,restore]);
  assert(restored.visible.includes('a')); assert.equal(restored.contents.a,'updated');
  const deleteParent: TreeOp = { ...move('Z:3','b','trash'), clock:3, kind:'delete' };
  const child = projectTree([a,b,move('A:2','a','b'),deleteParent]);
  assert.equal(child.parents.a,'b'); assert.equal(child.visible.length,0); assertTreeInvariant(child);
});

test('R01 immutable RGA placement anchors survive moves and concurrent insertion positions', () => {
  const second: TreeOp = { ...b, clock:2, dependencies:[a.id], anchor:a.id };
  const third: TreeOp = { ...create('C:1','c'), clock:2, dependencies:[a.id], anchor:a.id };
  const moved: TreeOp = { ...move('A:3','a','trash'), clock:3, dependencies:[a.id,second.id,third.id], kind:'delete' };
  const tree = projectTree([a,second,third,moved]); assertTreeInvariant(tree);
  assert.deepEqual(tree.childOrder.root,['c','b']); assert.deepEqual(tree.childOrder.trash,['a']);
  for (const order of permutations([a,second,third,moved])) assert.deepEqual(projectTree(order),tree);
});

test('R01 same-ID equivocation is retained and quarantines dependents independently of first arrival', () => {
  const original = move('A:2','a','b'); const fork = { ...original, parent:'root' };
  const dependent: TreeOp = { ...move('A:3','a','root'), clock:3, dependencies:[original.id] };
  const before = projectTree([a,b,original,dependent]); assert.equal(before.parents.a,'root');
  const expected = projectTree([a,b,original,fork,dependent]);
  assert.deepEqual(expected.quarantined,['A:2','A:3']); assert.equal(expected.parents.a,'root');
  for (const delivery of permutations([original,fork,dependent])) assert.deepEqual(projectTree(joinOperations([a,b],delivery)), expected);
  assert.deepEqual(projectTree([original]).pending,['A:2']);
  const missingParent = projectTree([a,{...move('C:2','a','missing'),dependencies:[a.id]}]);
  assert.deepEqual(missingParent.suppressed,['C:2:missing-parent']); assert.equal(missingParent.parents.a,'root');
});

test('R01 HotStuff requires all three certified phases; commits prevent conflicting higher-view prepare quorum', () => {
  const model = new HotStuffModel(committee);
  model.addBlock({id:'x',parent:'genesis',epoch:1,nextEpoch:null}); model.addBlock({id:'y',parent:'genesis',epoch:1,nextEpoch:null});
  assert.equal(model.vote('1','commit','x',model.genesis),null);
  const commit = certify(model,'x'); assert.equal(model.decide(commit),'x');
  model.advanceView(2);
  model.byzantineVote('0',2,'prepare','y');
  assert.equal(model.vote('1','prepare','y',model.genesis),null); assert.equal(model.vote('2','prepare','y',model.genesis),null);
  assert(model.vote('3','prepare','y',model.genesis)); assert.equal(model.qc(2,'prepare','y'),null);
});

test('R01 partitions stop quorum progress and view recovery extends highest certified branch', () => {
  const model = new HotStuffModel(committee); model.addBlock({id:'x',parent:'genesis',epoch:1,nextEpoch:null});
  model.vote('0','prepare','x',model.genesis); model.vote('1','prepare','x',model.genesis);
  assert.equal(model.qc(1,'prepare','x'),null); assert.throws(()=>model.newView(['0','1']),/quorum/);
  model.vote('2','prepare','x',model.genesis); const prepare = model.qc(1,'prepare','x')!;
  for (const id of signers) model.vote(id,'precommit','x',prepare);
  const precommit = model.qc(1,'precommit','x')!;
  // Only one honest validator receives the lock message before leader failure.
  model.vote('1','commit','x',precommit); assert.equal(model.qc(1,'commit','x'),null);
  model.advanceView(2); const high = model.newView(['1','2','3']); assert.equal(high.block,'x');
  model.addBlock({id:'x-child',parent:'x',epoch:1,nextEpoch:null});
  const commit = certify(model,'x-child',high,['1','2','3']); assert.equal(model.decide(commit),'x-child'); assert(model.extends(commit.block,'x'));
});

test('R01 quorum intersection covers n=4 and n=7; duplicate/stale/family-monoculture votes fail', () => {
  for (const size of [4,7]) {
    const f = (size-1)/3; const members = Array.from({length:size},(_,i)=>String(i));
    const quorums = subsets(members,2*f+1);
    for (const left of quorums) for (const right of quorums) assert(left.filter(id=>right.includes(id)).length>f);
  }
  const model = new HotStuffModel(committee); model.addBlock({id:'x',parent:'genesis',epoch:1,nextEpoch:null}); const qc = certify(model,'x');
  assert(!validQC({...qc,votes:[qc.votes[0],qc.votes[0],qc.votes[1]]},committee));
  assert(!validQC({...qc,epoch:2},committee)); assert(!validQC({...qc,block:'different-root'},committee)); assert(!validQC({...qc,view:2},committee));
  assert(!validQC(qc,{...committee,members:committee.members.map(m=>({...m,family:'one-family'}))}));
});

test('R01 membership activation binds both committees to one terminal checkpoint and rejects stale epochs', () => {
  const old = new HotStuffModel(committee); const checkpoint: Block = {id:'handoff-root',parent:'genesis',epoch:1,nextEpoch:2}; old.addBlock(checkpoint);
  const committed = certify(old,checkpoint.id); old.decide(committed,['1']);
  const next: Committee = {epoch:2,f:1,members:['a','b','c','d'].map(id=>({id,family:`new:${id}`}))};
  const ready: QC = {epoch:2,view:0,phase:'ready',block:checkpoint.id,votes:['a','b','c'].map(signer=>({signer,epoch:2,view:0,phase:'ready',block:checkpoint.id}))};
  assert(activateMembership(checkpoint,committed,committee,next,ready));
  assert(!activateMembership(checkpoint,committed,committee,next,{...ready,block:'different-checkpoint'}));
  assert(!activateMembership(checkpoint,committed,committee,next,{...ready,votes:ready.votes.slice(0,2)}));
  assert(!activateMembership(checkpoint,{...committed,phase:'prepare'},committee,next,ready));
  assert(!activateMembership(checkpoint,committed,committee,{...next,epoch:3},ready));
  old.advanceView(2); old.addBlock({id:'stale-child',parent:checkpoint.id,epoch:1,nextEpoch:null});
  const high = old.newView(['0','2','3']);
  for (const id of ['0','1','2','3']) assert.equal(old.vote(id,'prepare','stale-child',high),null);
  old.addBlock({id:'stale-sibling',parent:'genesis',epoch:1,nextEpoch:null});
  old.byzantineVote('0',2,'prepare','stale-sibling'); old.vote('3','prepare','stale-sibling',old.genesis);
  assert.equal(old.vote('2','prepare','stale-sibling',old.genesis),null); assert.equal(old.qc(2,'prepare','stale-sibling'),null);
});
