import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DurableEffectBroker, effectPayloadDigest, effectRequestDigest, type EffectAdapter, type EffectBudget, type EffectRequestV1, type EffectBrokerOptions } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';

const directories: string[] = [];
function temporary(): string { const directory = mkdtempSync(join(tmpdir(), 'aether-effects-')); directories.push(directory); return directory; }
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });
const result: TaggedValueV1 = { tag: 'int', value: '42' };
const payload: TaggedValueV1 = { tag: 'sequence', items: [{ tag: 'string', value: 'cap:clock:read' }] };
function request(effectId = 'effect:1', patch: Partial<EffectRequestV1> = {}): EffectRequestV1 {
  return {
    format: 'aether.effect/1', executionId: 'execution:ledger', effectId, branchId: null,
    executionManifest: domainDigest('aether.execution/1', 'tested-execution'), capabilityGrantRef: 'grant:clock', policyEpoch: '1',
    payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null, deadline: '1000', ...patch,
  };
}
const semantics = { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true };
function adapter(execute: EffectAdapter['execute'] = () => result): EffectAdapter {
  return { id: 'adapter:test/1', semantics, execute, reconcile: () => ({ state: 'unknown' }) };
}
function options(directory = temporary()): EffectBrokerOptions { return { directory, clockDomain: 'test-clock/1', clock: () => 100n, authorize: () => true }; }

test('F04/G2 request IDs and durable receipts survive reopening; identical retries never reexecute', () => {
  const opts = options(); let calls = 0;
  const sink = adapter(() => { calls++; return result; }); const r = request();
  const broker = new DurableEffectBroker(opts);
  const outcome = broker.dispatch(r, sink);
  assert.equal(outcome.state, 'committed'); assert.equal(calls, 1);
  assert.deepEqual(encodeCanonical(broker.dispatch(r, sink)), encodeCanonical(outcome));
  assert.deepEqual(encodeCanonical(new DurableEffectBroker(opts).dispatch(r, sink)), encodeCanonical(outcome));
  assert.equal(calls, 1);
  const events = broker.events(); assert.equal(events.length, 1);
  assert.deepEqual(events[0].transitions.map(t => t.state), ['requested', 'reserved', 'prepared', 'prepared', 'committed']);
  assert.equal(events[0].requestDigest, effectRequestDigest(r));
  assert.equal(events[0].request.capabilityGrantRef, r.capabilityGrantRef);
  assert.equal(events[0].observedAt, '100'); assert.equal(events[0].recordedAt, '100');
});

test('F04/G2 changed payload, manifest, policy, grant, deadline and reservation cannot reuse a live effect ID', () => {
  const broker = new DurableEffectBroker(options()); const sink = adapter(); const r = request(); broker.dispatch(r, sink);
  const other: TaggedValueV1 = { tag: 'null' };
  for (const change of [
    { payload: other, payloadDigest: effectPayloadDigest(other) }, { executionManifest: domainDigest('aether.execution/1', 'different') },
    { policyEpoch: '2' }, { capabilityGrantRef: 'grant:changed' }, { deadline: '1001' }, { budgetReservationId: 'reservation:changed' }, { branchId: 'branch:changed' },
  ]) assert.throws(() => broker.dispatch({ ...r, ...change }, sink), /identity_conflict/);
  assert.throws(() => broker.dispatch({ ...r, payload: other }, sink), /payload digest mismatch/);
  assert.throws(() => broker.dispatch(r, { ...sink, id: 'other-adapter' }), /adapter_conflict/);
});

test('F04/G1 replay consumes exact ordered outcomes, with no live adapter or current-policy callbacks', () => {
  const live = new DurableEffectBroker(options()); let calls = 0; const sink = adapter(() => { calls++; return result; });
  const one = request(); const two = request('effect:2'); const first = live.dispatch(one, sink); const second = live.dispatch(two, sink);
  const replayOptions = { ...options(), mode: 'replay' as const, replayEvents: live.events(), authorize: () => { throw new Error('must not restore live grant'); } };
  const replay = new DurableEffectBroker(replayOptions);
  const forbidden = adapter(() => { throw new Error('live callback must not run'); });
  assert.throws(() => replay.dispatch(two, forbidden), /replay_mismatch/);
  assert.equal(replay.replayRemaining, 2);
  assert.deepEqual(encodeCanonical(replay.dispatch(one, forbidden)), encodeCanonical(first));
  assert.throws(() => replay.assertReplayComplete(), /unconsumed/);
  assert.deepEqual(encodeCanonical(replay.dispatch(two, forbidden)), encodeCanonical(second));
  replay.assertReplayComplete(); assert.equal(calls, 2);
  assert.throws(() => replay.dispatch(two, forbidden), /replay_mismatch/);
  const mismatch = new DurableEffectBroker(replayOptions);
  assert.throws(() => mismatch.dispatch({ ...one, policyEpoch: '2' }, forbidden), /replay_mismatch/);
  assert.throws(() => new DurableEffectBroker({ ...replayOptions, replayEvents: [...live.events()].reverse() }), /effect ordering/);
  assert.throws(() => new DurableEffectBroker({ ...replayOptions, replayEvents: [live.events()[0], live.events()[0]] }), /effect ordering/);
  assert.throws(() => new DurableEffectBroker({ ...replayOptions, replayEvents: [live.events()[1]] }), /effect ordering/);
});

test('F04/G1 shadow and speculative writes buffer branch intents without production adapters or grants', () => {
  for (const mode of ['shadow', 'speculative'] as const) {
    const broker = new DurableEffectBroker({ ...options(), mode, authorize: () => { throw new Error('production credentials forbidden'); } });
    const forbidden = adapter(() => { throw new Error('production write forbidden'); });
    const intent = request('intent:1', { branchId: 'branch:test' });
    assert.deepEqual(broker.dispatch(intent, forbidden), { state: 'rejected', code: 'isolated_intent_buffered' });
    broker.dispatch(intent, forbidden); assert.equal(broker.intents().length, 1);
    assert.equal(broker.events().length, 0);
    assert.throws(() => broker.dispatch({ ...intent, policyEpoch: '2' }, forbidden), /identity_conflict/);
    assert.deepEqual(broker.dispatch(request(), forbidden), { state: 'rejected', code: 'isolated_branch_required' });
    assert.throws(() => broker.reconcile(intent, forbidden), /isolated_reconciliation_forbidden/);
  }
});

test('F04 isolated branch intents require explicit selected-branch admission before live dispatch', () => {
  let calls = 0; const sink = adapter(() => { calls++; return result; });
  const buffered = request('intent:local', { branchId: 'branch:unselected' });
  const broker = new DurableEffectBroker(options());
  assert.deepEqual(broker.dispatch(buffered, sink), { state: 'rejected', code: 'branch_not_admitted' });
  const admitted = new DurableEffectBroker({ ...options(), authorizeBranch: r => r.branchId === 'branch:selected' && r.effectId === 'live:coordinator-1' });
  assert.equal(admitted.dispatch(request('live:coordinator-1', { branchId: 'branch:selected' }), sink).state, 'committed');
  assert.equal(calls, 1);
});

test('F04 denial, stale revocation, deadline and cancellation occur before the irreversible sink', () => {
  let committed = 0, aborted = 0, authorized = true;
  const transaction: EffectAdapter = {
    id: 'adapter:transaction/1', semantics: { ...semantics, transactional: true },
    prepare: () => { authorized = false; return { tag: 'string', value: 'prepared-token' }; },
    commit: () => { committed++; return result; }, abort: () => { aborted++; }, reconcile: () => ({ state: 'unknown' }),
  };
  const denied = new DurableEffectBroker({ ...options(), authorize: () => false });
  assert.deepEqual(denied.dispatch(request(), transaction), { state: 'rejected', code: 'authorization_denied' });
  const revoked = new DurableEffectBroker({ ...options(), authorize: () => authorized });
  assert.deepEqual(revoked.dispatch(request(), transaction), { state: 'rejected', code: 'authorization_denied' });
  assert.equal(committed, 0); assert.equal(aborted, 1);
  const expired = new DurableEffectBroker(options());
  assert.deepEqual(expired.dispatch(request('expired', { deadline: '99' }), adapter(() => { committed++; return result; })), { state: 'rejected', code: 'deadline_exceeded' });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(expired.dispatch(request('cancelled'), adapter(), { signal: controller.signal }), { state: 'aborted', code: 'cancelled' });
});

test('F04 final authorization checks catch revocation during durable dispatch preparation', () => {
  let allowed = true, calls = 0;
  const broker = new DurableEffectBroker({ ...options(), authorize: () => allowed, beforePersist: event => { if (event.dispatchStarted) allowed = false; } });
  assert.deepEqual(broker.dispatch(request(), adapter(() => { calls++; return result; })), { state: 'rejected', code: 'authorization_denied' });
  assert.equal(calls, 0); assert.equal(broker.events()[0].dispatchStarted, false);
});

test('F04 cancellation after the sink acts preserves its committed charge and receipt', () => {
  const controller = new AbortController(); let consumed = 0, released = 0;
  const budgets: EffectBudget = { reserve: () => true, consume: () => { consumed++; }, release: () => { released++; } };
  const broker = new DurableEffectBroker({ ...options(), budgets });
  const outcome = broker.dispatch(request('charged', { budgetReservationId: 'reservation:1' }), adapter(() => { controller.abort(); return result; }), { signal: controller.signal });
  assert.equal(outcome.state, 'committed'); assert.equal(consumed, 1); assert.equal(released, 0);
});

test('F04 budget exhaustion selects refusal; retries and speculative forks cannot repeat charges', () => {
  let available = 1, charged = 0, calls = 0;
  const reserved = new Set<string>(), consumed = new Set<string>();
  const budgets: EffectBudget = {
    reserve: r => { if (reserved.has(r.effectId)) return true; if (!available) return false; available--; reserved.add(r.effectId); return true; },
    consume: r => { if (!consumed.has(r.effectId)) { charged++; consumed.add(r.effectId); } },
    release: r => { if (!consumed.has(r.effectId) && reserved.delete(r.effectId)) available++; },
  };
  const opts = { ...options(), budgets }; const broker = new DurableEffectBroker(opts);
  const sink = adapter(() => { calls++; return result; });
  const one = request('one', { budgetReservationId: 'budget:1' });
  assert.equal(broker.dispatch(one, sink).state, 'committed');
  assert.equal(new DurableEffectBroker(opts).dispatch(one, sink).state, 'committed');
  assert.deepEqual(broker.dispatch(request('two', { budgetReservationId: 'budget:1' }), sink), { state: 'rejected', code: 'budget_exhausted' });
  new DurableEffectBroker({ ...options(), budgets, mode: 'speculative' }).dispatch(request('intent', { branchId: 'branch', budgetReservationId: 'budget:1' }), sink);
  assert.equal(charged, 1); assert.equal(calls, 1); assert.equal(available, 0);
});

test('F04/G3 receipt-store failure after sink success returns indeterminate and reconciles without redispatch', () => {
  const opts = options(); let calls = 0, reconciles = 0;
  const sinkPath = join(opts.directory, 'sink.json');
  const sink: EffectAdapter = {
    ...adapter(() => { calls++; writeFileSync(sinkPath, JSON.stringify(result)); return result; }),
    reconcile: () => { reconciles++; return { state: 'committed', value: JSON.parse(readFileSync(sinkPath, 'utf8')) as TaggedValueV1 }; },
  };
  const broken = new DurableEffectBroker({ ...opts, beforePersist: e => { if (e.state === 'committed' || e.state === 'indeterminate') throw new Error('receipt disk unavailable'); } });
  assert.equal(broken.dispatch(request(), sink).state, 'indeterminate');
  assert.equal(broken.events()[0].state, 'prepared'); assert.equal(broken.events()[0].dispatchStarted, true);
  const reopened = new DurableEffectBroker(opts);
  assert.equal(reopened.dispatch(request(), sink).state, 'indeterminate'); assert.equal(calls, 1);
  assert.equal(reopened.reconcile(request(), sink).state, 'committed'); assert.equal(calls, 1); assert.equal(reconciles, 1);
  assert.equal(new DurableEffectBroker(opts).dispatch(request(), sink).state, 'committed'); assert.equal(calls, 1);
});

test('F04/G3 actual process death after durable sink commit retains an uncertain dispatch until reconciliation', () => {
  const opts = options(); const sinkFile = join(opts.directory, 'committed-sink.json');
  const script = `
    import { DurableEffectBroker } from ${JSON.stringify(new URL('../../src/fabric/effects.ts', import.meta.url).href)};
    import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
    const [directory, sinkFile, serialized] = process.argv.slice(1);
    const broker = new DurableEffectBroker({ directory, clockDomain: 'test-clock/1', clock: () => 100n, authorize: () => true });
    broker.dispatch(JSON.parse(serialized), {
      id: 'adapter:test/1', semantics: { readOnly:false, atomicIdempotency:false, transactional:false, reconciliation:true },
      execute(request) { const fd = openSync(sinkFile, 'wx'); writeFileSync(fd, JSON.stringify({ tag:'int', value:'42' })); fsyncSync(fd); closeSync(fd); process.kill(process.pid, 'SIGKILL'); },
      reconcile() { return { state: 'unknown' }; }
    });
  `;
  const processResult = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, opts.directory, sinkFile, JSON.stringify(request())], { encoding: 'utf8' });
  assert.equal(processResult.signal, 'SIGKILL', processResult.stderr);
  assert.deepEqual(JSON.parse(readFileSync(sinkFile, 'utf8')), result);
  const broker = new DurableEffectBroker(opts); const forbidden = adapter(() => { throw new Error('duplicate sink call'); });
  assert.throws(() => broker.dispatch(request(), forbidden), /broker_busy/);
  broker.recoverDeadWriter();
  assert.equal(broker.dispatch(request(), forbidden).state, 'indeterminate');
  const reconciler: EffectAdapter = { ...forbidden, reconcile: () => ({ state: 'committed', value: JSON.parse(readFileSync(sinkFile, 'utf8')) as TaggedValueV1 }) };
  assert.equal(broker.reconcile(request(), reconciler).state, 'committed');
  assert.equal(new DurableEffectBroker(opts).dispatch(request(), forbidden).state, 'committed');
});

test('F04/G3 unknown non-idempotent effects are never blindly retried or reported as aborted', () => {
  let calls = 0, refunded = 0;
  const sink = adapter(() => { calls++; throw new Error('connection lost after possible sink write'); });
  const opts = { ...options(), budgets: { reserve: () => true, consume: () => {}, release: () => { refunded++; } } };
  const broker = new DurableEffectBroker(opts); const r = request('unknown', { budgetReservationId: 'budget:unknown' });
  assert.equal(broker.dispatch(r, sink).state, 'indeterminate');
  assert.equal(new DurableEffectBroker(opts).dispatch(r, sink).state, 'indeterminate');
  assert.equal(broker.reconcile(r, sink).state, 'indeterminate');
  assert.equal(calls, 1); assert.equal(refunded, 0);
  const confirmedAbsent = { ...sink, reconcile: () => ({ state: 'not_committed' as const }) };
  assert.equal(broker.reconcile(r, confirmedAbsent).state, 'aborted'); assert.equal(refunded, 1);
});

test('F04 live lock owner cannot be taken over; malformed requests and corrupt receipts fail before dispatch', () => {
  const opts = options(); let calls = 0; const sink = adapter(() => { calls++; return result; });
  let checkedLiveOwner = false;
  const broker = new DurableEffectBroker({ ...opts, beforePersist: event => {
    if (event.state === 'requested') {
      assert.throws(() => new DurableEffectBroker(opts).recoverDeadWriter(), /remains alive/);
      assert.throws(() => new DurableEffectBroker(opts).dispatch(request('nested'), sink), /broker_busy/);
      checkedLiveOwner = true;
    }
  } });
  assert.throws(() => broker.dispatch({ ...request(), format: 'aether.effect/2' } as unknown as EffectRequestV1, sink), /version/);
  assert.equal(calls, 0);
  broker.dispatch(request(), sink);
  assert.equal(checkedLiveOwner, true);
  const file = join(opts.directory, 'effects.json'); const journal = JSON.parse(readFileSync(file, 'utf8'));
  journal.records[0].outcome.value = { tag: 'int', value: '43' }; writeFileSync(file, JSON.stringify(journal));
  assert.throws(() => broker.dispatch(request(), sink), /corrupt effect receipt/); assert.equal(calls, 1);
});

test('F04 transactional prepare commits once, and abandoned preparations recover without a sink commit', () => {
  let prepares = 0, commits = 0, aborts = 0, releases = 0;
  const tx: EffectAdapter = {
    id: 'adapter:tx/1', semantics: { ...semantics, transactional: true, atomicIdempotency: true },
    prepare: () => { prepares++; return { tag: 'string', value: 'transaction-token' }; },
    commit: (_r, token) => { assert.deepEqual(encodeCanonical(token), encodeCanonical({ tag: 'string', value: 'transaction-token' })); commits++; return result; },
    abort: () => { aborts++; }, reconcile: () => ({ state: 'unknown' }),
  };
  const success = new DurableEffectBroker(options());
  assert.equal(success.dispatch(request(), tx).state, 'committed'); success.dispatch(request(), tx);
  assert.equal(commits, 1); assert.equal(prepares, 1);
  const opts = { ...options(), budgets: { reserve: () => true, consume: () => {}, release: () => { releases++; } } };
  const r = request('abandoned', { budgetReservationId: 'reserved:tx' });
  const interrupted = new DurableEffectBroker({ ...opts, beforePersist: e => { if (e.dispatchStarted) throw new Error('interrupted before durable dispatch'); } });
  assert.throws(() => interrupted.dispatch(r, tx), /interrupted/);
  assert.equal(interrupted.events()[0].state, 'prepared'); assert.equal(interrupted.events()[0].dispatchStarted, false);
  const recovered = new DurableEffectBroker(opts);
  assert.equal(recovered.reconcile(r, tx).state, 'aborted'); assert.equal(aborts, 1); assert.equal(releases, 1); assert.equal(commits, 1);
});

test('F04 separate recovery authority reconciles a committed charge after original grant revocation', () => {
  const opts = options(); const r = request('revoked-recovery');
  const sink = adapter(() => { throw new Error('sink acknowledgment lost'); });
  new DurableEffectBroker(opts).dispatch(r, sink);
  const recovery = new DurableEffectBroker({ ...opts, authorize: () => false, authorizeReconciliation: () => true });
  const query = { ...sink, reconcile: () => ({ state: 'committed' as const, value: result }) };
  assert.equal(recovery.reconcile(r, query).state, 'committed');
  assert.deepEqual(recovery.dispatch(request('new-revoked-effect'), query), { state: 'rejected', code: 'authorization_denied' });
});

test('F04 concurrent processes share a durable reservation hook without overspending its final unit', async () => {
  const common = temporary(); const first = temporary(); const second = temporary();
  const script = `
    import { DurableEffectBroker } from ${JSON.stringify(new URL('../../src/fabric/effects.ts', import.meta.url).href)};
    import { openSync, closeSync, writeFileSync, fsyncSync, appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [common, directory, serialized] = process.argv.slice(1);
    const budgets = {
      reserve(request) {
        try { const fd = openSync(join(common, 'last-unit.reserved'), 'wx'); writeFileSync(fd, request.effectId); fsyncSync(fd); closeSync(fd); return true; }
        catch (e) { if (e.code === 'EEXIST') return false; throw e; }
      },
      consume(request) { writeFileSync(join(common, request.effectId + '.consumed'), '1', {flag:'wx'}); },
      release() { throw new Error('committed reservation must not refund'); }
    };
    const broker = new DurableEffectBroker({ directory, clockDomain:'test-clock/1', clock:()=>100n, authorize:()=>true, budgets });
    const outcome = broker.dispatch(JSON.parse(serialized), {
      id:'adapter:test/1', semantics:{readOnly:false,atomicIdempotency:false,transactional:false,reconciliation:true},
      execute(request) { appendFileSync(join(common, 'sink-commits'), request.effectId + '\\n'); return {tag:'int',value:'42'}; },
      reconcile() { return {state:'unknown'}; }
    });
    process.stdout.write(JSON.stringify(outcome));
  `;
  const run = (directory: string, id: string): Promise<{ state: string; code?: string }> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, common, directory, JSON.stringify(request(id, { budgetReservationId: 'shared:last-unit' }))]);
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject); child.on('close', code => { if (code !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
  });
  const outcomes = await Promise.all([run(first, 'first'), run(second, 'second')]);
  assert.equal(outcomes.filter(o => o.state === 'committed').length, 1);
  assert.equal(outcomes.filter(o => o.state === 'rejected' && o.code === 'budget_exhausted').length, 1);
  assert.equal(readFileSync(join(common, 'sink-commits'), 'utf8').trim().split('\n').length, 1);
});

test('F04 corrupt dispatch markers, illegal histories and recovery identities cannot cause false abort/refund', () => {
  const opts = options(); let committed = 0, refunded = 0, reconciled = 0;
  const r = request('marker', { budgetReservationId: 'reservation:marker' });
  const budgets = { reserve: () => true, consume: () => {}, release: () => { refunded++; } };
  const sink: EffectAdapter = {
    ...adapter(() => { committed++; throw new Error('lost acknowledgment after commit'); }),
    reconcile: () => { reconciled++; return { state: 'committed', value: result }; },
  };
  const broker = new DurableEffectBroker({ ...opts, budgets });
  assert.equal(broker.dispatch(r, sink).state, 'indeterminate');
  const file = join(opts.directory, 'effects.json'), original = readFileSync(file, 'utf8');
  for (const mutate of [
    (event: any) => { event.dispatchStarted = false; },
    (event: any) => { event.dispatchStarted = false; event.transitions.at(-1).dispatchStarted = false; },
    (event: any) => { event.transitions[0].state = 'prepared'; },
    (event: any) => { event.transitions.splice(1, 1); },
    (event: any) => { event.outcome.recoveryId = 'different-recovery'; },
  ]) {
    const journal = JSON.parse(original); mutate(journal.records[0]); writeFileSync(file, JSON.stringify(journal));
    assert.throws(() => new DurableEffectBroker({ ...opts, budgets }).reconcile(r, sink));
    assert.equal(refunded, 0); assert.equal(reconciled, 0);
  }
  writeFileSync(file, original);
  assert.equal(broker.reconcile(r, sink).state, 'committed');
  assert.equal(committed, 1); assert.equal(refunded, 0); assert.equal(reconciled, 1);
});

test('F04 process crashes at every ticket publication/release boundary recover without incomplete lock owners', () => {
  for (const phase of ['before-ticket-publish', 'after-ticket-publish', 'before-ticket-release', 'after-ticket-release'] as const) {
    const opts = options(); const sinkFile = join(opts.directory, 'sink-count');
    const script = `
      import { DurableEffectBroker } from ${JSON.stringify(new URL('../../src/fabric/effects.ts', import.meta.url).href)};
      import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
      const [directory, sinkFile, phase, serialized] = process.argv.slice(1);
      const broker = new DurableEffectBroker({ directory, clockDomain:'test-clock/1', clock:()=>100n, authorize:()=>true,
        lockFault: point => { if (point === phase) process.kill(process.pid, 'SIGKILL'); } });
      broker.dispatch(JSON.parse(serialized), {
        id:'adapter:test/1', semantics:{readOnly:false,atomicIdempotency:false,transactional:false,reconciliation:true},
        execute() { const fd=openSync(sinkFile,'wx'); writeFileSync(fd,'1'); fsyncSync(fd); closeSync(fd); return {tag:'int',value:'42'}; },
        reconcile() { return {state:'unknown'}; }
      });
    `;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, opts.directory, sinkFile, phase, JSON.stringify(request())], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const ticketFiles = readdirSync(join(opts.directory, 'effect-lock-tickets')).filter(name => name.startsWith('ticket-'));
    assert.equal(ticketFiles.length, phase === 'before-ticket-publish' ? 0 : 1);
    for (const file of ticketFiles) assert.equal(JSON.parse(readFileSync(join(opts.directory, 'effect-lock-tickets', file), 'utf8')).pid, child.pid);
    const reopened = new DurableEffectBroker(opts);
    reopened.recoverDeadWriter();
    let calls = 0;
    assert.equal(reopened.dispatch(request(), adapter(() => { calls++; return result; })).state, 'committed');
    assert.equal(calls, phase === 'before-ticket-release' || phase === 'after-ticket-release' ? 0 : 1);
    assert.equal(existsSync(sinkFile), phase === 'before-ticket-release' || phase === 'after-ticket-release');
    assert.equal(existsSync(join(opts.directory, 'effects.lock.recovery')), false);
  }
});

test('F04 recovery process crashes cannot orphan a recovery mutex or release a later writer ticket', () => {
  for (const phase of ['before-dead-ticket-release', 'after-dead-ticket-release'] as const) {
    const opts = options();
    const script = `
      import { DurableEffectBroker } from ${JSON.stringify(new URL('../../src/fabric/effects.ts', import.meta.url).href)};
      const [directory, mode, phase, serialized] = process.argv.slice(1);
      const broker = new DurableEffectBroker({ directory, clockDomain:'test-clock/1', clock:()=>100n, authorize:()=>true,
        lockFault: point => { if (point === phase) process.kill(process.pid, 'SIGKILL'); } });
      if (mode === 'recover') broker.recoverDeadWriter();
      else broker.dispatch(JSON.parse(serialized), {id:'adapter:test/1',semantics:{readOnly:false,atomicIdempotency:false,transactional:false,reconciliation:true},execute:()=>({tag:'int',value:'42'}),reconcile:()=>({state:'unknown'})});
    `;
    const run = (mode: string, crashPhase: string) => spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, opts.directory, mode, crashPhase, JSON.stringify(request())], { encoding: 'utf8' });
    assert.equal(run('dispatch', 'after-ticket-publish').signal, 'SIGKILL');
    const recovery = run('recover', phase); assert.equal(recovery.signal, 'SIGKILL', recovery.stderr);
    const reopened = new DurableEffectBroker(opts); reopened.recoverDeadWriter();
    let calls = 0;
    const live = new DurableEffectBroker({ ...opts, beforePersist: event => {
      if (event.state === 'requested') assert.throws(() => reopened.recoverDeadWriter(), /remains alive/);
    } });
    assert.equal(live.dispatch(request(), adapter(() => { calls++; return result; })).state, 'committed');
    assert.equal(calls, 1);
    assert.equal(existsSync(join(opts.directory, 'effects.lock.recovery')), false);
  }
});

test('F04 retained ticket quotas and legacy lock layouts fail explicitly instead of recycling identities', () => {
  const opts = options(); const broker = new DurableEffectBroker({ ...opts, maxLockTickets: 1 });
  assert.equal(broker.dispatch(request(), adapter()).state, 'committed');
  assert.throws(() => broker.dispatch(request('second'), adapter()), /ticket capacity/);
  assert.equal(broker.events().length, 1);
  const legacy = options(); writeFileSync(join(legacy.directory, 'effects.lock'), '');
  assert.throws(() => new DurableEffectBroker(legacy), /offline migration/);
});

test('F04 concurrent broker processes serialize one shared journal without overlapping sink entry', async () => {
  const opts = options();
  const script = `
    import { DurableEffectBroker } from ${JSON.stringify(new URL('../../src/fabric/effects.ts', import.meta.url).href)};
    import { openSync, closeSync, unlinkSync, appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [directory, serialized] = process.argv.slice(1);
    const request=JSON.parse(serialized), broker=new DurableEffectBroker({directory,clockDomain:'test-clock/1',clock:()=>100n,authorize:()=>true});
    const adapter={id:'adapter:test/1',semantics:{readOnly:false,atomicIdempotency:false,transactional:false,reconciliation:true},
      execute() {
        const file=join(directory,'active-sink'), fd=openSync(file,'wx');
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40); appendFileSync(join(directory,'sink-entries'),request.effectId+'\\n'); return {tag:'int',value:'42'}; }
        finally {closeSync(fd); unlinkSync(file);}
      },reconcile:()=>({state:'unknown'})};
    for(let attempt=0;attempt<100;attempt++) {
      try { const outcome=broker.dispatch(request,adapter); if(outcome.state!=='committed') throw Error(outcome.state); process.stdout.write('committed'); break; }
      catch(error) { if(!String(error).includes('effect_broker_busy')||attempt===99) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5); }
    }
  `;
  const run = (id: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, opts.directory, JSON.stringify(request(id))]);
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { error += String(chunk); });
    child.on('error', reject); child.on('close', code => code === 0 && output === 'committed' ? resolve() : reject(new Error(error)));
  });
  await Promise.all([run('writer:1'), run('writer:2'), run('writer:3')]);
  const events = new DurableEffectBroker(opts).events();
  assert.equal(events.length, 3); assert.ok(events.every(event => event.state === 'committed'));
  assert.deepEqual(readFileSync(join(opts.directory, 'sink-entries'), 'utf8').trim().split('\n').sort(), ['writer:1', 'writer:2', 'writer:3']);
});
