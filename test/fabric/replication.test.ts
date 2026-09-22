import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { DurableReplica, ReplicationHarness, decodeMutation, enrollment, operationId, type MembershipV1, type MutationEnvelopeV1, type MutationPayloadV1, type ReplicaOptions } from '../../src/fabric/replication.ts';

const content = `ast:b3:${'1'.repeat(64)}`;
const insert: MutationPayloadV1 = { format: 'aether.tree-insert/1', parentOccurrence: null, field: 'members', positionId: 'position-1', content };
const replacement: MutationPayloadV1 = { format: 'aether.tree-replace/1', content: `ast:b3:${'2'.repeat(64)}` };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-replication-'));
  const a = generateKeyPairSync('ed25519'), b = generateKeyPairSync('ed25519'), c = generateKeyPairSync('ed25519');
  const keys = { a, b, c };
  const membership: MembershipV1 = { format: 'aether.membership/1', repositoryId: 'repository', membershipEpoch: '1', replicas: Object.entries(keys).map(([id, key]) => enrollment(id, key.publicKey)) };
  const options = (id: 'a' | 'b' | 'c', name: string = id, extras: Partial<ReplicaOptions> = {}): ReplicaOptions => ({ directory: join(directory, name), membership, replicaId: id, privateKey: keys[id].privateKey, ...extras });
  return { directory, keys, membership, options, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function resign(envelope: MutationEnvelopeV1, changes: Partial<MutationEnvelopeV1>, key: KeyObject): Uint8Array {
  const updated = { ...envelope, ...changes };
  const { signature: _signature, ...body } = updated;
  return encodeCanonical({ ...body, signature: sign(null, encodeCanonical({ domain: 'aether.mutation-signature/1', envelope: body }), key).toString('base64') });
}

test('V4-F05: signed durable ingestion is idempotent, keeps occurrence identity distinct, and restores sequence after restart', () => {
  const f = setup();
  try {
    const a = new DurableReplica(f.options('a')), b = new DurableReplica(f.options('b'));
    const first = a.author('occurrence-1', 'insert', insert);
    assert.equal(decodeMutation(first, f.membership).sequence, '1');
    assert.equal(b.ingest(first).disposition, 'accepted');
    assert.equal(b.ingest(first).disposition, 'duplicate');
    const second = a.author('occurrence-2', 'insert', insert);
    assert.equal(b.ingest(second).disposition, 'accepted');
    assert.equal(b.operations().length, 2);
    assert.deepEqual(new Set(b.operations().map(row => row.envelope.occurrenceId)), new Set(['occurrence-1', 'occurrence-2']));
    const moved = a.author('occurrence-1', 'move', { format: 'aether.tree-move/1', parentOccurrence: 'occurrence-2', field: 'children', positionId: 'position-2' });
    b.ingest(moved);
    assert.equal(decodeMutation(moved, f.membership).occurrenceId, 'occurrence-1');
    const reopened = new DurableReplica(f.options('a'));
    const fourth = reopened.author('occurrence-1', 'replace', replacement);
    assert.equal(decodeMutation(fourth, f.membership).sequence, '4');
    b.ingest(fourth);
    assert.equal(new DurableReplica(f.options('b')).candidateDigest(), reopened.candidateDigest());
    const deleted = reopened.author('occurrence-1', 'delete', { format: 'aether.tree-delete/1', tombstoneId: 'tombstone-1' });
    assert.equal(b.ingest(deleted).disposition, 'accepted');
    const copy = b.operations()[0].envelope as { occurrenceId: string };
    copy.occurrenceId = 'tampered';
    assert.ok(b.operations().every(row => row.envelope.occurrenceId !== 'tampered'));
    assert.throws(() => { (b.membership as { membershipEpoch: string }).membershipEpoch = '2'; });
    assert.throws(() => new DurableReplica(f.options('b', 'b', { privateKey: f.keys.a.privateKey })), /signing key/);
    assert.throws(() => new DurableReplica(f.options('b', 'b', { membership: { ...f.membership, membershipEpoch: '2' } })), /membership changed/);
  } finally { f.cleanup(); }
});

test('V4-F05: missing causal predecessors remain pending and become ready after dependency delivery', () => {
  const f = setup();
  try {
    const a = new DurableReplica(f.options('a')), b = new DurableReplica(f.options('b')), c = new DurableReplica(f.options('c'));
    const first = a.author('root', 'insert', insert);
    b.ingest(first);
    const second = b.author('root', 'replace', replacement);
    assert.equal(c.ingest(second).disposition, 'pending');
    assert.deepEqual(c.missingPredecessors(), [{ replicaId: 'a', sequence: '1' }]);
    assert.equal(c.operations().filter(row => row.disposition === 'accepted').length, 0);
    c.ingest(first);
    assert.equal(c.operations().filter(row => row.disposition === 'accepted').length, 2);
    assert.deepEqual(c.missingPredecessors(), []);
    const third = a.author('root', 'replace', replacement);
    const late = new DurableReplica(f.options('c', 'late'));
    assert.equal(late.ingest(third).disposition, 'pending');
    assert.deepEqual(late.missingPredecessors(), [{ replicaId: 'a', sequence: '1' }]);
  } finally { f.cleanup(); }
});

test('V4-F05: validly signed operation-ID equivocation and descendants are quarantined in every arrival order', () => {
  const f = setup();
  try {
    const a = new DurableReplica(f.options('a'));
    const original = a.author('root', 'insert', insert);
    const envelope = decodeMutation(original, f.membership);
    const alteredPayload = { ...insert, positionId: 'conflicting-position' };
    const conflicting = resign(envelope, { payload: alteredPayload, payloadDigest: domainDigest('aether.mutation-payload/1', alteredPayload) }, f.keys.a.privateKey);
    const child = a.author('root', 'replace', replacement);
    const streams = [[original, child, conflicting], [conflicting, child, original], [child, original, conflicting], [original, conflicting, child]];
    const results = streams.map((stream, index) => {
      const receiver = new DurableReplica(f.options('b', `arrival-${index}`));
      stream.forEach(frame => receiver.ingest(frame));
      assert.equal(receiver.operations().length, 3);
      assert.ok(receiver.operations().every(row => row.disposition === 'quarantined'));
      assert.equal(new Set(receiver.operations().map(row => row.operationId)).size, 2);
      assert.equal(receiver.ingest(original).disposition, 'duplicate');
      return { candidate: receiver.candidateDigest(), journal: receiver.journalDigest() };
    });
    assert.ok(results.every(result => result.candidate === results[0].candidate && result.journal === results[0].journal));
    assert.equal(operationId(envelope), operationId(decodeMutation(conflicting, f.membership)));
  } finally { f.cleanup(); }
});

test('V4-F05: signatures, hashes, versions, epochs, schema/resource limits and invalid clocks cannot admit operations', () => {
  const f = setup();
  try {
    const a = new DurableReplica(f.options('a')), b = new DurableReplica(f.options('b'));
    const first = a.author('root', 'insert', insert), envelope = decodeMutation(first, f.membership);
    const malformed: Uint8Array[] = [
      encodeCanonical({ ...envelope, occurrenceId: 'unsigned-tamper' }),
      encodeCanonical({ ...envelope, unknown: true }),
      resign(envelope, { repositoryId: 'other-repo' }, f.keys.a.privateKey),
      resign(envelope, { membershipEpoch: '2' }, f.keys.a.privateKey),
      resign(envelope, { replicaId: 'unknown' }, f.keys.a.privateKey),
      resign(envelope, { format: 'aether.mutation/2' as never }, f.keys.a.privateKey),
      resign(envelope, { payload: replacement }, f.keys.a.privateKey),
      resign(envelope, { causalFrontier: [['a', '1']] }, f.keys.a.privateKey),
      resign(envelope, { sequence: '2', causalFrontier: [] }, f.keys.a.privateKey),
      resign(envelope, { sequence: '01' }, f.keys.a.privateKey),
      resign(envelope, { lamport: '0' }, f.keys.a.privateKey),
      Buffer.from('{"format":"aether.mutation/1","format":"aether.mutation/1"}'),
      Buffer.concat([first, Buffer.from(' ')]),
    ];
    for (const frame of malformed) assert.throws(() => b.ingest(frame));
    assert.equal(b.operations().length, 0);
    assert.equal(readdirSync(join(f.directory, 'b', 'operations')).length, 0);
    assert.throws(() => decodeMutation(first, f.membership, { maxFrameBytes: first.length - 1 }));
    assert.throws(() => decodeMutation(first, f.membership, { maxDepth: 2 }));
    assert.throws(() => decodeMutation(first, f.membership, { maxObjects: 3 }));
    const second = a.author('root', 'replace', replacement);
    const invalidClock = resign(decodeMutation(second, f.membership), { lamport: '1' }, f.keys.a.privateKey);
    b.ingest(first);
    assert.equal(b.ingest(invalidClock).disposition, 'quarantined');
    const limited = new DurableReplica(f.options('c', 'limited', { maxStoredOperations: 1 }));
    limited.ingest(first);
    assert.equal(limited.ingest(first).disposition, 'duplicate');
    assert.throws(() => limited.ingest(second), /capacity/);
    assert.equal(limited.operations().length, 1);
    const byteLimited = new DurableReplica(f.options('c', 'byte-limit', { maxJournalBytes: first.length - 1 }));
    assert.throws(() => byteLimited.ingest(first), /byte capacity/);
    assert.equal(byteLimited.operations().length, 0);
  } finally { f.cleanup(); }
});

test('V4-F05: concurrent processes sharing an author journal publish distinct complete sequence records', async () => {
  const f = setup();
  try {
    const keyPath = join(f.directory, 'key.pem'), membershipPath = join(f.directory, 'membership.json');
    writeFileSync(keyPath, f.keys.a.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    writeFileSync(membershipPath, JSON.stringify(f.membership));
    const script = `
      import { readFileSync } from 'node:fs';
      import { DurableReplica } from ${JSON.stringify(new URL('../../src/fabric/replication.ts', import.meta.url).href)};
      const replica = new DurableReplica({ directory: process.env.REPLICA_DIRECTORY,
        membership: JSON.parse(readFileSync(process.env.MEMBERSHIP_PATH, 'utf8')), replicaId: 'a',
        privateKey: readFileSync(process.env.SIGNING_KEY_PATH, 'utf8') });
      replica.author(process.env.OCCURRENCE_ID, 'insert', ${JSON.stringify(insert)});
    `;
    const run = (occurrenceId: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], {
        env: { ...process.env, REPLICA_DIRECTORY: join(f.directory, 'a'), MEMBERSHIP_PATH: membershipPath, SIGNING_KEY_PATH: keyPath, OCCURRENCE_ID: occurrenceId },
      });
      let error = ''; child.stderr.on('data', chunk => { error += String(chunk); });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)));
    });
    await Promise.all([run('first'), run('second'), run('third')]);
    const replica = new DurableReplica(f.options('a'));
    assert.deepEqual(replica.operations().map(row => row.envelope.sequence).sort(), ['1', '2', '3']);
    assert.ok(replica.operations().every(row => row.disposition === 'accepted'));
    assert.deepEqual(new Set(replica.operations().map(row => row.envelope.occurrenceId)), new Set(['first', 'second', 'third']));
  } finally { f.cleanup(); }
});

test('V4-F05: process exit after durable author publication never reuses an operation ID', () => {
  const f = setup();
  try {
    const keyPath = join(f.directory, 'key.pem'), membershipPath = join(f.directory, 'membership.json');
    writeFileSync(keyPath, f.keys.a.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    writeFileSync(membershipPath, JSON.stringify(f.membership));
    const script = `
      import { readFileSync } from 'node:fs';
      import { DurableReplica } from ${JSON.stringify(new URL('../../src/fabric/replication.ts', import.meta.url).href)};
      const replica = new DurableReplica({ directory: process.env.REPLICA_DIRECTORY,
        membership: JSON.parse(readFileSync(process.env.MEMBERSHIP_PATH, 'utf8')),
        replicaId: 'a', privateKey: readFileSync(process.env.SIGNING_KEY_PATH, 'utf8'),
        fault: point => { if (point === 'after-author-publish') process.exit(91); } });
      replica.author('root', 'insert', ${JSON.stringify(insert)});
    `;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], {
      env: { ...process.env, REPLICA_DIRECTORY: join(f.directory, 'a'), MEMBERSHIP_PATH: membershipPath, SIGNING_KEY_PATH: keyPath }, encoding: 'utf8',
    });
    assert.equal(child.status, 91, child.stderr);
    const reopened = new DurableReplica(f.options('a'));
    assert.equal(reopened.operations().length, 1);
    const next = reopened.author('root', 'replace', replacement);
    assert.equal(decodeMutation(next, f.membership).sequence, '2');
  } finally { f.cleanup(); }
});

test('V4-F05: ingestion failures distinguish unpublished bytes from durable commit recovered after process exit', () => {
  const f = setup();
  try {
    const a = new DurableReplica(f.options('a')), frame = a.author('root', 'insert', insert);
    const before = new DurableReplica(f.options('b', 'before', { fault: point => { if (point === 'before-persist') throw new Error('injected'); } }));
    assert.throws(() => before.ingest(frame), /injected/);
    assert.equal(new DurableReplica(f.options('b', 'before')).operations().length, 0);
    const membershipPath = join(f.directory, 'membership.json'), framePath = join(f.directory, 'frame.json');
    writeFileSync(membershipPath, JSON.stringify(f.membership)); writeFileSync(framePath, frame);
    const script = `
      import { readFileSync } from 'node:fs';
      import { DurableReplica } from ${JSON.stringify(new URL('../../src/fabric/replication.ts', import.meta.url).href)};
      const replica = new DurableReplica({ directory: process.env.REPLICA_DIRECTORY,
        membership: JSON.parse(readFileSync(process.env.MEMBERSHIP_PATH, 'utf8')), replicaId: 'b',
        fault: point => { if (point === 'after-persist') process.exit(92); } });
      replica.ingest(readFileSync(process.env.FRAME_PATH));
    `;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], {
      env: { ...process.env, REPLICA_DIRECTORY: join(f.directory, 'after'), MEMBERSHIP_PATH: membershipPath, FRAME_PATH: framePath }, encoding: 'utf8',
    });
    assert.equal(child.status, 92, child.stderr);
    const recovered = new DurableReplica(f.options('b', 'after'));
    assert.equal(recovered.operations().length, 1);
    assert.equal(recovered.ingest(frame).disposition, 'duplicate');
  } finally { f.cleanup(); }
});

test('V4-F05: deterministic harness exercises reorder, duplicate, drop, partition, missing-peer requests and restart', () => {
  const f = setup();
  try {
    const a = new DurableReplica(f.options('a')), b = new DurableReplica(f.options('b'));
    const first = a.author('root', 'insert', insert), second = a.author('root', 'replace', replacement);
    const network = new ReplicationHarness(['a', 'b', 'c']); network.attach(a); network.attach(b);
    network.send('a', 'b', first); network.send('a', 'b', second); network.duplicate(1);
    assert.equal(network.deliver(1), true); // successor arrives first
    assert.deepEqual(b.missingPredecessors(), [{ replicaId: 'a', sequence: '1' }]);
    network.drop(0); // drop original predecessor
    network.partition('a', 'b');
    assert.equal(network.deliver(0), false);
    assert.equal(network.requestMissing('b'), 0);
    assert.deepEqual(network.report().missingReplicas, ['c']);
    assert.equal(network.report().candidateSetsEqual, false);
    network.partition('a', 'b', false);
    network.deliver(0); // duplicate pending successor
    assert.equal(network.requestMissing('b'), 1);
    network.deliver(0);
    network.restart('b', () => new DurableReplica(f.options('b')));
    const c = new DurableReplica(f.options('c')); network.attach(c);
    network.synchronize('a', 'c');
    while (network.report().queued > 0) network.deliver(network.report().queued - 1);
    const report = network.report();
    assert.equal(report.dropped, 1); assert.equal(report.requested, 1);
    assert.equal(report.failures.length, 0);
    assert.equal(report.candidateSetsEqual, true); assert.equal(report.authenticatedJournalsEqual, true);
    assert.match(report.assumptions, /in-process/);
    assert.ok(report.digests.every(row => row.pending.length === 0 && row.quarantined === 0));
    // A malformed peer frame is recorded as a transport failure, not a root change.
    const rootBefore = b.candidateDigest();
    network.send('a', 'b', Buffer.from('{}')); network.deliver();
    assert.equal(b.candidateDigest(), rootBefore);
    assert.equal(network.report().failures.length, 1);
    assert.deepEqual(readdirSync(join(f.directory, 'b')).sort(), ['admission-tickets', 'authored', 'capacity.json', 'identity.json', 'operations']);
  } finally { f.cleanup(); }
});

test('V4-F05: concurrent count/byte admission and author-ingest races cannot overfill a journal', async () => {
  const f = setup();
  try {
    const first = new DurableReplica(f.options('a')).author('from-a','insert',insert);
    const second = new DurableReplica(f.options('c')).author('from-c','insert',insert);
    const firstPath = join(f.directory,'first.json'), secondPath = join(f.directory,'second.json');
    const membershipPath = join(f.directory,'membership.json'), keyPath = join(f.directory,'key.pem');
    writeFileSync(firstPath,first); writeFileSync(secondPath,second); writeFileSync(membershipPath,JSON.stringify(f.membership));
    writeFileSync(keyPath,f.keys.b.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
    const script = `
      import {readFileSync} from 'node:fs';
      import {DurableReplica} from ${JSON.stringify(new URL('../../src/fabric/replication.ts',import.meta.url).href)};
      const [directory,membershipPath,keyPath,framePath,action,limits] = process.argv.slice(1);
      const replica = new DurableReplica({directory,membership:JSON.parse(readFileSync(membershipPath,'utf8')),replicaId:'b',privateKey:readFileSync(keyPath,'utf8'),...JSON.parse(limits),
        fault:point=>{ if(point==='before-persist'||point==='before-author-publish') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150); }});
      try { if(action==='author') replica.author('local','insert',${JSON.stringify(insert)}); else replica.ingest(readFileSync(framePath)); process.stdout.write('committed'); }
      catch(error) { if(!String(error).includes('capacity')) throw error; process.stdout.write('capacity'); }
    `;
    for (const [name,limit,action] of [
      ['count',{maxStoredOperations:1},'ingest'],
      ['bytes',{maxJournalBytes:Math.max(first.byteLength,second.byteLength)},'ingest'],
      ['mixed',{maxStoredOperations:1},'author'],
    ] as const) {
      const directory = join(f.directory,name);
      const run = (framePath:string,operation:string):Promise<string>=>new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,directory,membershipPath,keyPath,framePath,operation,JSON.stringify(limit)]);
        let output='',error=''; child.stdout.on('data',c=>{output+=String(c);}); child.stderr.on('data',c=>{error+=String(c);});
        child.on('error',reject); child.on('close',code=>code===0?resolve(output):reject(new Error(error)));
      });
      assert.deepEqual((await Promise.all([run(firstPath,action),run(secondPath,'ingest')])).sort(),['capacity','committed']);
      const reopened=new DurableReplica(f.options('b',name,limit));
      assert.equal(reopened.operations().length,1);
      assert.equal(reopened.ingest(reopened.framesFor()[0]).disposition,'duplicate');
    }
    assert.throws(()=>new DurableReplica(f.options('b','count',{maxStoredOperations:2})),/capacity profile changed/);
  } finally {f.cleanup();}
});

test('V4-F05: exact duplicate delivery needs no extra ticket after admission quota exhaustion',()=>{
  const f=setup();
  try {
    const frame=new DurableReplica(f.options('a')).author('one','insert',insert);
    const receiver=new DurableReplica(f.options('b','ticket-limit',{maxAdmissionTickets:1}));
    receiver.ingest(frame); assert.equal(receiver.ingest(frame).disposition,'duplicate');
    assert.equal(new DurableReplica(f.options('b','ticket-limit',{maxAdmissionTickets:1})).ingest(frame).disposition,'duplicate');
  } finally {f.cleanup();}
});
