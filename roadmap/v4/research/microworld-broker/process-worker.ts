/** Independent TCP worker for the living broker fault campaign. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DurableEffectBroker, type EffectAdapter } from '../../../../src/fabric/effects.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';
import type { TaggedValueV1 } from '../../../../src/fabric/encoding.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { Runtime } from '../../../../src/tier3/runtime.ts';
import { BrokerEffectRouter } from '../../../../src/tier3/effects.ts';
import { buildLedgerExample, ACCOUNT, CAP_LEDGER_APPEND } from '../../../../src/examples/ledger.ts';

const [directory, candidate, crash] = process.argv.slice(2);
if (!directory || !['stable', 'attempt'].includes(candidate) || !['crash', 'normal'].includes(crash)) throw new Error('worker arguments');
const sinkDirectory = join(directory, 'sink'); mkdirSync(sinkDirectory, { recursive: true });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const syncDirectory = (path: string): void => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const value: TaggedValueV1 = { tag: 'null' };
const fixture = buildLedgerExample('microworld-process-broker');
const metadata = domainDigest('aether.fixture/1', 'microworld-process-broker');
const manifest: ExecutionManifestV1 = {
  format: 'aether.execution/1', astRoot: new GraphStore().intern(fixture.module), specRoot: metadata,
  dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: metadata,
  target: { abiVersion: 'local/1', profileDigest: metadata, artifactDigest: metadata },
  capabilityPolicyDigest: metadata, evidencePolicyDigest: metadata,
};
const sink: EffectAdapter = {
  id: 'adapter:microworld-process/1', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true },
  execute: effect => {
    const file = join(sinkDirectory, `${sha(JSON.stringify([effect.executionId, effect.effectId]))}.json`);
    if (!existsSync(file)) {
      const fd = openSync(file, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ executionId: effect.executionId, effectId: effect.effectId, value })); fsyncSync(fd); }
      finally { closeSync(fd); }
      syncDirectory(sinkDirectory);
    }
    return value;
  },
  reconcile: effect => {
    const file = join(sinkDirectory, `${sha(JSON.stringify([effect.executionId, effect.effectId]))}.json`);
    if (!existsSync(file)) return { state: 'not_committed' };
    const record = JSON.parse(readFileSync(file, 'utf8')) as { executionId: string; effectId: string; value: TaggedValueV1 };
    if (record.executionId !== effect.executionId || record.effectId !== effect.effectId) throw new Error('sink identity mismatch');
    return { state: 'committed', value: record.value };
  },
};
let broker = createBroker();
function createBroker(): DurableEffectBroker {
  return new DurableEffectBroker({ directory: join(directory, 'broker'), clockDomain: 'microworld-process-clock/1', clock: () => 100n,
    authorize: () => true, authorizeReconciliation: () => true,
    beforePersist: event => {
      if (crash === 'crash' && event.state === 'committed') {
        // The adapter has durably written, but the broker has not recorded its receipt.
        process.kill(process.pid, 'SIGKILL');
      }
    },
  });
}
function invoke(executionId: string, target = broker, adapter = sink): boolean {
  const router = new BrokerEffectRouter({ broker: target, manifest, executionId, policyEpoch: '1', deadline: '1000',
    adapters: new Map([[CAP_LEDGER_APPEND, adapter]]), grant: () => 'grant:microworld-process' });
  const runtime = new Runtime({ registry: fixture.capabilities, effectRouter: router }).load(fixture.module);
  const a = runtime.allocateRecord(ACCOUNT, { id: 'a', balance: 100n });
  const b = runtime.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
  const result = runtime.call(fixture.symbols.transfer, [a, b, 10n]);
  if (!result.ok && result.fault.kind !== 'effect_indeterminate') throw new Error(`effect fault: ${result.fault.kind}`);
  if (result.ok && runtime.readRecord(a).get('balance') !== 90n) throw new Error('Aether state mismatch');
  return result.ok;
}
type Request = { readonly op: 'invoke' | 'reconcile' | 'replay' | 'status'; readonly attempt?: number };
function handle(request: Request): unknown {
  if (!request || !['invoke', 'reconcile', 'replay', 'status'].includes(request.op)) throw new TypeError('invalid command');
  if (request.op === 'invoke') {
    if (!Number.isSafeInteger(request.attempt) || request.attempt! < 0 || request.attempt! > 10) throw new TypeError('attempt');
    const executionId = candidate === 'stable' ? 'microworld-process:send:1' : `microworld-process:send:1:attempt:${request.attempt}`;
    return { ok: invoke(executionId), executionId };
  }
  if (request.op === 'reconcile') {
    broker = createBroker(); broker.recoverDeadWriter(); let recovered = 0;
    for (const event of broker.events()) if (event.outcome?.state === 'indeterminate' || event.outcome === null) {
      broker.reconcile(event.request, sink); recovered++;
    }
    return { recovered };
  }
  if (request.op === 'replay') {
    const events = broker.events();
    const isolated = new DurableEffectBroker({ directory: join(directory, 'replay'), mode: 'replay', replayEvents: events,
      clockDomain: 'microworld-process-clock/1', authorize: () => { throw new Error('live policy in replay'); },
      authorizeReconciliation: () => { throw new Error('live reconciliation in replay'); } });
    const forbidden: EffectAdapter = { ...sink, execute: () => { throw new Error('live sink in replay'); },
      reconcile: () => { throw new Error('live sink reconciliation in replay'); } };
    for (const event of events) {
      if (event.outcome?.state !== 'committed' || !invoke(event.request.executionId, isolated, forbidden)) throw new Error('replay divergence');
    }
    isolated.assertReplayComplete(); return { consumed: events.length };
  }
  return { sinkWrites: readdirSync(sinkDirectory).filter(name => name.endsWith('.json')).length,
    journalEvents: broker.events().length, journal: broker.events().map(event => ({ executionId: event.request.executionId, state: event.outcome?.state ?? null })) };
}
const server = createServer(socket => {
  socket.setEncoding('utf8'); let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 4096) { socket.destroy(); return; }
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const frame = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { socket.write(JSON.stringify({ result: handle(JSON.parse(frame) as Request) }) + '\n'); }
      catch (error) { socket.write(JSON.stringify({ error: String(error) }) + '\n'); }
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('socket address');
  process.stdout.write(JSON.stringify({ ready: address.port, pid: process.pid }) + '\n');
});
