import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { closeSync, cpSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { ResourceBudgetLedger, RESOURCE_BUDGET_PROFILE, type ResourceAmounts, type ResourceBinding, type ResourceBudgetOptions, type ResourceBudgetFault, type ResourceOperation, type ResourceRequest, type ResourceHandle, type ResourceReceipt } from '../../src/tier2/resource-budget.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import type { TaggedValueV1 } from '../../src/fabric/encoding.ts';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { typeName } from '../../src/tier1/ids.ts';

const same = (actual: unknown, expected: unknown): void => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
const amount = (n: number | string): ResourceAmounts => ({ usdMicros: String(n), tokens: String(n), nanoseconds: String(n), memoryBytes: String(n) });
const request = (id: string, operation: ResourceOperation, actor = 'alice'): ResourceRequest => ({ format: 'aether.resource-operation/1', operationId: id, actor, operation });
const binding = (id = 'effect'): ResourceBinding => ({ executionId: 'execution', effectId: id, executionManifest: domainDigest('aether.execution/1', 'fixture'), payloadDigest: domainDigest('aether.effect-payload/1', 'payload'), policyEpoch: '1' });
const output = (receipt: ResourceReceipt, state: ResourceHandle['body']['state']): ResourceHandle => { const found = receipt.handles.find(handle => handle.body.state === state); assert.ok(found); return found; };
function fixture(initial = amount(100), fault?: ResourceBudgetOptions['fault']) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-resource-')), key = generateKeyPairSync('ed25519').privateKey;
  const profile = { format: RESOURCE_BUDGET_PROFILE, ledgerId: 'test-ledger', initialOwner: 'alice', policyEpoch: '1', initial, maxOperations: 100 };
  const keyPath = join(directory, 'issuer.pem'); writeFileSync(keyPath, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const options: ResourceBudgetOptions = { directory: join(directory, 'ledger'), profile, key, authorize: context => context.actor === 'alice' || context.actor === 'bob',
    verifySettlement: evidence => {
      if (evidence.evidence.tag !== 'string' || !/^[a-z0-9-]+$/.test(evidence.evidence.value)) return false;
      try { const stored = JSON.parse(readFileSync(join(directory, `${evidence.evidence.value}.receipt`), 'utf8'));
        return JSON.stringify(stored) === JSON.stringify({ binding: evidence.binding, disposition: evidence.disposition, charge: evidence.charge });
      } catch { return false; }
    }, fault };
  const ledger = new ResourceBudgetLedger(options);
  const witness = (id: string, disposition: 'committed' | 'not_committed', charge: ResourceAmounts, bind = binding()): TaggedValueV1 => {
    // Represents a local test sink/meter's independently stored observation.
    const sorted = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : value;
    const data = { binding: sorted(bind), disposition, charge: sorted(charge) }, path = join(directory, `${id}.receipt`), fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); } finally { closeSync(fd); }
    return { tag: 'string', value: id };
  };
  return { directory, keyPath, profile, options, ledger, witness, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function conserved(ledger: ResourceBudgetLedger) {
  const state = ledger.snapshot('alice');
  for (const key of ['usdMicros', 'tokens', 'nanoseconds', 'memoryBytes'] as const) assert.equal(BigInt(state.available[key]) + BigInt(state.reserved[key]) + BigInt(state.inflight[key]) + BigInt(state.spent[key]), BigInt(state.funded[key]));
  return state;
}
test('signed linear split, transfer and merge preserve all four resource units and invalidate copied inputs', () => {
  const f = fixture(); try {
    const original = f.ledger.genesisHandle('alice'), split = request('split', { kind: 'split', handle: original, parts: [amount(60), amount(40)] });
    const parts = f.ledger.apply(split); same(f.ledger.apply(split), parts);
    assert.throws(() => f.ledger.apply(request('copy', { kind: 'split', handle: original, parts: [amount(50), amount(50)] })), /stale/);
    const transfer = f.ledger.apply(request('transfer', { kind: 'transfer', handle: parts.handles[0], owner: 'bob' }));
    assert.throws(() => f.ledger.apply(request('alice-use-bob', { kind: 'transfer', handle: transfer.handles[0], owner: 'alice' })), /authority/);
    const back = f.ledger.apply(request('back', { kind: 'transfer', handle: transfer.handles[0], owner: 'alice' }, 'bob'));
    const merged = f.ledger.apply(request('merge', { kind: 'merge', handles: [back.handles[0], parts.handles[1]] }));
    same(merged.handles[0].body.amounts, amount(100)); assert.equal(conserved(f.ledger).handles.length, 1);
    assert.throws(() => f.ledger.apply(request('duplicate', { kind: 'merge', handles: [merged.handles[0], merged.handles[0]] })), /duplicated/);
  } finally { f.cleanup(); }
});
test('reserved/start/consume charges each dimension exactly and returns only unused balance', () => {
  const f = fixture(); try {
    const root = f.ledger.genesisHandle('alice'), reserved = output(f.ledger.apply(request('reserve', { kind: 'reserve', handle: root, amounts: amount(80), binding: binding(), start: false })), 'reserved');
    const running = output(f.ledger.apply(request('start', { kind: 'start', handle: reserved })), 'inflight');
    assert.throws(() => f.ledger.apply(request('stale-refund', { kind: 'refund', handle: reserved, evidence: null })), /stale/);
    assert.throws(() => f.ledger.apply(request('timeout', { kind: 'refund', handle: running, evidence: null })), /terminal noncommit/);
    const charge: ResourceAmounts = { usdMicros: '11', tokens: '22', nanoseconds: '33', memoryBytes: '44' };
    const evidence = f.witness('billed', 'committed', charge), settle = request('consume', { kind: 'consume', handle: running, charge, evidence });
    const receipt = f.ledger.apply(settle); same(receipt.charged, charge); same(f.ledger.apply(settle), receipt);
    const state = conserved(new ResourceBudgetLedger(f.options)); same(state.spent, charge); same(state.refunded, { usdMicros: '69', tokens: '58', nanoseconds: '47', memoryBytes: '36' });
    assert.throws(() => f.ledger.apply(request('refund-billed', { kind: 'refund', handle: running, evidence: f.witness('not-billed', 'not_committed', amount(0)) })), /stale/);
    assert.equal(conserved(f.ledger).spent.usdMicros, '11');
  } finally { f.cleanup(); }
});
test('inflight refund requires independently stored terminal noncommit evidence; unknown and timeout claims stay encumbered', () => {
  const f = fixture(); try {
    const running = output(f.ledger.apply(request('reserve-start', { kind: 'reserve', handle: f.ledger.genesisHandle('alice'), amounts: amount(100), binding: binding(), start: true })), 'inflight');
    for (const evidence of [{ tag: 'string', value: 'timeout' }, { tag: 'string', value: 'caller-claims-success' }] as TaggedValueV1[]) assert.throws(() => f.ledger.apply(request(`bad-${evidence.tag === 'string' ? evidence.value : ''}`, { kind: 'refund', handle: running, evidence })), /evidence rejected/);
    same(conserved(f.ledger).inflight, amount(100));
    const evidence = f.witness('terminal', 'not_committed', amount(0)), result = f.ledger.apply(request('terminal-refund', { kind: 'refund', handle: running, evidence }));
    same(result.refunded, amount(100)); same(conserved(f.ledger).spent, amount(0));
    assert.throws(() => f.ledger.apply(request('same-effect-again', { kind: 'reserve', handle: result.handles[0], amounts: amount(1), binding: binding(), start: true })), /already has/);
  } finally { f.cleanup(); }
});
test('unused reservation refunds without dispatch; overcharges and forged settlements cannot free funds', () => {
  const f = fixture(); try {
    const reserve = output(f.ledger.apply(request('reserve', { kind: 'reserve', handle: f.ledger.genesisHandle('alice'), amounts: amount(100), binding: binding(), start: false })), 'reserved');
    const refunded = f.ledger.apply(request('unused', { kind: 'refund', handle: reserve, evidence: null })); same(refunded.refunded, amount(100));
    const running = output(f.ledger.apply(request('again', { kind: 'reserve', handle: refunded.handles[0], amounts: amount(100), binding: binding('second'), start: true })), 'inflight');
    const over = f.witness('over', 'committed', amount(101), binding('second'));
    assert.throws(() => f.ledger.apply(request('overcharge', { kind: 'consume', handle: running, charge: amount(101), evidence: over })), /exceeds reserved/);
    assert.throws(() => f.ledger.apply(request('wrong-amount', { kind: 'consume', handle: running, charge: amount(50), evidence: over })), /evidence rejected/);
    same(conserved(f.ledger).inflight, amount(100));
  } finally { f.cleanup(); }
});
test('exhaustion is durable and retry-bound, without consuming or inventing units', () => {
  const f = fixture(); try {
    const root = f.ledger.genesisHandle('alice'), req = request('too-large', { kind: 'reserve', handle: root, amounts: { ...amount(50), tokens: '101' }, binding: binding(), start: false });
    const denied = f.ledger.apply(req); assert.equal(denied.status, 'exhausted'); same(denied.handles, []); same(conserved(f.ledger).available, amount(100));
    same(new ResourceBudgetLedger(f.options).apply(req), denied);
    assert.throws(() => f.ledger.apply(request('too-large', { ...req.operation as Extract<ResourceOperation, { kind: 'reserve' }>, amounts: amount(50) })), /retry payload conflict/);
    const accepted = f.ledger.apply(request('smaller-new-intent', { kind: 'reserve', handle: root, amounts: amount(50), binding: binding(), start: false })); assert.equal(accepted.status, 'applied'); conserved(f.ledger);
  } finally { f.cleanup(); }
});
test('amount, owner, signature, epoch, cross-ledger and split-conservation violations fail before debit', () => {
  const f = fixture(), other = fixture(); try {
    const root = f.ledger.genesisHandle('alice'), forged = structuredClone(root); (forged.body as { owner: string }).owner = 'mallory';
    assert.throws(() => f.ledger.apply(request('forged', { kind: 'transfer', handle: forged, owner: 'alice' }, 'mallory')), /forged/);
    assert.throws(() => other.ledger.apply(request('foreign', { kind: 'transfer', handle: root, owner: 'bob' })), /domain/);
    for (const invalid of ['-1', '1.5', '01', String(1n << 128n)]) assert.throws(() => f.ledger.apply(request(`invalid-${invalid}`, { kind: 'reserve', handle: root, amounts: { ...amount(1), usdMicros: invalid }, binding: binding(), start: false })));
    assert.throws(() => f.ledger.apply(request('inflation', { kind: 'split', handle: root, parts: [amount(60), amount(60)] })), /conserve/);
    assert.throws(() => f.ledger.apply(request('zero-part', { kind: 'split', handle: root, parts: [amount(100), amount(0)] })), /empty/);
    assert.throws(() => f.ledger.apply(request('epoch', { kind: 'reserve', handle: root, amounts: amount(1), binding: { ...binding(), policyEpoch: '2' }, start: false })), /epoch/);
    assert.equal(conserved(f.ledger).sequence, 0);
  } finally { f.cleanup(); other.cleanup(); }
});
test('current authority and settlement evidence are rechecked immediately before publication and on retries', () => {
  const f = fixture(); try {
    let allowed = true;
    const ledger = new ResourceBudgetLedger({ ...f.options, authorize: () => allowed, fault: phase => { if (phase === 'before-commit') allowed = false; } });
    const root = ledger.genesisHandle('alice'), req = request('revoked', { kind: 'split', handle: root, parts: [amount(50), amount(50)] });
    assert.throws(() => ledger.apply(req), /revoked/); assert.equal(conserved(f.ledger).sequence, 0);
    allowed = true; const retryLedger = new ResourceBudgetLedger({ ...f.options, authorize: () => allowed }); const receipt = retryLedger.apply(req); allowed = false;
    assert.throws(() => retryLedger.apply(req), /revoked/); assert.equal(conserved(f.ledger).sequence, receipt.sequence);
  } finally { f.cleanup(); }
});
test('committed charge persists across actual Aether heap rewind and fresh ledger instances', () => {
  const f = fixture(); try {
    const symbols = new SymbolSpace('budget-rewind'), state = symbols.define('state'), change = symbols.define('change'), ty = { t: 'Record' as const, name: typeName('type:budget:heap'), fields: [['n', b.Int] as const] };
    const runtime = new Runtime({ registry: new CapabilityRegistry() }).load(b.fn({ symbol: change, params: [b.param(state, ty)], returns: b.Unit, body: b.block(b.assign(b.place(state, 'n'), b.int(99)), b.ret(b.unit())) }));
    const ref = runtime.allocateRecord(ty, { n: 0n }), checkpoint = runtime.checkpoint(); assert.equal(runtime.call(change, [ref]).ok, true);
    const running = output(f.ledger.apply(request('reserve', { kind: 'reserve', handle: f.ledger.genesisHandle('alice'), amounts: amount(100), binding: binding(), start: true })), 'inflight');
    const evidence = f.witness('charged', 'committed', amount(30)); f.ledger.apply(request('charge', { kind: 'consume', handle: running, charge: amount(30), evidence }));
    runtime.restore(checkpoint); assert.equal(runtime.inspect().heap[`@${ref.addr}`].n, '0'); same(conserved(new ResourceBudgetLedger(f.options)).spent, amount(30));
  } finally { f.cleanup(); }
});

function childScript(f: ReturnType<typeof fixture>, phase: ResourceBudgetFault | null, requestPath: string | null): string {
  return `import { readFileSync } from 'node:fs';
    const {ResourceBudgetLedger} = await import(${JSON.stringify(pathToFileURL(resolve('src/tier2/resource-budget.ts')).href)});
    const ledger = new ResourceBudgetLedger({ directory:${JSON.stringify(f.options.directory)}, profile:${JSON.stringify(f.profile)}, key:readFileSync(${JSON.stringify(f.keyPath)},'utf8'), authorize:()=>true, verifySettlement:()=>true,
      fault:(phase)=>{ if(phase===${JSON.stringify(phase)}) process.kill(process.pid,'SIGKILL'); }});
    try { const result = ${requestPath ? `ledger.apply(JSON.parse(readFileSync(${JSON.stringify(requestPath)},'utf8')))` : 'ledger.snapshot("alice")'}; process.stdout.write(JSON.stringify({ok:true,result})); }
    catch(error) {process.stdout.write(JSON.stringify({ok:false,message:error.message}));}`;
}
test('actual process deaths at each initialization publication recover without minting another genesis', () => {
  for (const phase of ['after-genesis', 'after-initial-journal', 'after-initialization-seal'] as const) {
    const f = fixture(); try {
      rmSync(f.options.directory, { recursive: true, force: true });
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childScript(f, phase, null)], { encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', child.stderr); const state = conserved(new ResourceBudgetLedger(f.options)); assert.equal(state.handles.length, 1); assert.equal(state.sequence, 0); same(state.available, amount(100));
    } finally { f.cleanup(); }
  }
});
test('actual SIGKILL at every mutation publication boundary recovers old-or-new state and exact retry', () => {
  for (const phase of ['before-write', 'after-file-sync', 'before-commit', 'after-commit', 'after-directory-sync'] as const) {
    const f = fixture(); try {
      const root = f.ledger.genesisHandle('alice'), req = request('one-split', { kind: 'split', handle: root, parts: [amount(60), amount(40)] }), path = join(f.directory, 'request.json'); writeFileSync(path, JSON.stringify(req));
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childScript(f, phase, path)], { encoding: 'utf8' }); assert.equal(child.signal, 'SIGKILL', child.stderr);
      const reopened = new ResourceBudgetLedger(f.options), state = conserved(reopened); assert.equal(state.sequence, phase === 'after-commit' || phase === 'after-directory-sync' ? 1 : 0);
      const receipt = reopened.apply(req); assert.equal(receipt.sequence, 1); assert.equal(conserved(reopened).handles.length, 2); same(reopened.apply(req), receipt);
    } finally { f.cleanup(); }
  }
});
test('sink-committed charge survives a death before receipt acknowledgment; retry never bills twice or refunds', () => {
  for (const phase of ['after-file-sync', 'after-commit'] as const) {
    const f = fixture(); try {
      const running = output(f.ledger.apply(request('reserve', { kind: 'reserve', handle: f.ledger.genesisHandle('alice'), amounts: amount(100), binding: binding(), start: true })), 'inflight');
      const evidence = f.witness('durable-sink', 'committed', amount(70)), req = request('settlement', { kind: 'consume', handle: running, charge: amount(70), evidence }), path = join(f.directory, 'settle.json'); writeFileSync(path, JSON.stringify(req));
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childScript(f, phase, path)], { encoding: 'utf8' }); assert.equal(child.signal, 'SIGKILL', child.stderr);
      const reopened = new ResourceBudgetLedger(f.options), before = conserved(reopened); same(before.spent, amount(phase === 'after-commit' ? 70 : 0));
      if (phase === 'after-file-sync') same(before.inflight, amount(100));
      const receipt = reopened.apply(req); same(receipt.charged, amount(70)); same(reopened.apply(req), receipt); same(conserved(reopened).available, amount(30));
    } finally { f.cleanup(); }
  }
});
async function parallel(f: ReturnType<typeof fixture>, requests: ResourceRequest[]): Promise<{ ok: boolean; result?: ResourceReceipt; message?: string }[]> {
  return Promise.all(requests.map((req, index) => {
    const path = join(f.directory, `parallel-${index}.json`); writeFileSync(path, JSON.stringify(req));
    return new Promise<{ ok: boolean; result?: ResourceReceipt; message?: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childScript(f, null, path)]); let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject);
      child.on('close', code => { try { assert.equal(code, 0, stderr); resolvePromise(JSON.parse(stdout)); } catch (error) { reject(error); } });
    });
  }));
}
test('four real processes contending with copied handles cannot double-spend any resource', async () => {
  const f = fixture(); try {
    const root = f.ledger.genesisHandle('alice');
    const results = await parallel(f, Array.from({ length: 4 }, (_, index) => request(`fork-${index}`, { kind: 'reserve', handle: structuredClone(root), amounts: amount(75), binding: binding(`fork-${index}`), start: true })));
    assert.equal(results.filter(item => item.ok).length, 1); assert.ok(results.filter(item => !item.ok).every(item => /stale/.test(item.message!)));
    const state = conserved(f.ledger); same(state.inflight, amount(75)); same(state.available, amount(25));
  } finally { f.cleanup(); }
});
test('four processes retry one exact intent, while disjoint split reservations remain independently usable', async () => {
  const f = fixture(); try {
    const split = request('split', { kind: 'split', handle: f.ledger.genesisHandle('alice'), parts: [amount(25), amount(25), amount(25), amount(25)] });
    const retries = await parallel(f, Array.from({ length: 4 }, () => split)); assert.ok(retries.every(item => item.ok)); retries.forEach(item => same(item.result, retries[0].result));
    const parts = retries[0].result!.handles;
    const reservations = await parallel(f, parts.map((handle, index) => request(`part-${index}`, { kind: 'reserve', handle, amounts: amount(25), binding: binding(`part-${index}`), start: true })));
    assert.ok(reservations.every(item => item.ok)); assert.equal(conserved(f.ledger).sequence, 5); same(conserved(f.ledger).inflight, amount(100));
  } finally { f.cleanup(); }
});
test('signed journal tampering, established deletion and copied authority directories fail closed', () => {
  const f = fixture(); try {
    f.ledger.apply(request('split', { kind: 'split', handle: f.ledger.genesisHandle('alice'), parts: [amount(60), amount(40)] }));
    const copy = join(f.directory, 'copied-ledger'); cpSync(f.options.directory, copy, { recursive: true }); assert.throws(() => new ResourceBudgetLedger({ ...f.options, directory: copy }), /profile\/key mismatch/);
    const path = join(f.options.directory, 'journal.json'), original = readFileSync(path), journal = JSON.parse(original.toString()); journal.records[0].receipt.handles[0].body.amounts.usdMicros = '999'; writeFileSync(path, JSON.stringify(journal));
    assert.throws(() => f.ledger.snapshot('alice'), /forged/); writeFileSync(path, original);
    unlinkSync(path); assert.throws(() => new ResourceBudgetLedger(f.options), /missing established resource journal/);
  } finally { f.cleanup(); }
});
test('settlement evidence is checked again after journal preparation; disappearance cannot refund or charge', () => {
  const f = fixture(); try {
    const running = output(f.ledger.apply(request('reserve', { kind: 'reserve', handle: f.ledger.genesisHandle('alice'), amounts: amount(100), binding: binding(), start: true })), 'inflight');
    const evidence = f.witness('receipt', 'committed', amount(40));
    const ledger = new ResourceBudgetLedger({ ...f.options, fault: phase => { if (phase === 'before-commit') unlinkSync(join(f.directory, 'receipt.receipt')); } });
    assert.throws(() => ledger.apply(request('settle', { kind: 'consume', handle: running, charge: amount(40), evidence })), /evidence rejected/);
    same(conserved(f.ledger).inflight, amount(100)); same(conserved(f.ledger).spent, amount(0));
  } finally { f.cleanup(); }
});
test('dispatch-start versus unused-reservation cancellation has only one linear winner across processes', async () => {
  const f = fixture(); try {
    const held = output(f.ledger.apply(request('reserve', { kind: 'reserve', handle: f.ledger.genesisHandle('alice'), amounts: amount(100), binding: binding(), start: false })), 'reserved');
    const start = request('start', { kind: 'start', handle: held }), cancel = request('cancel', { kind: 'refund', handle: held, evidence: null });
    const results = await parallel(f, [start, cancel, start, cancel]), winners = results.filter(result => result.ok);
    assert.equal(winners.length, 2); assert.equal(winners[0].result!.operationId, winners[1].result!.operationId);
    const state = conserved(f.ledger); assert.equal(state.sequence, 2); assert.equal(state.reserved.usdMicros, '0');
    same(state.inflight, amount(winners[0].result!.operationId === 'start' ? 100 : 0)); same(state.spent, amount(0));
  } finally { f.cleanup(); }
});
test('large exact values and structured effect identities avoid rounding and delimiter collisions', () => {
  const large = 1n << 100n, f = fixture(amount(String(large))); try {
    const split = f.ledger.apply(request('genesis', { kind: 'split', handle: f.ledger.genesisHandle('alice'), parts: [amount(String(large - 1n)), amount(1)] }));
    same(split.handles[0].body.amounts, amount(String(large - 1n)));
    const first = { ...binding(), executionId: 'x/y', effectId: 'z' }, second = { ...binding(), executionId: 'x', effectId: 'y/z' };
    f.ledger.apply(request('x/y/z', { kind: 'reserve', handle: split.handles[0], amounts: amount(1), binding: first, start: true }));
    f.ledger.apply(request('different-logical-intent', { kind: 'reserve', handle: split.handles[1], amounts: amount(1), binding: second, start: true }));
    same(conserved(f.ledger).inflight, amount(2)); assert.equal(conserved(f.ledger).available.usdMicros, String(large - 2n));
  } finally { f.cleanup(); }
});
