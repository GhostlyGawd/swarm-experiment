import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { decodeCanonical, encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { promotionDigest, type PromotionProposalV1 } from '../../src/fabric/promotion.ts';
import { enrollValidator, quorumBlockDigest, quorumRosterDigest, quorumVoteBody, signQuorumVote, type QuorumCertificateV1, type QuorumRosterV1, type SignedQuorumVoteV1 } from '../../src/fabric/quorum-crypto.ts';
import { QuorumVoteJournal } from '../../src/fabric/quorum-votes.ts';
import { DurableQuorumNode, type DurableQuorumNodeOptions, type SignedLeaderMessageV1, type SignedNewViewV1, type HotStuffBlockV1 } from '../../src/fabric/quorum-node.ts';

const directories: string[] = [];
function temporary() { const directory = mkdtempSync(join(tmpdir(), 'aether-hotstuff-')); directories.push(directory); return directory; }
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
const digest = (value: string) => domainDigest('aether.execution/1', value);
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value)) as T;
function fixture() {
  const directory = temporary(), keys = Array.from({ length: 4 }, () => generateKeyPairSync('ed25519'));
  const roster: QuorumRosterV1 = { format: 'aether.quorum-roster/1', repositoryId: 'repository', membershipEpoch: '2', policyEpoch: '5', faultBound: 1,
    validators: keys.map((key, index) => enrollValidator(`validator-${index}`, index < 2 ? 'family-a' : 'family-b', index % 2 ? 'proof' : 'security', key.publicKey)) };
  let clock = 0n, valid: unknown = true;
  const options = (index: number): DurableQuorumNodeOptions => ({ directory: join(directory, `node-${index}`), roster, validatorId: `validator-${index}`, privateKey: keys[index].privateKey, genesisManifest: digest('genesis'), clockDomain: 'test-monotonic/1', clock: () => clock, initialTimeoutNs: 10n, validateProposal: (() => valid) as (value: PromotionProposalV1) => boolean });
  const nodes = keys.map((_, index) => new DurableQuorumNode(options(index)));
  const proposal = (name = 'candidate', parent = digest('genesis')): PromotionProposalV1 => ({ format: 'aether.promotion/1', repositoryId: 'repository', expectedParent: parent, candidateManifest: digest(name), evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', name), migrationPlanDigest: domainDigest('aether.migration-plan/1', name), effectPlanDigest: domainDigest('aether.effect-plan/1', name), membershipEpoch: '2', policyEpoch: '5', expiresAt: '999999' });
  return { directory, keys, roster, nodes, options, proposal, setClock: (value: bigint) => { clock = value; }, policy: (value: unknown) => { valid = value; } };
}
function collect(f: ReturnType<typeof fixture>, votes: readonly SignedQuorumVoteV1[]): QuorumCertificateV1 | null {
  const journal = new QuorumVoteJournal({ directory: temporary(), roster: f.roster }); votes.forEach(vote => journal.ingest(vote)); return votes.length ? journal.certificateFor(votes[0].body) : null;
}
function prepare(f: ReturnType<typeof fixture>, members = f.nodes, proposal = f.proposal()): SignedLeaderMessageV1 {
  const leader = f.nodes[Number(f.nodes[0].status().leader.split('-').at(-1))];
  members.forEach(node => leader.receiveNewView(node.newView())); return leader.propose(proposal);
}
function complete(f: ReturnType<typeof fixture>, message: SignedLeaderMessageV1, members = f.nodes) {
  const leader = f.nodes[Number(message.signer.split('-').at(-1))], prepared = collect(f, members.map(node => node.receivePrepare(message)))!;
  assert.ok(prepared); const precommit = leader.phaseMessage('precommit', prepared), precommitted = collect(f, members.map(node => node.receivePrecommit(precommit)))!;
  assert.ok(precommitted); const commit = leader.phaseMessage('commit', precommitted), committed = collect(f, members.map(node => node.receiveCommit(commit)))!;
  assert.ok(committed); const decide = leader.phaseMessage('decide', committed);
  return { prepared, precommitted, committed, decide, decisions: members.map(node => node.receiveDecide(decide)) };
}
function signed<T>(body: T, signer: string, key: KeyObject): { body: T; signer: string; signature: string } {
  return { body, signer, signature: sign(null, encodeCanonical({ domain: 'aether.hotstuff-message-signature/1', body, signer }), key).toString('base64') };
}

test('three durable honest phases decide one ordered branch and new-view selects its highest prepare QC', () => {
  const f = fixture(), first = prepare(f), round = complete(f, first);
  assert.ok(round.decisions.every(decision => decision.blocks.length === 1));
  for (const [index, node] of f.nodes.entries()) {
    const state = node.status(); assert.equal(state.view, '2'); assert.equal(state.lockedQC?.id, round.precommitted.id); assert.equal(state.highQC?.id, round.prepared.id);
    const reopened = new DurableQuorumNode(f.options(index)); assert.deepEqual(reopened.status(), state); assert.deepEqual(reopened.receiveDecide(round.decide), round.decisions[index]); assert.equal(reopened.status().decisions.length, 1);
  }
  const next = prepare(f, f.nodes, f.proposal('next', digest('candidate'))); assert.equal(next.body.phase, 'prepare');
  if (next.body.phase !== 'prepare' || first.body.phase !== 'prepare') throw new Error('fixture');
  assert.equal(next.body.highQC?.id, round.prepared.id); assert.equal(next.body.block.parent, first.body.block.id);
  complete(f, next); assert.equal(f.nodes[0].status().decisions.length, 2); assert.equal(f.nodes[0].status().decisions[1].blocks.length, 1);
});

test('a signed block cannot skip the exact candidate manifest of its parent', () => {
  const f = fixture(), parent = f.nodes[0].genesisBlock, proposal = f.proposal('skipped', digest('foreign-parent'));
  const block: HotStuffBlockV1 = { format: 'aether.hotstuff-block/1', parent, proposal,
    id: quorumBlockDigest(quorumRosterDigest(f.roster), parent, promotionDigest(proposal)) };
  assert.throws(() => f.nodes[0].ingestBlocks([block]), /skips or rewrites/);
  assert.equal(f.nodes[0].status().decidedHead, parent);
});

test('restart and a second controller cannot double-vote or skip a locking phase', () => {
  const f = fixture(), message = prepare(f), first = f.nodes[1].receivePrepare(message), other = new DurableQuorumNode(f.options(1));
  assert.deepEqual(other.receivePrepare(message), first); assert.equal(other.status().votes.length, 1);
  if (message.body.phase !== 'prepare') throw new Error('fixture');
  const proposal = f.proposal('conflict'), block = { ...message.body.block, proposal, id: quorumBlockDigest(first.body.roster, message.body.block.parent, promotionDigest(proposal)) };
  const conflicting = signed({ ...message.body, block }, message.signer, f.keys[0].privateKey);
  assert.throws(() => other.receivePrepare(conflicting), /double vote/); assert.throws(() => f.nodes[0].propose(proposal), /equivocation/);
  const prepareQC = collect(f, [first, f.nodes[0].receivePrepare(message), f.nodes[2].receivePrepare(message)])!;
  const fakeCommitQC = collect(f, [0, 1, 2].map(index => signQuorumVote({ ...prepareQC.body, phase: 'precommit' }, `validator-${index}`, f.keys[index].privateKey, f.roster)))!;
  assert.throws(() => other.receiveCommit(f.nodes[0].phaseMessage('commit', fakeCommitQC)), /prior local vote/);
  const precommit = f.nodes[0].phaseMessage('precommit', prepareQC); other.receivePrecommit(precommit);
  assert.equal(new DurableQuorumNode(f.options(1)).status().highQC?.id, prepareQC.id);
  const commit = f.nodes[0].phaseMessage('commit', fakeCommitQC); other.receiveCommit(commit);
  const fourth = f.nodes[3]; fourth.receivePrepare(message); fourth.receivePrecommit(precommit);
  assert.equal(fourth.newView().body.highQC, null, 'late transmission still reports the QC held at view entry');
  assert.ok(new DurableQuorumNode(f.options(0)).outbox().some(item => 'phase' in item.body && item.body.phase === 'commit' && 'qc' in item.body && item.body.qc.id === fakeCommitQC.id));
  assert.equal(new DurableQuorumNode(f.options(1)).status().lockedQC?.id, fakeCommitQC.id);
  f.setClock(10n); other.timeout('1'); assert.equal(other.status().lockedQC?.id, fakeCommitQC.id);
  assert.deepEqual(other.receivePrepare(message), first, 'old envelope retransmits only its already persisted vote');
});

test('withheld votes stop decisions; increasing local timeouts rotate leader without releasing locks', () => {
  const f = fixture(), message = prepare(f), first = f.nodes[0].receivePrepare(message), second = f.nodes[1].receivePrepare(message);
  assert.equal(collect(f, [first, second]), null); assert.equal(f.nodes[0].status().decisions.length, 0);
  assert.throws(() => f.nodes[0].timeout('1'), /not due/); f.setClock(10n); f.nodes.forEach(node => node.timeout('1'));
  assert.equal(f.nodes[0].status().view, '2'); assert.equal(f.nodes[0].status().deadline, '30'); assert.equal(f.nodes[0].status().decidedHead, f.nodes[0].genesisBlock);
  f.setClock(9n); assert.throws(() => f.nodes[0].newView(), /clock moved backwards/); f.setClock(10n);
  const next = prepare(f, f.nodes.slice(0, 3), f.proposal('after-timeout')); const done = complete(f, next, f.nodes.slice(0, 3));
  assert.ok(done.decisions.every(decision => decision.blocks.length === 1)); assert.equal(f.nodes[3].status().decisions.length, 0);
});

test('a delayed validator requires checked ancestry and later decides the missing committed prefix in order', () => {
  const f = fixture(), first = prepare(f, f.nodes.slice(0, 3)); complete(f, first, f.nodes.slice(0, 3));
  f.setClock(10n); f.nodes[3].timeout('1'); const next = prepare(f, f.nodes.slice(0, 3), f.proposal('second', digest('candidate')));
  if (first.body.phase !== 'prepare' || next.body.phase !== 'prepare') throw new Error('fixture');
  const firstBlock = first.body.block;
  assert.throws(() => f.nodes[3].receivePrepare(next), /missing HotStuff ancestry/);
  assert.throws(() => f.nodes[3].ingestBlocks([firstBlock, { ...firstBlock, id: domainDigest('aether.quorum-block/1', 'forged') }]), /corrupt HotStuff block/);
  assert.throws(() => f.nodes[3].receivePrepare(next), /missing HotStuff ancestry/, 'failed batch did not publish a partial ancestry prefix');
  f.nodes[3].ingestBlocks([first.body.block]); const receipt = complete(f, next);
  assert.deepEqual(receipt.decisions[3].blocks.map(block => block.id), [first.body.block.id, next.body.block.id]);
  assert.equal(new DurableQuorumNode(f.options(3)).status().decidedHead, next.body.block.id);
});

test('authenticated new-view reports reject stale context, wrong QC phase and equivocation', () => {
  const f = fixture(), first = prepare(f), round = complete(f, first), leader = f.nodes[1];
  const reports = f.nodes.map(node => node.newView()); reports.forEach(report => leader.receiveNewView(report));
  const stale = { ...reports[0], body: { ...reports[0].body, context: domainDigest('aether.basic-hotstuff/1', 'foreign') } }; // signature cannot be transferred
  assert.throws(() => leader.receiveNewView(stale), /unauthenticated/);
  const wrong = signed({ ...reports[0].body, highQC: round.precommitted }, reports[0].signer, f.keys[0].privateKey);
  assert.throws(() => leader.receiveNewView(wrong), /phase/);
  const equivocation = signed({ ...reports[0].body, highQC: null }, reports[0].signer, f.keys[0].privateKey); leader.receiveNewView(equivocation);
  assert.equal(leader.newViewEquivocations().length, 1);
  const proposal = leader.propose(f.proposal('next', digest('candidate'))); if (proposal.body.phase !== 'prepare') throw new Error('fixture');
  assert.deepEqual(proposal.body.reports.map(report => report.signer), ['validator-1', 'validator-2', 'validator-3']);
  assert.equal(new DurableQuorumNode(f.options(1)).newViewEquivocations().length, 1);
  const duplicate = signed({ ...proposal.body, reports: [reports[1], reports[1], reports[2]] }, 'validator-1', f.keys[1].privateKey);
  assert.throws(() => f.nodes[2].receivePrepare(duplicate), /duplicate/);
  const downgraded = signed({ ...proposal.body, highQC: null }, 'validator-1', f.keys[1].privateKey);
  assert.throws(() => f.nodes[2].receivePrepare(downgraded), /highest new-view/);
});

test('two real controllers racing one validator identity durably publish only one competing vote', async () => {
  const f = fixture(), first = prepare(f); if (first.body.phase !== 'prepare') throw new Error('fixture');
  const proposal = f.proposal('racing-conflict'), block = { ...first.body.block, proposal, id: quorumBlockDigest(quorumVoteBody(f.roster, proposal, '1', 'prepare', first.body.block.parent).roster, first.body.block.parent, promotionDigest(proposal)) };
  const second = signed({ ...first.body, block }, 'validator-0', f.keys[0].privateKey);
  const input = join(f.directory, 'race.json'), worker = join(f.directory, 'race.ts'), { clock: _clock, validateProposal: _policy, ...serializable } = f.options(1);
  writeFileSync(input, encodeCanonical({ options: { ...serializable, privateKey: f.keys[1].privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), initialTimeoutNs: '10' }, messages: [first, second] }));
  const moduleUrl = JSON.stringify(new URL('../../src/fabric/quorum-node.ts', import.meta.url).href), encodingUrl = JSON.stringify(new URL('../../src/fabric/encoding.ts', import.meta.url).href);
  writeFileSync(worker, `import { readFileSync } from 'node:fs'; import { DurableQuorumNode } from ${moduleUrl}; import { decodeCanonical } from ${encodingUrl}; const {options,messages}=decodeCanonical(readFileSync(${JSON.stringify(input)})); const node=new DurableQuorumNode({...options, initialTimeoutNs:10n,clock:()=>0n,validateProposal:()=>true}); try { const vote=node.receivePrepare(messages[Number(process.argv[2])]); process.stdout.write(vote.body.block); } catch(error) { if (!String(error).includes('double vote')) throw error; process.exitCode=2; }`);
  const run = (index: number) => new Promise<{ code: number | null; text: string }>((resolve, reject) => { const child = spawn(process.execPath, ['--experimental-strip-types', worker, String(index)], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', error = ''; child.stdout.on('data', bytes => { output += String(bytes); }); child.stderr.on('data', bytes => { error += String(bytes); }); child.on('error', reject); child.on('close', code => { if (code !== 0 && code !== 2) reject(new Error(error)); else resolve({ code, text: output }); }); });
  const results = await Promise.all([run(0), run(1)]); assert.deepEqual(results.map(result => result.code).sort(), [0, 2]);
  const state = new DurableQuorumNode(f.options(1)).status(); assert.equal(state.votes.length, 1); assert.equal(state.votes[0].body.block, results.find(result => result.code === 0)!.text);
});

test('bounded state refuses exhaustion and rechecks historical phase logic even with a recomputed checksum', () => {
  const f = fixture(), message = prepare(f), node = new DurableQuorumNode({ ...f.options(1), maxEvents: 2 }); node.receivePrepare(message);
  const before = node.status(); assert.throws(() => node.newView(), /capacity/); assert.deepEqual(node.status(), before);
  const file = join(f.directory, 'node-1', 'state.json'), original = readFileSync(file), record = decodeCanonical(original) as { journal: { events: unknown[] }; checksum: string };
  const prepareVote = before.votes[0], commit = signQuorumVote({ ...prepareVote.body, phase: 'commit' }, 'validator-1', f.keys[1].privateKey, f.roster);
  const event = record.journal.events.at(-1) as { output: unknown }; event.output = commit; record.checksum = domainDigest('aether.hotstuff-state/1', record.journal);
  writeFileSync(file, encodeCanonical(record)); assert.throws(() => new DurableQuorumNode(f.options(1)), /persisted honest vote/); writeFileSync(file, original);
});

test('a locked validator rejects a conflicting stale justification even if the leader signs it', () => {
  const f = fixture(), message = prepare(f); const prepared = collect(f, f.nodes.map(node => node.receivePrepare(message)))!;
  const precommit = f.nodes[0].phaseMessage('precommit', prepared), precommitted = collect(f, f.nodes.map(node => node.receivePrecommit(precommit)))!;
  f.nodes[2].receiveCommit(f.nodes[0].phaseMessage('commit', precommitted)); f.setClock(10n); f.nodes.forEach(node => node.timeout('1'));
  // Deliberately fabricate stale authenticated reports with the fixture keys to
  // exercise safeNode independently; this is not a <=f faulty execution model.
  const reports = [0, 1, 3].map(index => signed({ format: 'aether.hotstuff-new-view/1' as const, context: f.nodes[0].context, targetView: '2', highQC: null }, `validator-${index}`, f.keys[index].privateKey));
  const proposal = f.proposal('unsafe'), parent = f.nodes[0].genesisBlock;
  const block: HotStuffBlockV1 = { format: 'aether.hotstuff-block/1', id: quorumBlockDigest(prepared.body.roster, parent, promotionDigest(proposal)), parent, proposal };
  const conflict = signed({ format: 'aether.hotstuff-leader/1' as const, context: f.nodes[0].context, view: '2', phase: 'prepare' as const, block, highQC: null, reports }, 'validator-1', f.keys[1].privateKey);
  const before = f.nodes[2].status(); assert.throws(() => f.nodes[2].receivePrepare(conflict), /safe-node lock/); assert.deepEqual(f.nodes[2].status(), before);
});

test('literal application validity and malformed clock or journal state fail before voting', () => {
  const f = fixture(), message = prepare(f); f.policy(Promise.resolve(true)); assert.throws(() => f.nodes[1].receivePrepare(message), /application rejected/); assert.equal(f.nodes[1].status().votes.length, 0); f.policy(true);
  f.nodes[1].receivePrepare(message); const file = join(f.directory, 'node-1', 'state.json'), bytes = readFileSync(file);
  writeFileSync(file, '{}'); assert.throws(() => new DurableQuorumNode(f.options(1)), /fields/); writeFileSync(file, bytes); unlinkSync(file); assert.throws(() => new DurableQuorumNode(f.options(1)), /missing established/); writeFileSync(file, bytes);
  assert.throws(() => new DurableQuorumNode({ ...f.options(2), directory: temporary(), clock: (() => Promise.resolve(0n)) as unknown as () => bigint }), /monotonic clock/);
});

test('real controller death before/after vote persistence cannot acknowledge an equivocation on restart', () => {
  for (const point of ['before-state-publish', 'after-state-publish']) {
    const f = fixture(), message = prepare(f), directory = f.options(1).directory, input = join(f.directory, 'input.json'), worker = join(f.directory, 'worker.ts');
    const { clock: _clock, validateProposal: _policy, ...serializable } = f.options(1);
    writeFileSync(input, encodeCanonical({ options: { ...serializable, privateKey: f.keys[1].privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), initialTimeoutNs: '10' }, message }));
    const moduleUrl = JSON.stringify(new URL('../../src/fabric/quorum-node.ts', import.meta.url).href), encodingUrl = JSON.stringify(new URL('../../src/fabric/encoding.ts', import.meta.url).href);
    writeFileSync(worker, `import { readFileSync } from 'node:fs'; import { DurableQuorumNode } from ${moduleUrl}; import { decodeCanonical } from ${encodingUrl}; const {options,message}=decodeCanonical(readFileSync(${JSON.stringify(input)})); const node=new DurableQuorumNode({...options, initialTimeoutNs:10n,clock:()=>0n,validateProposal:()=>true,fault:point=>{if(point===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL')}}); node.receivePrepare(message); throw new Error('expected death');`);
    const child = spawnSync(process.execPath, ['--experimental-strip-types', worker], { encoding: 'utf8', timeout: 30000 }); assert.equal(child.signal, 'SIGKILL', child.stderr);
    const reopened = new DurableQuorumNode(f.options(1)); assert.equal(reopened.status().votes.length, point === 'after-state-publish' ? 1 : 0);
    const vote = reopened.receivePrepare(message); assert.equal(reopened.status().votes.length, 1);
    if (message.body.phase !== 'prepare') throw new Error('fixture');
    const proposal = f.proposal('after-crash-conflict'), block = { ...message.body.block, proposal, id: quorumBlockDigest(vote.body.roster, message.body.block.parent, promotionDigest(proposal)) };
    assert.throws(() => new DurableQuorumNode({ ...f.options(1), directory }).receivePrepare(signed({ ...message.body, block }, 'validator-0', f.keys[0].privateKey)), /double vote/);
  }
});
